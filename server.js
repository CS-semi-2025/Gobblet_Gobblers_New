// server.js (Multi-room & Auto-ID generation & Chat & Spectator Queue & Postgame flow)
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.static("public"));

// ----------------- データ管理 -----------------

const rooms = {}; // { roomID: roomState }

function generateRoomId() {
  return Math.random().toString(36).substring(2, 6);
}

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
    chatLog: [],       // chat history (max 50)
    watchQueue: [],    // spectator socket.id queue (FIFO)
    postDecisions: { A: null, B: null } // postgame decisions: null|'continue'|'quit'
  };
}

const SIZE_VAL = { small: 1, medium: 2, large: 3 };

// ----------------- ルール判定 -----------------
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

// ----------------- クライアント送信用整形 -----------------
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

  // prepare watchQueue names (in order) for client convenience
  const watchNames = state.watchQueue.map(sid => {
    try {
      const s = io.sockets.sockets.get(sid);
      if (!s) return null;
      const slot = s.data.playerSlot;
      const name = (s.data && s.data.name) ? s.data.name : (s.playerName ? s.playerName : "観戦者");
      return { id: sid, name };
    } catch (e) {
      return null;
    }
  }).filter(x => x !== null);

  return {
    board: state.board,
    players,
    currentTurn: state.currentTurn,
    winner: state.winner,
    started: state.started,
    watchQueue: watchNames
  };
}

// ----------------- ユーティリティ -----------------
function removeFromWatchQueue(roomState, socketId) {
  const idx = roomState.watchQueue.indexOf(socketId);
  if (idx !== -1) roomState.watchQueue.splice(idx, 1);
}

function promoteNextSpectatorToSlot(roomID, slot) {
  const roomState = rooms[roomID];
  if (!roomState) return null;
  while (roomState.watchQueue.length > 0) {
    const nextId = roomState.watchQueue.shift(); // FIFO
    const sock = io.sockets.sockets.get(nextId);
    if (!sock) continue; // disconnected, skip
    // assign
    const name = sock.data.name || "Spectator";
    roomState.players[slot] = { id: sock.id, name, color: slot === 'A' ? 'blue' : 'orange', pieces: { small:2, medium:2, large:2 } };
    sock.data.playerSlot = slot;
    // notify promoted socket
    sock.emit('assign', { slot });
    // update all
    io.to(roomID).emit('update_state', sanitizeState(roomState));
    console.log(`Promoted ${sock.id} (${name}) to slot ${slot} in room ${roomID}`);
    return sock;
  }
  // no one to promote
  roomState.players[slot] = null;
  roomState.started = false;
  io.to(roomID).emit('update_state', sanitizeState(roomState));
  return null;
}

// reset postDecisions (after game_over)
function resetPostDecisions(roomState) {
  roomState.postDecisions = { A: null, B: null };
}

// ----------------- Socket.IO イベント -----------------
io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // helper to get roomState by socket
  function getRoomState() {
    const rid = socket.data.roomID;
    if (!rid) return null;
    return rooms[rid];
  }

  // Join event
  socket.on("join", (data, ack) => {
    let roomID = (data && data.room) ? String(data.room) : generateRoomId();
    if (!data || !data.room) {
      while (rooms[roomID]) {
        roomID = generateRoomId();
      }
    }

    const name = (data && data.name) ? String(data.name).slice(0,50) : "Guest";

    socket.join(roomID);
    socket.data.roomID = roomID;
    socket.data.name = name;

    if (!rooms[roomID]) {
      rooms[roomID] = createNewGameState();
      console.log(`New room created: ${roomID}`);
    }
    const roomState = rooms[roomID];

    // assign player slot if available
    let assigned = null;
    if (!roomState.players.A) {
      roomState.players.A = { id: socket.id, name, color: "blue", pieces: { small:2, medium:2, large:2 } };
      assigned = "A";
    } else if (!roomState.players.B) {
      roomState.players.B = { id: socket.id, name, color: "orange", pieces: { small:2, medium:2, large:2 } };
      assigned = "B";
    } else {
      assigned = "spectator";
      // push to watchQueue (FIFO)
      // ensure no duplicates
      removeFromWatchQueue(roomState, socket.id);
      roomState.watchQueue.push(socket.id);
    }

    socket.data.playerSlot = assigned;

    // start game if both present and not already started
    if (roomState.players.A && roomState.players.B) {
      if (!roomState.started && !roomState.winner) {
        roomState.currentTurn = "A";
        roomState.started = true;
      }
      // Clean postDecisions when a new player joins mid-postgame
      resetPostDecisions(roomState);
      io.to(roomID).emit("start_game", sanitizeState(roomState));
    } else {
      io.to(roomID).emit("update_state", sanitizeState(roomState));
    }

    // send chat history to this socket
    socket.emit("chat_init", roomState.chatLog);

    if (ack) ack({ ok: true, slot: assigned, roomID });
    console.log(`socket ${socket.id} joined ${roomID} as ${assigned}`);
  });

  // place_piece (same as before)
  socket.on("place_piece", (payload, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    if (slot !== "A" && slot !== "B") return ack && ack({ error: "spectator" });
    if (!roomState.started) return ack && ack({ error: "not_started" });
    if (roomState.winner) return ack && ack({ error: "game_over" });
    if (roomState.currentTurn !== slot) return ack && ack({ error: "not_your_turn" });

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
        // initialize postDecisions for this room (waiting for players' choices)
        roomState.postDecisions = { A: null, B: null };
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

  // chat_message
  socket.on("chat_message", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;

    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B" && roomState.players.B) name = roomState.players.B.name;
    else name = socket.data.name || "観戦者";

    const text = String(data?.text || "").slice(0, 200);
    if (!text) return;

    const msg = { name, text, time: Date.now(), slot };
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();

    io.to(roomID).emit("chat_message", msg);
  });

  // cheer (similar to chat)
  socket.on("cheer", (data) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;

    let name = "観戦者";
    if (slot === "A" && roomState.players.A) name = roomState.players.A.name;
    else if (slot === "B" && roomState.players.B) name = roomState.players.B.name;
    else name = socket.data.name || "観戦者";

    const text = String(data?.text || "").slice(0, 50);
    if (!text) return;

    const msg = { name, text, time: Date.now(), type: "cheer", slot };
    roomState.chatLog.push(msg);
    if (roomState.chatLog.length > 50) roomState.chatLog.shift();

    io.to(roomID).emit("cheer", msg);
  });

  // postgame decision (continue | quit)
  socket.on("postgame_decision", (data, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) {
      if (ack) ack({ error: "no_room" });
      return;
    }
    const roomState = rooms[roomID];
    const slot = socket.data.playerSlot;
    if (slot !== "A" && slot !== "B") {
      if (ack) ack({ error: "not_player" });
      return;
    }
    const action = data && data.action;
    if (action !== "continue" && action !== "quit") {
      if (ack) ack({ error: "invalid_action" });
      return;
    }

    roomState.postDecisions[slot] = action;
    io.to(roomID).emit("postgame_update", { slot, action });

    // Evaluate decisions
    const a = roomState.postDecisions.A;
    const b = roomState.postDecisions.B;

    // If both decided
    if (a && b) {
      // Case both continue => restart immediately
      if (a === "continue" && b === "continue") {
        // reset board and pieces, start new game
        roomState.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
        if (roomState.players.A) roomState.players.A.pieces = { small:2, medium:2, large:2 };
        if (roomState.players.B) roomState.players.B.pieces = { small:2, medium:2, large:2 };
        roomState.currentTurn = "A";
        roomState.winner = null;
        roomState.started = !!(roomState.players.A && roomState.players.B);
        resetPostDecisions(roomState);
        io.to(roomID).emit("start_game", sanitizeState(roomState));
      } else {
        // At least one quit
        // process quits: for each slot that chose quit, remove player and promote next spectator
        const slots = ['A','B'];
        for (const s of slots) {
          if (roomState.postDecisions[s] === 'quit') {
            const pl = roomState.players[s];
            if (pl) {
              const leaverSocketId = pl.id;
              // If the leaver is still connected, notify them and force leave
              const leaverSock = io.sockets.sockets.get(leaverSocketId);
              if (leaverSock) {
                try { leaverSock.emit('force_leave_after_quit'); } catch(e) {}
                leaverSock.data.playerSlot = null;
                // optionally make them leave room
                // leaverSock.leave(roomID);
              }
            }
            // remove player slot and attempt to promote
            roomState.players[s] = null;
          }
        }

        // Now attempt promoting for slots that are null
        for (const s of ['A','B']) {
          if (!roomState.players[s]) {
            promoteNextSpectatorToSlot(roomID, s);
          }
        }

        // After promotion, determine if both players exist to start
        if (roomState.players.A && roomState.players.B) {
          // reset board and pieces
          roomState.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
          if (roomState.players.A) roomState.players.A.pieces = { small:2, medium:2, large:2 };
          if (roomState.players.B) roomState.players.B.pieces = { small:2, medium:2, large:2 };
          roomState.currentTurn = "A";
          roomState.winner = null;
          roomState.started = true;
          resetPostDecisions(roomState);
          io.to(roomID).emit("start_game", sanitizeState(roomState));
        } else {
          // not enough players yet
          roomState.started = false;
          roomState.winner = null;
          resetPostDecisions(roomState);
          io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
      }
    } else {
      // Not both decided: if one quit and the other continue, handle quit now (promote) so continue player doesn't wait unnecessarily
      // If exactly one decided and it is 'quit', process quit immediately.
      const decidedSlots = [];
      if (a) decidedSlots.push({ slot: 'A', action: a });
      if (b) decidedSlots.push({ slot: 'B', action: b });

      if (decidedSlots.length === 1 && decidedSlots[0].action === 'quit') {
        const s = decidedSlots[0].slot;
        // remove that player
        const pl = roomState.players[s];
        if (pl) {
          const leaverSocketId = pl.id;
          const leaverSock = io.sockets.sockets.get(leaverSocketId);
          if (leaverSock) {
            try { leaverSock.emit('force_leave_after_quit'); } catch(e) {}
            leaverSock.data.playerSlot = null;
          }
        }
        roomState.players[s] = null;
        // promote immediately
        promoteNextSpectatorToSlot(roomID, s);
        // if both players present after promotion and the other had chosen continue, start the game
        if (roomState.players.A && roomState.players.B) {
          roomState.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
          if (roomState.players.A) roomState.players.A.pieces = { small:2, medium:2, large:2 };
          if (roomState.players.B) roomState.players.B.pieces = { small:2, medium:2, large:2 };
          roomState.currentTurn = "A";
          roomState.winner = null;
          roomState.started = true;
          resetPostDecisions(roomState);
          io.to(roomID).emit("start_game", sanitizeState(roomState));
        } else {
          roomState.started = false;
          roomState.winner = null;
          resetPostDecisions(roomState);
          io.to(roomID).emit("update_state", sanitizeState(roomState));
        }
      } else {
        // else just wait for the other player's decision
        io.to(roomID).emit("update_state", sanitizeState(roomState));
      }
    }

    if (ack) ack({ ok: true });
  });

  // restart_game (keeps players same, triggered by modal)
  socket.on("restart_game", (data, ack) => {
    const roomID = socket.data.roomID;
    if (!roomID || !rooms[roomID]) return;
    const roomState = rooms[roomID];
    roomState.board = [[[],[],[]],[[],[],[]],[[],[],[]]];
    if (roomState.players.A) roomState.players.A.pieces = { small:2, medium:2, large:2 };
    if (roomState.players.B) roomState.players.B.pieces = { small:2, medium:2, large:2 };
    roomState.currentTurn = "A";
    roomState.winner = null;
    roomState.started = !!(roomState.players.A && roomState.players.B);
    resetPostDecisions(roomState);
    io.to(roomID).emit("start_game", sanitizeState(roomState));
    if (ack) ack({ ok: true });
  });

  // disconnect
  socket.on("disconnect", () => {
    console.log("client disconnected:", socket.id);
    const roomID = socket.data.roomID;
    if (roomID && rooms[roomID]) {
      const roomState = rooms[roomID];
      const slot = socket.data.playerSlot;

      // If socket was in watchQueue, remove it
      removeFromWatchQueue(roomState, socket.id);

      // If socket was A or B, remove and promote
      if (slot === "A" || slot === "B") {
        if (roomState.players[slot] && roomState.players[slot].id === socket.id) {
          roomState.players[slot] = null;
          roomState.started = false;
          // promote next spectator if any
          promoteNextSpectatorToSlot(roomID, slot);
        }
      }

      // if room empty -> delete
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
