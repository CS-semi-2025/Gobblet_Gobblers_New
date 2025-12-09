// client.js (Three.js version - Multi-room ready)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import confetti from 'canvas-confetti'; // ★追加: 紙吹雪用ライブラリ

// --- Socket.IO 接続 ---
const socket = io();

// --- UI参照 ---
// ホーム画面用
const homeScreen = document.getElementById("homeScreen");
const createRoomBtn = document.getElementById("createRoomBtn");
const roomInput = document.getElementById("roomInput");
const homeNameInput = document.getElementById("homeNameInput");

// ゲーム画面用
const gameScreen = document.getElementById("gameScreen");
const logEl = document.getElementById('log');
const meLabel = document.getElementById('meLabel');
const turnLabel = document.getElementById('turnLabel');
const gameStateLabel = document.getElementById('gameStateLabel');
const currentRoomLabel = document.getElementById('currentRoomLabel');
const gameNameInput = document.getElementById('nameInput');
const boardWrap = document.querySelector('.board-wrap');
const handContainer = document.getElementById('handContainer');

// モーダルUI用の要素
const settingsBtn = document.getElementById('settingsBtn');
const modalOverlay = document.getElementById('modalOverlay');
const closeModalBtn = document.getElementById('closeModalBtn');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const modalRestartBtn = document.getElementById('modalRestartBtn');
const modalLeaveBtn = document.getElementById('modalLeaveBtn');
const toggleHighlightBtn = document.getElementById('toggleHighlightBtn');

// ★ 新規: リザルトUIの要素
const resultOverlay = document.getElementById('resultOverlay');
const resultTitle = document.getElementById('resultTitle');
const resultMessage = document.getElementById('resultMessage');
const resultContent = document.querySelector('.result-content');
const resultRestartBtn = document.getElementById('resultRestartBtn');
const resultCloseBtn = document.getElementById('resultCloseBtn');


// グローバル変数
let mySlot = null;
let myId = null;
let state = null;
let selectedPiece = null; 
let currentRoomID = null; // 現在のルームIDを保持

// 設定値
let config = {
    highlightMoves: true
};

// URLパラメータにroomがあれば自動入力
const params = new URLSearchParams(window.location.search);
if (params.get('room')) {
    roomInput.value = params.get('room');
}

// --- ▼▼▼ 画面遷移・入室ロジック ▼▼▼ ---

createRoomBtn.addEventListener("click", () => {
    const roomVal = roomInput.value.trim();
    const nameVal = homeNameInput.value.trim();

    if (!roomVal || !nameVal) {
        alert("ルーム名とプレイヤー名を入力して下さい");
        return;
    }

    const joinData = {
        room: roomVal, 
        name: nameVal
    };

    socket.emit("join", joinData, (ack) => {
        if (ack && (ack.ok || ack.slot)) {
            // 参加成功
            mySlot = ack.slot;
            currentRoomID = roomVal;
            
            // 画面情報の更新
            currentRoomLabel.textContent = currentRoomID;
            gameNameInput.value = nameVal;
            
            addLog(`ルーム「${currentRoomID}」に参加しました (Role: ${mySlot})`);
            if (mySlot === 'spectator') addLog('観戦モードです');

            // 画面切り替え実行
            toggleScreen(true);

            // URLを更新
            const newUrl = `${window.location.pathname}?room=${encodeURIComponent(currentRoomID)}`;
            window.history.pushState({ path: newUrl }, '', newUrl);

        } else {
            // 参加失敗
            const errorMsg = ack && ack.error ? ack.error : "参加できませんでした";
            alert("エラー: " + errorMsg);
        }
    });
});

function toggleScreen(showGame) {
    if (showGame) {
        homeScreen.style.display = "none";
        gameScreen.style.display = "block";
        onWindowResize();
    } else {
        homeScreen.style.display = "flex";
        gameScreen.style.display = "none";
    }
}


// --- ▼▼▼ Three.js セットアップ ▼▼▼ ---
let scene, camera, renderer, raycaster, pointer;
let controls;

let boardGroup; 
let pieceMeshes = []; 
const cellObjects = []; 
let selectedMesh = null; 

const COLORS = {
    A: 0x1f78b4,
    B: 0xef6c00,
    board: 0xffffff,
    selected: 0xfacc15 
};

const PIECE_SIZES = { 
    small: {r: 0.8, h: 1.0}, 
    medium: {r: 1.1, h: 1.5}, 
    large: {r: 1.4, h: 2.0} 
};
const CELL_GAP = 3.3; 
const BOARD_OFFSET = -CELL_GAP;

function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f6fb);

    // カメラ
    const aspect = boardWrap.clientWidth / 500;
    camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
    camera.position.set(0, 10, 12);
    camera.lookAt(0, 0, 0);

    // ライト
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(5, 10, 7);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    // レンダラー
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(boardWrap.clientWidth, 500);
    renderer.shadowMap.enabled = true;
    boardWrap.innerHTML = '';
    boardWrap.appendChild(renderer.domElement);

    // OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = 8;
    controls.maxDistance = 25;

    // レイキャスター
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    // イベントリスナー
    renderer.domElement.addEventListener('click', onCanvasClick);
    window.addEventListener('resize', onWindowResize);

    animate();
}

function animate() {
    requestAnimationFrame(animate);

    if (controls) {
        controls.update(); 
    }
    renderer.render(scene, camera);
}


// --- チャットメッセージ処理 ---
  const chatMessages = document.getElementById("chatMessages");
  const chatInput = document.getElementById("chatInput");
  const chatSendBtn = document.getElementById("chatSendBtn");

  function appendChat(msg) {
    const time = new Date(msg.time).toLocaleTimeString();
    const div = document.createElement("div");
    div.innerHTML = `<strong>${escapeHtml(msg.name)}</strong>: ${escapeHtml(msg.text)} <span style="color:#888;font-size:11px;">(${time})</span>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatSendBtn.onclick = () => {
    const text = chatInput.value.trim();
    if (!text) return;
    socket.emit("chat_message", { text });
    chatInput.value = "";
  };

  chatInput.addEventListener("keydown", e => {
    if (e.key === "Enter") chatSendBtn.onclick();
  });

  socket.on("chat_message", (msg) => {
    appendChat(msg);
  });

  socket.on("chat_init", (log) => {
    log.forEach(msg => appendChat(msg));
  });

/**
 * 2. 3D盤面の構築
 */
function buildBoard3D() {
    boardGroup = new THREE.Group();

    // 盤面
    const boardGeo = new THREE.BoxGeometry(CELL_GAP * 3, 0.2, CELL_GAP * 3);
    const boardMat = new THREE.MeshStandardMaterial({ color: COLORS.board });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.receiveShadow = true;
    boardGroup.add(boardMesh);

    // 区切り線
    const lineColor = new THREE.Color(0xdde5ed);
    const lineMaterial = new THREE.MeshBasicMaterial({ color: lineColor });
    const lineThickness = 0.1;

    // 縦線
    for (let i = 1; i < 3; i++) {
        const lineGeo = new THREE.BoxGeometry(lineThickness, 0.25, CELL_GAP * 3 + lineThickness * 2);
        const lineMesh = new THREE.Mesh(lineGeo, lineMaterial);
        lineMesh.position.set(i * CELL_GAP + BOARD_OFFSET - CELL_GAP / 2, 0.1, 0);
        boardGroup.add(lineMesh);
    }
    // 横線
    for (let i = 1; i < 3; i++) {
        const lineGeo = new THREE.BoxGeometry(CELL_GAP * 3 + lineThickness * 2, 0.25, lineThickness);
        const lineMesh = new THREE.Mesh(lineGeo, lineMaterial);
        lineMesh.position.set(0, 0.1, i * CELL_GAP + BOARD_OFFSET - CELL_GAP / 2);
        boardGroup.add(lineMesh);
    }

    // マス (透明)
    const cellGeo = new THREE.BoxGeometry(3, 0.1, 3);
    cellGeo.translate(0, 0.15, 0);

    const cellMat = new THREE.MeshBasicMaterial({ 
        color: 0xff0000, 
        transparent: true, 
        opacity: 0,
        depthWrite: false
    });

    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            const cell = new THREE.Mesh(cellGeo, cellMat);
            cell.position.set(c * CELL_GAP + BOARD_OFFSET, 0, r * CELL_GAP + BOARD_OFFSET);
            cell.userData = { type: 'cell', r, c }; 
            boardGroup.add(cell);
            cellObjects.push(cell); 
        }
    }
    scene.add(boardGroup);
}

function createPieceMesh(size, owner) {
    const { r, h } = PIECE_SIZES[size];
    const geometry = new THREE.CylinderGeometry(r, r, h, 32);
    const color = COLORS[owner];
    const material = new THREE.MeshStandardMaterial({ color: color });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    return mesh;
}

function render(stateObj) {
    state = stateObj;
    
    turnLabel.textContent = state.currentTurn || '—';
    gameStateLabel.textContent = state.winner ? `終了: ${state.winner}` : (state.started ? '進行中' : '待機中');
    meLabel.textContent = mySlot ? `${mySlot}` : '未割当';

    pieceMeshes.forEach(mesh => scene.remove(mesh));
    pieceMeshes = [];

    if (state.board) {
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                const stack = (state.board[r] && state.board[r][c]) ? state.board[r][c] : [];
                const x = c * CELL_GAP + BOARD_OFFSET;
                const z = r * CELL_GAP + BOARD_OFFSET;
                let currentHeight = 0;
                for (let i = 0; i < stack.length; i++) {
                    const p = stack[i]; 
                    const pieceMesh = createPieceMesh(p.size, p.owner);
                    const y = currentHeight + pieceMesh.geometry.parameters.height / 2 + 0.1;
                    pieceMesh.position.set(x, y, z);
                    pieceMesh.userData = { 
                        type: 'piece', 
                        r, c, 
                        size: p.size, 
                        owner: p.owner, 
                        isTop: (i === stack.length - 1) 
                    };
                    scene.add(pieceMesh);
                    pieceMeshes.push(pieceMesh); 
                    currentHeight += pieceMesh.geometry.parameters.height * 0.2; 
                }
            }
        }
    }
    renderHandDOM();
}

function onCanvasClick(event) {
    if (!state.started && !state.winner) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const objectsToIntersect = [...cellObjects, ...pieceMeshes];
    const intersects = raycaster.intersectObjects(objectsToIntersect);

    if (intersects.length > 0) {
        const clickedObj = intersects[0].object; 
        const data = clickedObj.userData;
        let targetR, targetC;
        
        if (data.type === 'cell') { 
            targetR = data.r;
            targetC = data.c;
        } else if (data.type === 'piece') { 
            targetR = data.r;
            targetC = data.c;
        } else {
            return; 
        }
            
        // 1. 選択なし -> 盤上駒選択
        if (!selectedPiece) {
            if (data.type === 'piece' && data.isTop && data.owner === mySlot) {
                selectedPiece = { from: { type: 'cell', r: data.r, c: data.c }, size: data.size };
                highlightSelection(clickedObj); 
                addLog(`盤上駒選択: (${data.r},${data.c})`);
                return;
            } else if (data.type === 'cell') {
                addLog('先に手駒を選択してください');
                return;
            }
        }

        const basePayload = { room: currentRoomID }; 

        // 2. 手駒配置
        if (selectedPiece.from.type === 'hand') {
            const payload = { 
                ...basePayload,
                action: 'place_from_hand', 
                size: selectedPiece.size, 
                to: { r: targetR, c: targetC } 
            };
            socket.emit('place_piece', payload, (ack) => {
                if (ack && ack.error) addLog('エラー: ' + ack.error);
            });
            addLog(`手駒を送信: ${selectedPiece.size} -> (${targetR},${targetC})`);
            clearSelection();
            return;
        }

        // 3. 盤上移動
        if (selectedPiece.from.type === 'cell') {
            if (selectedPiece.from.r === targetR && selectedPiece.from.c === targetC) {
                clearSelection();
                addLog('選択解除');
                return;
            }
            const payload = { 
                ...basePayload,
                action: 'move_on_board', 
                from: { r: selectedPiece.from.r, c: selectedPiece.from.c }, 
                to: { r: targetR, c: targetC } 
            };
            socket.emit('place_piece', payload, (ack) => {
                if (ack && ack.error) addLog('エラー: ' + ack.error);
            });
            addLog(`盤上駒の移動を送信: (${selectedPiece.from.r},${selectedPiece.from.c}) -> (${targetR},${targetC})`);
            clearSelection();
            return;
        }
    }
}

function highlightSelection(meshToHighlight = null) {
    document.querySelectorAll('.hand-piece').forEach(el => el.classList.remove('selected'));
    if (selectedPiece && selectedPiece.from.type === 'hand') {
        const el = [...handContainer.children].find(ch => ch.dataset.size === selectedPiece.size);
        if (el) el.classList.add('selected');
    }
    if (selectedMesh) {
        selectedMesh.material.color.set(COLORS[selectedMesh.userData.owner]);
        selectedMesh = null;
    }
    if (meshToHighlight) {
        meshToHighlight.material.color.set(COLORS.selected);
        selectedMesh = meshToHighlight;
    }
    renderer.render(scene, camera);
}

function clearSelection() {
    selectedPiece = null;
    highlightSelection(null); 
}

function onWindowResize() {
    if (boardWrap.clientWidth === 0) return;

    const width = boardWrap.clientWidth;
    const height = 500; 
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
}


// --- 既存のSocket.IOロジック (DOM手駒・ログ) ---

function addLog(s){
  const t = new Date().toLocaleTimeString();
  logEl.innerHTML = `<div>[${t}] ${escapeHtml(s)}</div>` + logEl.innerHTML;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderHandDOM(){
  handContainer.innerHTML = '';
  if (!state || !mySlot || !state.players || mySlot === 'spectator') return;
  
  const me = state.players[mySlot];
  if (!me) return;
  
  if (selectedPiece && selectedPiece.from.type === 'hand') {
      highlightSelection(null);
  }
  
  const sizes = ['large','medium','small'];
  sizes.forEach(size=>{
    const num = me.pieces[size] || 0;
    for (let i=0; i<num; i++){
      const wrapper = document.createElement('div');
      wrapper.className = 'hand-piece';
      const piece = document.createElement('div');
      piece.className = `piece size-${size} color-${mySlot==='A'?'A':'B'}`;
      piece.textContent = ''; 
      wrapper.appendChild(piece);
      wrapper.dataset.size = size;
      wrapper.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedPiece = { from: { type: 'hand'}, size };
        highlightSelection(null); 
        addLog(`手駒選択: ${size}`);
      });
      handContainer.appendChild(wrapper);
    }
  });
}

// --- モーダル関連イベント ---
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        modalOverlay.classList.remove('hidden');
    });
}
if (closeModalBtn) {
    closeModalBtn.addEventListener('click', () => {
        modalOverlay.classList.add('hidden');
    });
}
if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            modalOverlay.classList.add('hidden');
        }
    });
}

tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        tabButtons.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const targetId = btn.dataset.tab;
        const targetContent = document.getElementById(targetId);
        if (targetContent) targetContent.classList.add('active');
    });
});

if (modalRestartBtn) {
    modalRestartBtn.addEventListener('click', () => {
        socket.emit('restart_game', {}, (ack) => {
            if (ack && ack.ok) addLog('再戦リクエスト送信');
            else if (ack && ack.error) addLog('再戦失敗: ' + ack.error);
        });
        modalOverlay.classList.add('hidden');
    });
}

if (modalLeaveBtn) {
    modalLeaveBtn.addEventListener('click', () => {
        socket.disconnect();
        modalOverlay.classList.add('hidden');
        if(confirm("退出してホームに戻りますか？")){
            window.location.href = window.location.pathname; 
        }
    });
}

if (toggleHighlightBtn) {
    toggleHighlightBtn.addEventListener('click', () => {
        config.highlightMoves = !config.highlightMoves;
        if (config.highlightMoves) {
            toggleHighlightBtn.classList.add('on');
            toggleHighlightBtn.textContent = 'ON';
        } else {
            toggleHighlightBtn.classList.remove('on');
            toggleHighlightBtn.textContent = 'OFF';
            if (selectedMesh) {
                selectedMesh.material.color.set(COLORS[selectedMesh.userData.owner]);
                selectedMesh = null;
                renderer.render(scene, camera);
            }
        }
    });
}


// --- ★追加: リザルト画面の処理 ---
function showResult(winner) {
    resultOverlay.classList.remove('hidden');
    resultContent.classList.remove('lose'); // クラスリセット

    if (mySlot === 'spectator') {
        resultTitle.textContent = "GAME SET";
        resultMessage.textContent = `勝者: ${winner}`;
    } else if (winner === mySlot) {
        // 勝ち
        resultTitle.textContent = "YOU WIN!";
        resultMessage.textContent = "おめでとうございます！";
        fireConfetti(); // 紙吹雪発射！
    } else {
        // 負け
        resultTitle.textContent = "YOU LOSE...";
        resultMessage.textContent = "ドンマイ！次は勝てます！";
        resultContent.classList.add('lose'); 
    }
}

function fireConfetti() {
    const count = 200;
    const defaults = {
        origin: { y: 0.7 }
    };

    function fire(particleRatio, opts) {
        confetti({
            ...defaults,
            ...opts,
            particleCount: Math.floor(count * particleRatio)
        });
    }

    fire(0.25, { spread: 26, startVelocity: 55 });
    fire(0.2, { spread: 60 });
    fire(0.35, { spread: 100, decay: 0.91, scalar: 0.8 });
    fire(0.1, { spread: 120, startVelocity: 25, decay: 0.92, scalar: 1.2 });
    fire(0.1, { spread: 120, startVelocity: 45 });
}

// リザルト画面のボタンイベント
if (resultRestartBtn) {
    resultRestartBtn.addEventListener('click', () => {
        socket.emit('restart_game', {}, (ack) => {
            if (ack && ack.ok) {
                addLog('再戦リクエスト送信');
                resultOverlay.classList.add('hidden'); 
            }
        });
    });
}

if (resultCloseBtn) {
    resultCloseBtn.addEventListener('click', () => {
        resultOverlay.classList.add('hidden');
    });
}


// --- Socketイベントリスナー ---
socket.on('connect', () => {
  myId = socket.id;
});
socket.on('init', (s) => {});
socket.on('assign', (d) => {
    if(d && d.slot) addLog(`(System) Role Assigned: ${d.slot}`);
});
socket.on('start_game', (s) => {
  // ゲーム開始時にリザルトが開いていたら閉じる
  resultOverlay.classList.add('hidden');
  addLog('ゲーム開始！');
  clearSelection();
  render(s);
});
socket.on('update_state', (s) => {
  render(s); 
});
socket.on('invalid_move', (d) => {
  addLog('不正手: ' + (d && d.reason ? d.reason : 'unknown'));
});
socket.on('game_over', (d) => {
  addLog('ゲーム終了: 勝者 = ' + d.winner);
  clearSelection();
  render(d.state);
  
  // ★リザルト演出呼び出し
  showResult(d.winner);
});
socket.on('disconnect', () => {
  addLog('サーバー切断');
});

// --- 実行開始 ---
initThree(); 
buildBoard3D(); 
if (controls) {
    controls.update(); 
}
renderer.render(scene, camera);