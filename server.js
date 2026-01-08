// server.js (Multi-room, Queue System, Post-game Decisions)
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.static("public"));

// ----------------- データ管理 -----------------

// 全部屋の状態を管理するオブジェクト
// rooms[roomID] = { ...state... }
const rooms = {};

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6);
}

// 部屋ごとの初期状態を作る関数
function createNewGameState() {
  return {
    board: [
      [[], [], []],
      [[], [], []],
      [[], [], []]
    ],
    // プレイヤー情報: { id, name, color, pieces, ... }
    players: { A: null, B: null },
    // 観戦者キュー (順番待ちリスト): Array of { id, name }
    spectators: [],
    
    currentTurn: null,
    winner: null,
    started: false,
    chatLog: [],
    
    // 対戦終了後の意思表示管理
    // pendingDecisions: { A: 'rematch'|'leave'|'spectate'|null, B: ... }
    pendingDecisions: { A: null, B: null },
    decisionTimer: null // (オプション: タイムアウト処理用だが今回はシンプルに実装)
  };
}

const SIZE_VAL = { small: 1, medium: 2, large: 3 };

// ----------------- ルール判定関数 -----------------
function canPlaceAt(board, toR, toC, pieceSizeName) {
  const targetStack = board[toR][toC];
  const topPiece = targetStack.at(-1);
  const pieceVal = SIZE_VAL[pieceSizeName];
  if (!topPiece) return true;
  if (pieceVal > SIZE_VAL[topPiece.size]) return true;
  return false;
}

function checkWinner(board) {
  const lines = [
    [[0,0],[0,1],[0,2]], [[1,0],[1,1],[1,2]], [[2,0],[2,1],[2,2]], 
    [[0,0],[1,0],[2,0]], [[0,1],[1,1],[2,1]], [[0,2],[1,2],[2,2]], 
    [[0,0],[1,1],[2,2]], [[0,2],[1,1],[2,0]] 
  ];
  for (const line of lines) {
    const topOwners = line.map(([r,c]) => {
      const stack = board[r][c];
      return stack.length ? stack.at(-1).owner : null; 
    });
    if (topOwners.every(o => o && o === topOwners[0])) {
      return topOwners[0];
    }
  }
  return null;
}

// ----------------- クライアント送信用の整形 -----------------
function sanitizeState(state) {
  const players = {};
  for (const k of ['A','B']) {
    const p = state.players[k];
    if (p) {
      players[k] = {
        slot: k,
        name: p.name,
        color: p.color,
        pieces: { ...p.pieces },
        id: p.id
      };
    } else players[k] = null;
  }
  return {
    board: state.board,
    players,
    currentTurn: state.currentTurn,
    winner: state.winner,
    started: state.started,
    spectatorCount: state.spectators.length,
    // 順番待ちの情報を送る（UI表示用）
    spectatorQueue: state.spectators.map(s => s.name)
  };
}

// ----------------- 対戦終了後の処理ロジック -----------------

// 決定が出揃ったか、あるいは片方がいない状態で解決を実行する関数
function resolveGameDecisions(roomID) {
  const room = rooms[roomID];
  if (!room) return;

  const decisions = room.pendingDecisions;
  const pA = room.players.A;
  const pB = room.players.B;

  // プレイヤーが既に切断している場合は 'leave' 扱いにする
  const choiceA = pA ? (decisions.A || 'leave') : 'leave';
  const choiceB = pB ? (decisions.B || 'leave') : 'leave';

  console.log(`Resolving Room ${roomID}: A=${choiceA}, B=${choiceB}`);

  // 1. 各プレイヤーの処遇を決定
  // Aの処理
  if (choiceA === 'leave') {
    if (pA) {
      io.to(pA.id).emit('redirect_home'); // クライアントへ退出指示
      const socket = io.sockets.sockets.get(pA.id);
      if (socket) {
        socket.leave(roomID);
        socket.data.roomID = null;
        socket.data.playerSlot = null;
      }
    }
    room.players.A = null;
  } else if (choiceA === 'spectate') {
    if (pA) {
      // 観戦キューの末尾へ
      room.spectators.push({ id: pA.id, name: pA.name });
      // スロットからは外す
      const socket = io.sockets.sockets.get(pA.id);
      if (socket) socket.data.playerSlot = 'spectator';
      io.to(pA.id).emit('assign', { slot: 'spectator' });
    }
    room.players.A = null;
  } else if (choiceA === 'rematch') {
    // そのまま維持
  }

  // Bの処理
  if (choiceB === 'leave') {
    if (pB) {
      io.to(pB.id).emit('redirect_home');
      const socket = io.sockets.sockets.get(pB.id);
      if (socket) {
        socket.leave(roomID);
        socket.data.roomID = null;
        socket.data.playerSlot = null;
      }
    }
    room.players.B = null;
  } else if (choiceB === 'spectate') {
    if (pB) {
      room.spectators.push({ id: pB.id, name: pB.name });
      const socket = io.sockets.sockets.get(pB.id);
      if (socket) socket.data.playerSlot = 'spectator';
      io.to(pB.id).emit('assign', { slot: 'spectator' });
    }
    room.players.B = null;
  } else if (choiceB === 'rematch') {
    // そのまま維持
  }

  // 2. 空いた席に観戦者を補充 (Queueの先頭から)
  ['A', 'B'].forEach(slot => {
    if (room.players[slot] === null && room.spectators.length > 0) {
      // 先頭を取り出す
      const nextSpec = room.spectators.shift();
      const socket = io.sockets.sockets.get(nextSpec.id);
      
      if (socket) {
        // プレイヤー情報構築
        room.players[slot] = {
          id: nextSpec.id,
          name: nextSpec.name,
          color: slot === 'A' ? 'blue' : 'orange',
          pieces: { small: 2, medium: 2, large: 2 }
        };
        socket.data.playerSlot = slot;
        io.to(nextSpec.id).emit('assign', { slot: slot });
        // チャットで通知する仕組み
        io.to(roomID).emit('chat_message', {
          name: 'システム', text: `${nextSpec.name} さんがプレイヤー ${slot} となります！`, time: Date.now()
        });
      }
    }
  });

  // 3. ゲーム状態のリセットと再開判定
  room.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
  room.winner = null;
  room.pendingDecisions = { A: null, B: null }; // 決定状態リセット

  // 残っているプレイヤーの駒をリセット (Rematch組のため)
  if (room.players.A) room.players.A.pieces = { small:2, medium:2, large:2 };
  if (room.players.B) room.players.B.pieces = { small:2, medium:2, large:2 };

  // 両者揃っていれば開始、そうでなければ待機
  if (room.players.A && room.players.B) {
    room.currentTurn = 'A'; // 常にAから（あるいはランダムなど）
    room.started = true;
    io.to(roomID).emit('start_game', sanitizeState(room));
    io.to(roomID).emit('chat_message', { name: 'System', text: '新しいゲームを開始します', time: Date.now() });
  } else {
    room.started = false;
    room.currentTurn = null;
    io.to(roomID).emit('update_state', sanitizeState(room));
    io.to(roomID).emit('chat_message', { name: 'System', text: '対戦相手待ちです...', time: Date.now() });
  }
}


// ----------------- Socket.IO イベント処理 -----------------

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // Joinイベント
  socket.on("join", (data, ack) => {
    
    let roomID = (data && data.room) ? String(data.room) : generateRoomId();

    if (!data.room) {
        while (rooms[roomID]) {
            roomID = generateRoomId();
        }
    }

    const name = (data && data.name) ? String(data.name).slice(0,50) : "Guest";

    socket.join(roomID);
    socket.data.roomID = roomID;

    if (!rooms[roomID]) {
      rooms[roomID] = createNewGameState();
      console.log(`New room created: ${roomID}`);
    }
    
    const roomState = rooms[roomID]; 

    // プレイヤー割り当て logic
    let assigned = null;
    if (!roomState.players.A) {
      roomState.players.A = { id: socket.id, name, color: "blue", pieces: { small:2, medium:2, large:2 } };
      assigned = "A";
    } else if (!roomState.players.B) {
      roomState.players.B = { id: socket.id, name, color: "orange", pieces: { small:2, medium:2, large:2 } };
      assigned = "B";
    } else {
      assigned = "spectator";
      // 観戦者リスト(Queue)に追加
      roomState.spectators.push({ id: socket.id, name });
    }

    socket.data.playerSlot = assigned;
    socket.emit("assign", { slot: assigned });

    // ゲーム開始判定
    if (roomState.players.A && roomState.players.B) {
      if (!roomState.started && !roomState.winner) {
          roomState.currentTurn = "A";
          roomState.started = true;
          io.to(roomID).emit("start_game", sanitizeState(roomState));
      } else {
          // 途中参加（観戦）
          io.to(roomID).emit("update_state", sanitizeState(roomState));
      }
    } else {
      io.to(roomID).emit("update_state", sanitizeState(roomState));
    }

    socket.emit("chat_init", roomState.chatLog);
    if (ack) ack({ ok: true, slot: assigned, roomID: roomID });
  });

  // 駒の配置・移動
  socket.on("place_piece", (payload, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    if (slot !== "A" && slot !== "B") return ack({ error: "spectator" });
    if (!roomState.started) return ack({ error: "not_started" });
    if (roomState.winner) return ack({ error: "game_over" });
    if (roomState.currentTurn !== slot) return ack({ error: "not_your_turn" });

    try {
        if (payload.action === "place_from_hand") {
            const { size, to } = payload;
            const player = roomState.players[slot];
            if (player.pieces[size] <= 0) throw new Error("no piece");
            if (!canPlaceAt(roomState.board, to.r, to.c, size)) throw new Error("illegal");
            
            roomState.board[to.r][to.c].push({ owner: slot, size, color: player.color });
            player.pieces[size]--;

        } else if (payload.action === "move_on_board") {
            const { from, to } = payload;
            const srcStack = roomState.board[from.r][from.c];
            if (!srcStack.length) throw new Error("empty");
            const top = srcStack.at(-1);
            if (top.owner !== slot) throw new Error("not yours");
            if (!canPlaceAt(roomState.board, to.r, to.c, top.size)) throw new Error("illegal");

            srcStack.pop();
            roomState.board[to.r][to.c].push(top);
        }

        const winner = checkWinner(roomState.board);
        if (winner) {
            roomState.winner = winner;
            roomState.started = false;
            // 決定管理を初期化
            roomState.pendingDecisions = { A: null, B: null };
            io.to(roomID).emit("game_over", { winner, state: sanitizeState(roomState) });
        } else {
            roomState.currentTurn = (slot === "A") ? "B" : "A";
            io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
        if (ack) ack({ ok: true });

    } catch (e) {
        if (ack) ack({ error: e.message });
    }
  });

  // ★追加: 対戦終了後の意思表示
  socket.on("post_game_decision", (data) => {
    const roomID = socket.data.roomID;
    const slot = socket.data.playerSlot;
    // data.decision = 'rematch' | 'leave' | 'spectate'

    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];

    // 勝敗が決まっていないときは受け付けない
    if (!roomState.winner) return;
    if (slot !== 'A' && slot !== 'B') return;

    // 決定を保存
    roomState.pendingDecisions[slot] = data.decision;
    
    // 相手に通知 (UI更新用: 「相手が選択しました」など)
    socket.broadcast.to(roomID).emit('opponent_decided', { slot });

    // 両方の決定が出揃ったかチェック
    const dA = roomState.pendingDecisions.A;
    const dB = roomState.pendingDecisions.B;

    // もし相手が既にいないなら、その時点で解決に進む
    // あるいは両方値が入ったら解決
    const isAPresent = !!roomState.players.A;
    const isBPresent = !!roomState.players.B;

    // Aがいるのに未決定、またはBがいるのに未決定ならまだ待つ
    if (isAPresent && !dA) return;
    if (isBPresent && !dB) return;

    // 全員決定したので処理実行
    resolveGameDecisions(roomID);
  });

  socket.on("chat_message", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B" && roomState.players.B) name = roomState.players.B.name;
    // 観戦者リストからも名前検索
    if (slot === "spectator") {
        const s = roomState.spectators.find(obj => obj.id === socket.id);
        if (s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 200);
    if (!text) return;

    const msg = { name, text, time: Date.now(), slot };
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();
    io.to(roomID).emit("chat_message", msg);
  });

  socket.on("cheer", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B" && roomState.players.B) name = roomState.players.B.name;
    if (slot === "spectator") {
        const s = roomState.spectators.find(obj => obj.id === socket.id);
        if (s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 50);
    if (!text) return;

    const msg = { name, text, time: Date.now(), type: "cheer", slot };
    io.to(roomID).emit("cheer", msg);
  });

  // 切断処理
  socket.on("disconnect", () => {
    const roomID = socket.data.roomID;
    if (roomID && rooms[roomID]) {
        const roomState = rooms[roomID];
        const slot = socket.data.playerSlot;
        
        if (slot === "A") {
            // ゲーム中なら、切断は「leave」の意思表示とみなす
            if (roomState.winner) {
                roomState.pendingDecisions.A = 'leave';
                // 相手が待っているかもしれないので解決を試みる
                resolveGameDecisions(roomID);
            } else {
                // ゲーム中（勝敗未決）の切断 -> 負けにするか、単にリセットするか
                // ここでは単純にプレイヤー削除
                roomState.players.A = null;
                roomState.started = false;
                io.to(roomID).emit("update_state", sanitizeState(roomState));
            }
        }
        else if (slot === "B") {
            if (roomState.winner) {
                roomState.pendingDecisions.B = 'leave';
                resolveGameDecisions(roomID);
            } else {
                roomState.players.B = null;
                roomState.started = false;
                io.to(roomID).emit("update_state", sanitizeState(roomState));
            }
        }
        else if (slot === "spectator") {
            // 観戦キューから削除
            roomState.spectators = roomState.spectators.filter(s => s.id !== socket.id);
            io.to(roomID).emit("update_state", sanitizeState(roomState));
        }

        // 誰もいなくなったら部屋削除するしくみ
        const socketsInRoom = io.sockets.adapter.rooms.get(roomID);
        if (!socketsInRoom || socketsInRoom.size === 0) {
            delete rooms[roomID];
            console.log(`Room deleted: ${roomID}`);
        }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});