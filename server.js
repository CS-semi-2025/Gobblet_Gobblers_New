// ===== server.js =====
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

app.use(express.static("public"));

//基礎基盤教養基盤
const rooms = {};

function createNewGameState() {
  return {
    board: [[[],[],[]],[[],[],[]],[[],[],[]]],
    players: { A: null, B: null },
    currentTurn: null,
    winner: null,
    started: false,
    watchQueue: [],
    postDecisions: { A: null, B: null }
  };
}

const SIZE_VAL = { small:1, medium:2, large:3 };

/* =========================
   ルール
========================= */

function canPlaceAt(board,r,c,size){
  const top = board[r][c].at(-1);
  return !top || SIZE_VAL[size] > SIZE_VAL[top.size];
}

function checkWinner(board){
  const L=[
    [[0,0],[0,1],[0,2]],[[1,0],[1,1],[1,2]],[[2,0],[2,1],[2,2]],
    [[0,0],[1,0],[2,0]],[[0,1],[1,1],[2,1]],[[0,2],[1,2],[2,2]],
    [[0,0],[1,1],[2,2]],[[0,2],[1,1],[2,0]]
  ];
  for(const line of L){
    const o=line.map(([r,c])=>board[r][c].at(-1)?.owner);
    if(o.every(x=>x&&x===o[0])) return o[0];
  }
  return null;
}

/* =========================
   ユーティリティ
========================= */

function sanitizeState(state){
  const players={};
  for(const s of ['A','B']){
    const p=state.players[s];
    players[s]=p?{slot:s,name:p.name,pieces:{...p.pieces}}:null;
  }
  return {
    board:state.board,
    players,
    currentTurn:state.currentTurn,
    winner:state.winner,
    started:state.started,
    watchQueueLength: state.watchQueue.length
  };
}

function promoteFromQueue(roomState, slot){
  while(roomState.watchQueue.length){
    const id=roomState.watchQueue.shift();
    const s=io.sockets.sockets.get(id);
    if(!s) continue;
    roomState.players[slot]={
      id:s.id,
      name:s.data.name,
      pieces:{small:2,medium:2,large:2}
    };
    s.data.playerSlot=slot;
    s.emit("assign",{slot});
    return true;
  }
  return false;
}

function resetBoard(roomState){
  roomState.board=[[[],[],[]],[[],[],[]],[[],[],[]]];
  for(const s of ['A','B']){
    if(roomState.players[s]){
      roomState.players[s].pieces={small:2,medium:2,large:2};
    }
  }
  roomState.currentTurn="A";
  roomState.winner=null;
  roomState.started=!!(roomState.players.A&&roomState.players.B);
}


  //強制終了するためのやつ（設定モーダル用）


function forceEndGame(roomID, leaverSlot){
  const r = rooms[roomID];
  if(!r) return;

  const otherSlot = leaverSlot === "A" ? "B" : "A";
  const leaver = r.players[leaverSlot];
  const other = r.players[otherSlot];

  if(leaver){
    r.watchQueue.push(leaver.id);
    r.players[leaverSlot] = null;
  }

  if(other){
    // 相手は続行扱いにする
    r.players[leaverSlot] = other;
    r.players[otherSlot] = null;
    r.players[leaverSlot].pieces = {small:2,medium:2,large:2};
  }

  promoteFromQueue(r, otherSlot);

  resetBoard(r);
  io.to(roomID).emit("start_game", sanitizeState(r));
}

//ゲーム評価

function evaluatePostGame(roomID){
  const r = rooms[roomID];
  if(!r) return;

  const {A,B} = r.postDecisions;
  if(!A || !B) return;

  const survivors = [];

  function handle(slot){
    const p = r.players[slot];
    const act = r.postDecisions[slot];
    if(p){
      if(act === "continue"){
        survivors.push(p);
      }else{
        r.watchQueue.push(p.id);
      }
    }
    r.players[slot] = null;
  }

  handle("A");
  handle("B");

  for(const s of ["A","B"]){
    if(survivors.length){
      r.players[s] = survivors.shift();
    }else{
      promoteFromQueue(r, s);
    }
  }

  r.postDecisions = {A:null,B:null};
  resetBoard(r);
  io.to(roomID).emit("start_game", sanitizeState(r));
}



io.on("connection",socket=>{

  socket.on("join",(data,ack)=>{
    const roomID=data.room;
    socket.join(roomID);
    socket.data.roomID=roomID;
    socket.data.name=data.name;

    if(!rooms[roomID]) rooms[roomID]=createNewGameState();
    const r=rooms[roomID];

    let slot="spectator";
    if(!r.players.A) slot="A";
    else if(!r.players.B) slot="B";

    if(slot!=="spectator"){
      r.players[slot]={id:socket.id,name:data.name,pieces:{small:2,medium:2,large:2}};
    }else{
      r.watchQueue.push(socket.id);
    }

    socket.data.playerSlot=slot;

    if(r.players.A && r.players.B){
      r.started=true;
      r.currentTurn="A";
      io.to(roomID).emit("start_game",sanitizeState(r));
    }else{
      io.to(roomID).emit("update_state",sanitizeState(r));
    }

    ack({ok:true,slot});
  });

  socket.on("place_piece",(p,ack)=>{
    const r=rooms[socket.data.roomID];
    const s=socket.data.playerSlot;
    if(!r||!r.started||r.winner||r.currentTurn!==s) return;

    try{
      if(p.action==="place_from_hand"){
        const pl=r.players[s];
        if(pl.pieces[p.size]<=0) throw "";
        if(!canPlaceAt(r.board,p.to.r,p.to.c,p.size)) throw "";
        r.board[p.to.r][p.to.c].push({owner:s,size:p.size});
        pl.pieces[p.size]--;
      }else{
        const top=r.board[p.from.r][p.from.c].pop();
        if(!canPlaceAt(r.board,p.to.r,p.to.c,top.size)) throw "";
        r.board[p.to.r][p.to.c].push(top);
      }

      const w=checkWinner(r.board);
      if(w){
        r.winner=w;
        r.started=false;
        r.postDecisions={A:null,B:null};
        io.to(socket.data.roomID).emit("game_over",{winner:w,state:sanitizeState(r)});
      }else{
        r.currentTurn=s==="A"?"B":"A";
        io.to(socket.data.roomID).emit("update_state",sanitizeState(r));
      }
      ack({ok:true});
    }catch{
      ack({error:"invalid"});
    }
  });

  socket.on("postgame_decision",(d,ack)=>{
    const r=rooms[socket.data.roomID];
    r.postDecisions[socket.data.playerSlot]=d.action;
    io.to(socket.data.roomID).emit("postgame_update",{slot:socket.data.playerSlot,action:d.action});
    evaluatePostGame(socket.data.roomID);
    ack({ok:true});
  });

  socket.on("force_quit",()=>{
    forceEndGame(socket.data.roomID, socket.data.playerSlot);
  });
});

server.listen(3000);
