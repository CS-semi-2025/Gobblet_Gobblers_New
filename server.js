// server.js (Multi-room & Auto-ID generation & Chat supported)
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.static("public"));

// ----------------- データ管理 -----------------

// 全部屋の状態を管理するオブジェクト
// キー: ルームID, 値: その部屋のgameState
const rooms = {}; 

// ランダムなIDを生成する関数 (例: "x9z2")
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
    players: { A: null, B: null },
    currentTurn: null,
    winner: null,
    started: false,
    chatLog: [] // ★追加: 部屋ごとのチャット履歴をここに保存
  };
}

// サイズ定義
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
    [[0,0],[0,1],[0,2]], [[1,0],[1,1],[1,2]], [[2,0],[2,1],[2,2]], // rows
    [[0,0],[1,0],[2,0]], [[0,1],[1,1],[2,1]], [[0,2],[1,2],[2,2]], // cols
    [[0,0],[1,1],[2,2]], [[0,2],[1,1],[2,0]] // diags
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
    started: state.started
  };
}

// ----------------- Socket.IO イベント処理 -----------------

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // Joinイベント
  socket.on("join", (data, ack) => {
    
    // 1. ルームIDの決定
    let roomID = (data && data.room) ? String(data.room) : generateRoomId();

    // 自動生成の場合の重複チェック
    if (!data.room) {
        while (rooms[roomID]) {
            roomID = generateRoomId();
        }
    }

    const name = (data && data.name) ? String(data.name).slice(0,50) : "Guest";

    // 2. 部屋に参加
    socket.join(roomID);
    socket.data.roomID = roomID; // ソケットに部屋IDを記憶

    // 3. 部屋データがなければ新規作成
    if (!rooms[roomID]) {
      rooms[roomID] = createNewGameState();
      console.log(`New room created: ${roomID}`);
    }
    
    const roomState = rooms[roomID]; 

    // 4. プレイヤー割り当て logic
    let assigned = null;
    if (!roomState.players.A) {
      roomState.players.A = { id: socket.id, name, color: "blue", pieces: { small:2, medium:2, large:2 } };
      assigned = "A";
    } else if (!roomState.players.B) {
      roomState.players.B = { id: socket.id, name, color: "orange", pieces: { small:2, medium:2, large:2 } };
      assigned = "B";
    } else {
      assigned = "spectator";
    }

    socket.data.playerSlot = assigned;

    // ★追加
    socket.emit("assign", { slot: assigned });

    // 5. ゲーム開始判定
    if (roomState.players.A && roomState.players.B) {
      if (!roomState.started && !roomState.winner) {
          roomState.currentTurn = "A";
          roomState.started = true;
      }
      io.to(roomID).emit("start_game", sanitizeState(roomState));
    } else {
      io.to(roomID).emit("update_state", sanitizeState(roomState));
    }

    // ★追加: 参加時に過去のチャットログを送信 (このユーザーだけに)
    socket.emit("chat_init", roomState.chatLog);

    // クライアントに結果を返す
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

  // -------------------------------------------------------------
  // ★追加: チャットメッセージ処理
  // -------------------------------------------------------------
  socket.on("chat_message", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    // 送信者名の特定
    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B" && roomState.players.B) name = roomState.players.B.name;

    const text = String(data?.text || "").slice(0, 200); // 200文字制限
    if (!text) return;

    const msg = {
      name,
      text,
      time: Date.now(),
      slot // プレイヤーの色などをクライアント側で使う場合に便利
    };

    // 履歴に追加 (上限50件)
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();

    // 同じ部屋の全員に送信
    io.to(roomID).emit("chat_message", msg);
  });
  // -------------------------------------------------------------
  // ★ここ！ cheer(応援)イベント
  // -------------------------------------------------------------
  socket.on("cheer", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B") name = roomState.players.B.name;

    const text = String(data?.text || "").slice(0, 50);
    if (!text) return;

    const msg = {
      name,
      text,
      time: Date.now(),
      type: "cheer",
      slot
    };

    // ログに残す場合（残したくなかったらコメントアウト）
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();

    io.to(roomID).emit("cheer", msg);
  });
  // 再戦処理
  socket.on("restart_game", (data, ack) => {
      const roomID = socket.data.roomID;
      if (!roomID || !rooms[roomID]) return;
      
      const roomState = rooms[roomID];
      // 状態リセット
      roomState.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
      if(roomState.players.A) roomState.players.A.pieces = { small:2, medium:2, large:2 };
      if(roomState.players.B) roomState.players.B.pieces = { small:2, medium:2, large:2 };
      roomState.currentTurn = "A";
      roomState.winner = null;
      roomState.started = !!(roomState.players.A && roomState.players.B);

      io.to(roomID).emit("start_game", sanitizeState(roomState));
      if(ack) ack({ ok: true });
  });

  // 切断処理
  socket.on("disconnect", () => {
    const roomID = socket.data.roomID;
    if (roomID && rooms[roomID]) {
        const roomState = rooms[roomID];
        const slot = socket.data.playerSlot;
        
        if (slot === "A") roomState.players.A = null;
        if (slot === "B") roomState.players.B = null;
        
        roomState.started = false;

        // 誰もいなくなったら部屋をメモリから削除
        const socketsInRoom = io.sockets.adapter.rooms.get(roomID);
        if (!socketsInRoom || socketsInRoom.size === 0) {
            delete rooms[roomID];
            console.log(`Room deleted: ${roomID}`);
        } else {
            io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});