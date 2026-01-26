// server.js (Handling Player Leave, Auto-Promotion, Board Reset)
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
    players: { Blue: null, Orange: null },
    // 観戦者キュー: { id, name } のリスト。先頭が次のプレイヤー候補
    spectators: [], 
    
    currentTurn: null,
    winner: null,
    started: false,
    chatLog: [],
    
    // 対戦終了後の各プレイヤーの意思決定 ('rematch', 'spectate', 'leave')
    decisions: { Blue: null, Orange: null }
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
  for (const k of ['Blue','Orange']) {
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
    spectatorCount: state.spectators.length
  };
}

// ----------------- プレイヤー離脱・補充・リセットロジック -----------------
function handlePlayerLeave(roomID, socketID) {
    const room = rooms[roomID];
    if (!room) return;

    // 1. 誰が抜けたか特定
    let leftRole = null;
    let leaverName = "プレイヤー";

    if (room.players.Blue && room.players.Blue.id === socketID) {
        leftRole = 'Blue';
        leaverName = room.players.Blue.name;
        room.players.Blue = null;
    } else if (room.players.Orange && room.players.Orange.id === socketID) {
        leftRole = 'Orange';
        leaverName = room.players.Orange.name;
        room.players.Orange = null;
    }

    // 観戦者リストから削除（常に実行）
    room.spectators = room.spectators.filter(u => u.id !== socketID);

    // プレイヤーが抜けた場合のみ、ゲームリセットと補充を行う
    if (leftRole) {
        // 全員に通知
        const systemMsg = `${leaverName}さんが退出しました。ゲームをリセットして次の対戦へ進みます。`;
        io.to(roomID).emit("system_message", { text: systemMsg });

        // 盤面リセット
        room.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
        room.winner = null;
        room.decisions = { Blue: null, Orange: null };
        // ゲーム進行中だった場合は中断
        room.started = false;

        // 2. 空席を観戦者から補充 (Blue, Orange両方チェック)
        ['Blue', 'Orange'].forEach(slot => {
            if (!room.players[slot] && room.spectators.length > 0) {
                // 先頭の人を昇格
                const nextUser = room.spectators.shift();
                room.players[slot] = {
                    id: nextUser.id,
                    name: nextUser.name,
                    color: (slot === 'Blue' ? 'blue' : 'orange'),
                    pieces: { small: 2, medium: 2, large: 2 }
                };
                // 本人に通知
                io.to(nextUser.id).emit("assign", { slot: slot });
                io.to(roomID).emit("system_message", { text: `${nextUser.name}さんが${slot}プレイヤーに着席しました。` });
            }
        });

        // 3. 人数が揃っていれば即再開、揃っていなければ待機状態へ
        if (room.players.Blue && room.players.Orange) {
            // 手駒の完全リセット
            room.players.Blue.pieces = { small: 2, medium: 2, large: 2 };
            room.players.Orange.pieces = { small: 2, medium: 2, large: 2 };
            
            room.currentTurn = Math.random() < 0.5 ? "Blue" : "Orange";
            room.started = true;
            io.to(roomID).emit("start_game", sanitizeState(room));
        } else {
            room.currentTurn = null;
            io.to(roomID).emit("update_state", sanitizeState(room));
        }
    } else {
        // 観戦者が抜けただけなら人数更新のみ
        io.to(roomID).emit("update_state", sanitizeState(room));
    }

    // 部屋が空なら削除
    const socketsInRoom = io.sockets.adapter.rooms.get(roomID);
    if (!socketsInRoom || socketsInRoom.size === 0) {
        delete rooms[roomID];
        console.log(`Room deleted: ${roomID}`);
    }
}

// ----------------- 次のゲームの解決ロジック (通常終了時用) -----------------
function resolveNextGame(roomID) {
    const room = rooms[roomID];
    if (!room) return;

    const pBlue = room.players.Blue;
    const pOrange = room.players.Orange;
    const dBlue = room.decisions.Blue;
    const dOrange = room.decisions.Orange;

    // Blue処理
    if (pBlue) {
        if (dBlue === 'leave') {
            room.players.Blue = null;
        } else if (dBlue === 'spectate') {
            room.spectators.push({ id: pBlue.id, name: pBlue.name });
            room.players.Blue = null;
            io.to(pBlue.id).emit("assign", { slot: "spectator" });
        }
    }

    // Orange処理
    if (pOrange) {
        if (dOrange === 'leave') {
            room.players.Orange = null;
        } else if (dOrange === 'spectate') {
            room.spectators.push({ id: pOrange.id, name: pOrange.name });
            room.players.Orange = null;
            io.to(pOrange.id).emit("assign", { slot: "spectator" });
        }
    }

    // 補充
    ['Blue', 'Orange'].forEach(slot => {
        if (!room.players[slot]) {
            if (room.spectators.length > 0) {
                const nextUser = room.spectators.shift();
                room.players[slot] = {
                    id: nextUser.id,
                    name: nextUser.name,
                    color: (slot === 'Blue' ? 'blue' : 'orange'),
                    pieces: { small:2, medium:2, large:2 }
                };
                io.to(nextUser.id).emit("assign", { slot: slot });
            }
        }
    });

    // リセット＆開始判定
    room.decisions = { Blue: null, Orange: null };
    room.winner = null;
    room.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
    
    if(room.players.Blue) room.players.Blue.pieces = { small:2, medium:2, large:2 };
    if(room.players.Orange) room.players.Orange.pieces = { small:2, medium:2, large:2 };

    if (room.players.Blue && room.players.Orange) {
        room.currentTurn = Math.random() < 0.5 ? "Blue" : "Orange";
        room.started = true;
        io.to(roomID).emit("start_game", sanitizeState(room));
    } else {
        room.started = false;
        room.currentTurn = null;
        io.to(roomID).emit("update_state", sanitizeState(room));
    }
}


// ----------------- Socket.IO イベント処理 -----------------

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

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

    // ★重要: 観戦者キューがいる場合、空席があってもまずはキューに並ばせる (割り込み防止)
    let assigned = null;
    
    const queueExists = roomState.spectators.length > 0;
    
    if (!queueExists && !roomState.players.Blue) {
      roomState.players.Blue = { id: socket.id, name, color: "blue", pieces: { small:2, medium:2, large:2 } };
      assigned = "Blue";
    } else if (!queueExists && !roomState.players.Orange) {
      roomState.players.Orange = { id: socket.id, name, color: "orange", pieces: { small:2, medium:2, large:2 } };
      assigned = "Orange";
    } else {
      assigned = "spectator";
      roomState.spectators.push({ id: socket.id, name });
    }

    socket.data.playerSlot = assigned;
    socket.emit("assign", { slot: assigned });

    if (roomState.players.Blue && roomState.players.Orange) {
      if (!roomState.started && !roomState.winner) {
          roomState.currentTurn = Math.random() < 0.5 ? "Blue" : "Orange";
          roomState.started = true;
          io.to(roomID).emit("start_game", sanitizeState(roomState));
      }
      else {
        socket.emit("start_game", sanitizeState(roomState));
      }
    } else {
      io.to(roomID).emit("update_state", sanitizeState(roomState));
    }

    socket.emit("chat_init", roomState.chatLog);
    if (ack) ack({ ok: true, slot: assigned, roomID: roomID });
  });

  socket.on("place_piece", (payload, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let currentRole = 'spectator';
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) currentRole = 'Blue';
    if (roomState.players.Orange && roomState.players.Orange.id === socket.id) currentRole = 'Orange';

    if (currentRole !== "Blue" && currentRole !== "Orange") return ack({ error: "spectator" });
    if (!roomState.started) return ack({ error: "not_started" });
    if (roomState.winner) return ack({ error: "game_over" });
    if (roomState.currentTurn !== currentRole) return ack({ error: "not_your_turn" });

    try {
        if (payload.action === "place_from_hand") {
            const { size, to } = payload;
            const player = roomState.players[currentRole];
            if (player.pieces[size] <= 0) throw new Error("no piece");
            if (!canPlaceAt(roomState.board, to.r, to.c, size)) throw new Error("illegal");
            
            roomState.board[to.r][to.c].push({ owner: currentRole, size, color: player.color });
            player.pieces[size]--;

        } else if (payload.action === "move_on_board") {
            const { from, to } = payload;
            const srcStack = roomState.board[from.r][from.c];
            if (!srcStack.length) throw new Error("empty");
            const top = srcStack.at(-1);
            if (top.owner !== currentRole) throw new Error("not yours");
            if (!canPlaceAt(roomState.board, to.r, to.c, top.size)) throw new Error("illegal");

            srcStack.pop();
            let winner = checkWinner(roomState.board);
            if (winner) {
                roomState.winner = winner;
                roomState.started = false;
                io.to(roomID).emit("game_over", { winner, state: sanitizeState(roomState) });
                return; 
            }
            roomState.board[to.r][to.c].push(top);
        }

        const winner = checkWinner(roomState.board);
        if (winner) {
            roomState.winner = winner;
            roomState.started = false;
            io.to(roomID).emit("game_over", { winner, state: sanitizeState(roomState) });
        } else {
            roomState.currentTurn = (currentRole === "Blue") ? "Orange" : "Blue";
            io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
        if (ack) ack({ ok: true });

    } catch (e) {
        if (ack) ack({ error: e.message });
    }
  });

  socket.on("chat_message", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    
    let name = "観戦者";
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) name = roomState.players.Blue.name;
    else if (roomState.players.Orange && roomState.players.Orange.id === socket.id) name = roomState.players.Orange.name;
    else {
        const s = roomState.spectators.find(u => u.id === socket.id);
        if(s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 200);
    if (!text) return;

    const msg = { name, text, time: Date.now() };
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();
    io.to(roomID).emit("chat_message", msg);
  });

  socket.on("cheer", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    
    let name = "観戦者";
    if (roomState.players.Blue && roomState.players.Blue.id === socket.id) name = roomState.players.Blue.name;
    else if (roomState.players.Orange && roomState.players.Orange.id === socket.id) name = roomState.players.Orange.name;
     else {
        const s = roomState.spectators.find(u => u.id === socket.id);
        if(s) name = s.name;
    }

    const text = String(data?.text || "").slice(0, 50);
    if (!text) return;
    const msg = { name, text, time: Date.now(), type: "cheer" };
    io.to(roomID).emit("cheer", msg);
  });

  socket.on("submit_decision", (data) => {
      const roomID = socket.data.roomID;
      if (!roomID || !rooms[roomID]) return;
      const room = rooms[roomID];
      if (!room.winner) return;

      const choice = data.choice; 
      let role = null;
      if (room.players.Blue && room.players.Blue.id === socket.id) role = 'Blue';
      else if (room.players.Orange && room.players.Orange.id === socket.id) role = 'Orange';

      if (!role) return;

      room.decisions[role] = choice;

      const otherRole = (role === 'Blue') ? 'Orange' : 'Blue';
      const otherPlayer = room.players[otherRole];

      if (!otherPlayer || room.decisions[otherRole]) {
          resolveNextGame(roomID);
      }
  });

  // --- 退出・切断処理 ---
  socket.on("leave_room", () => {
    const roomID = socket.data.roomID;
    if (roomID) {
        handlePlayerLeave(roomID, socket.id);
        // この後クライアント側でリロードされる
    }
  });

  socket.on("disconnect", () => {
    const roomID = socket.data.roomID;
    if (roomID) {
        handlePlayerLeave(roomID, socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});