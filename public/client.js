const socket = io();

/* ================= UI ================= */

const home = document.getElementById("homeScreen");
const game = document.getElementById("gameScreen");
const result = document.getElementById("resultOverlay");

const joinBtn = document.getElementById("joinBtn");
const nameInput = document.getElementById("nameInput");

const continueBtn = document.getElementById("continueBtn");
const leaveBtn = document.getElementById("leaveBtn");
const spectateBtn = document.getElementById("spectateBtn");
const waitingText = document.getElementById("waitingText");
const resultText = document.getElementById("resultText");

/* ================= 状態管理 ================= */

let myDecision = null;
let decisionLocked = false;

/* ================= Join ================= */

joinBtn.onclick = () => {
  const name = nameInput.value.trim();
  if (!name) return;

  socket.emit("join", name);
  home.classList.add("hidden");
  game.classList.remove("hidden");
};

/* ================= Match Result ================= */

socket.on("matchEnd", ({ resultMessage }) => {
  resultText.textContent = resultMessage;
  result.classList.remove("hidden");

  myDecision = null;
  decisionLocked = false;
  waitingText.classList.add("hidden");

  enableButtons(true);
});

/* ================= Button Actions ================= */

continueBtn.onclick = () => sendDecision("continue");
leaveBtn.onclick = () => sendDecision("leave");
spectateBtn.onclick = () => sendDecision("spectate");

function sendDecision(type) {
  if (decisionLocked) return;

  myDecision = type;
  decisionLocked = true;

  socket.emit("postMatchDecision", type);

  enableButtons(false);
  waitingText.classList.remove("hidden");
}

/* ================= Decision Sync ================= */

socket.on("allDecisionsCollected", () => {
  result.classList.add("hidden");
});

/* ================= Forced Exit (settings etc.) ================= */

socket.on("forceExitMatch", () => {
  result.classList.add("hidden");
  game.classList.add("hidden");
  home.classList.remove("hidden");
});

/* ================= Helpers ================= */

function enableButtons(enabled) {
  continueBtn.disabled = !enabled;
  leaveBtn.disabled = !enabled;
  spectateBtn.disabled = !enabled;
}
