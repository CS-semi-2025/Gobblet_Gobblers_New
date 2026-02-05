// client.js (Three.js version - Multi-room ready + GSAP Animation)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import confetti from 'canvas-confetti'; 


const isMobile = window.innerWidth <= 768;

const BOARD_SIZE = isMobile
  ? Math.min(window.innerWidth * 0.92, 320)
  : 420;

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
const turnCutIn = document.getElementById('turnCutIn');
const cutinText = document.getElementById('cutinText');
// モーダルUI用の要素
const settingsBtn = document.getElementById('settingsBtn');
const modalOverlay = document.getElementById('modalOverlay');
const closeModalBtn = document.getElementById('closeModalBtn');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const modalLeaveBtn = document.getElementById('modalLeaveBtn');
const toggleHighlightBtn = document.getElementById('toggleHighlightBtn');

// ホーム画面用ボタンの参照
const homeSettingsBtn = document.getElementById('homeSettingsBtn'); 
const gameActionsTab = document.querySelector('.tab-btn[data-tab="tab-control"]'); 

// リザルトUIの要素
const resultOverlay = document.getElementById('resultOverlay');
const resultTitle = document.getElementById('resultTitle');
const resultMessage = document.getElementById('resultMessage');
const resultContent = document.querySelector('.result-content');

// リザルト画面のアクション要素
const playerActions = document.getElementById('playerActions');
const spectatorActions = document.getElementById('spectatorActions');
const btnRematch = document.getElementById('btnRematch');
const btnSpectate = document.getElementById('btnSpectate');
const btnLeave = document.getElementById('btnLeave');
const resultCloseBtn = document.getElementById('resultCloseBtn');
const resultWaitMsg = document.getElementById('resultWaitMsg');


// グローバル変数
let mySlot = null;
let myId = null;
let state = null;
let selectedPiece = null; 
let currentRoomID = null; 

let handMeshes = []; 
const HAND_Z_Blue = 9;   
const HAND_Z_Orange = -9;  
const HAND_X_START = -7.0; // 広げるために左へずらす
const HAND_X_GAP = 2.5;    // 間隔を広げる
let lastSelectedHandX = 0; // 追加: アニメーション開始位置の記憶用
// --- 手駒スロット管理用の変数 ---
const handSlots = { Blue: [], Orange: [] }; // スロット情報 { mesh, size, active, slotId } を格納
let isHandInitialized = false;      // 初期化フラグ
let lastPlayedSlotId = null;        // 最後に操作した手駒のID（どの場所を消すか判定用）
// --- 音声管理 ---
const audioFiles = {
    bgm: new Audio('assets/bgm.mp3'),
    select: new Audio('assets/select.mp3'),
    place: new Audio('assets/place.mp3'),
    win: new Audio('assets/win.mp3'),
    lose: new Audio('assets/lose.mp3')
};

// BGMはループ再生
audioFiles.bgm.loop = true;
audioFiles.bgm.volume = 0.3; 
const seKeys = ['select', 'place', 'win', 'lose'];
seKeys.forEach(key => audioFiles[key].volume = 0.5);

function playSE(key) {
    if (audioFiles[key]) {
        audioFiles[key].currentTime = 0; 
        audioFiles[key].play().catch(() => {}); 
    }
}

// 設定値
let config = {
    highlightMoves: true
};

// URLパラメータ処理
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

    audioFiles.bgm.play().catch(e => console.log('BGM Play Error:', e));

    socket.emit("join", joinData, (ack) => {
        if (ack && (ack.ok || ack.slot)) {
            mySlot = ack.slot;
            currentRoomID = roomVal;
            
            currentRoomLabel.textContent = currentRoomID;
            gameNameInput.value = nameVal;
            
            addLog(`ルーム「${currentRoomID}」に参加しました (Role: ${mySlot})`);
            if (mySlot === 'spectator') addLog('観戦モードです');

            toggleScreen(true);

            const newUrl = `${window.location.pathname}?room=${encodeURIComponent(currentRoomID)}`;
            window.history.pushState({ path: newUrl }, '', newUrl);

        } else {
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
let pieceMeshes = []; // 現在シーンにある駒のリスト
const cellObjects = []; 
let selectedMesh = null; 

const COLORS = {
    Blue: 0x1f78b4,
    Orange: 0xef6c00,
    board: 0xffffff,
    selected: 0xfacc15 
};

const PIECE_SIZES = { 
    small:  { r: 0.8, h: 2.2 }, 
    medium: { r: 1.1, h: 3.0 }, 
    large:  { r: 1.4, h: 3.8 }  
};

const CELL_GAP = 3.3; 
const BOARD_OFFSET = -CELL_GAP;

function initThree() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f6fb);

    // カメラ
    const aspect = boardWrap.clientWidth / 500;
    camera = new THREE.PerspectiveCamera(60, aspect, 0.1, 1000);
    camera.position.set(0, 20, 25);
    camera.lookAt(0, 0, 0);

    // ライト
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.0);
    scene.add(ambientLight);
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(5, 10, 7);
    directionalLight.castShadow = true;
    
    // 影の設定（少し綺麗に）
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    scene.add(directionalLight);

    // レンダラー
    renderer = new THREE.WebGLRenderer({ antialias: true });
    
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap; // 柔らかい影
    boardWrap.innerHTML = '';
    boardWrap.appendChild(renderer.domElement);

    // OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI / 2.1;
    controls.minDistance = 8;
    controls.maxDistance = 40;

    // レイキャスター
    raycaster = new THREE.Raycaster();
    pointer = new THREE.Vector2();

    // イベントリスナー
    renderer.domElement.addEventListener('click', onCanvasClick);
    window.addEventListener('resize', onWindowResize);

    animate();

    if (isMobile && controls) {
    controls.enablePan = false;
}

}

function animate() {
    requestAnimationFrame(animate);
    if (controls) controls.update(); 
    renderer.render(scene, camera);
}
const errorPopup = document.getElementById("errorPopup");
const errorPopupText = document.getElementById("errorPopupText");

function showPopup(msg) {
  if (!errorPopup || !errorPopupText) return;

  errorPopup.classList.remove("hidden");
  errorPopupText.textContent = msg;

  // エラーっぽい色にする
  errorPopupText.style.color = "#ff4757";
  errorPopup.querySelector(".cutin-content").style.borderColor = "#ff4757";

  setTimeout(() => {
    errorPopup.classList.add("hidden");
  }, 2000);
}




 // --- チャットメッセージ処理 ---
const chatMessages = document.getElementById("chatMessages");
const chatInput = document.getElementById("chatInput");
const chatSendBtn = document.getElementById("chatSendBtn");

function launchFlyingComment(text) {
  const el = document.createElement("div");
  el.className = "flying-comment";
  el.textContent = text;
  el.style.color = randomColor();
  el.style.top = `${Math.random() * 60 + 10}%`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function randomColor() {
  const r = Math.floor(Math.random() * 150 + 55); 
  const g = Math.floor(Math.random() * 150 + 55);
  const b = Math.floor(Math.random() * 150 + 55);
  return `rgb(${r},${g},${b})`;
}

const bgmSlider = document.getElementById('bgmVolumeSlider');
const seSlider = document.getElementById('seVolumeSlider');

if (bgmSlider) {
    bgmSlider.addEventListener('input', (e) => {
        const vol = e.target.value / 100;
        audioFiles.bgm.volume = vol;
    });
}
if (seSlider) {
    seSlider.addEventListener('input', (e) => {
        const vol = e.target.value / 100;
        seKeys.forEach(key => audioFiles[key].volume = vol);
    });
}

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
  launchFlyingComment(msg.text);
});

socket.on("cheer", (data) => {
  launchFlyingComment(`${data.name}: ${data.text}`);
});

socket.on("chat_init", (log) => {
  log.forEach(msg => appendChat(msg));
});


// --- 3D盤面の構築 ---
function buildBoard3D() {
    boardGroup = new THREE.Group();

    // 1. 木のテーブルを作成
    const tableGeo = new THREE.BoxGeometry(50, 2, 50); 
    const woodTexture = createWoodTexture();
    const tableMat = new THREE.MeshStandardMaterial({ 
        map: woodTexture,
        roughness: 0.8,
        color: 0xdddddd 
    });
    const tableMesh = new THREE.Mesh(tableGeo, tableMat);
    tableMesh.position.set(0, -1.2, 0); 
    tableMesh.receiveShadow = true;     
    scene.add(tableMesh); 


    // 2. ゲームボード（枠内）
    const boardGeo = new THREE.BoxGeometry(CELL_GAP * 3 + 0.5, 0.2, CELL_GAP * 3 + 0.5);
    const boardMat = new THREE.MeshStandardMaterial({ 
        color: 0xffffff,
        transparent: true,
        opacity: 0.8 
    });
    const boardMesh = new THREE.Mesh(boardGeo, boardMat);
    boardMesh.position.y = -0.15; 
    boardMesh.receiveShadow = true;
    boardGroup.add(boardMesh);

    // 3. 格子ライン 
    const lineColor = new THREE.Color(0xffffff);
    const lineMaterial = new THREE.MeshStandardMaterial({ 
        color: lineColor,
        roughness: 0.4
    });
    const lineThickness = 0.15;
    const lineLength = CELL_GAP * 3;

    // 井の字を作る
    // 縦線
    for (let i = 1; i < 3; i++) {
        const lineGeo = new THREE.BoxGeometry(lineThickness, 0.2, lineLength);
        const lineMesh = new THREE.Mesh(lineGeo, lineMaterial);
        lineMesh.position.set(i * CELL_GAP + BOARD_OFFSET - CELL_GAP / 2, 0, 0);
        lineMesh.castShadow = true;
        boardGroup.add(lineMesh);
    }
    // 横線
    for (let i = 1; i < 3; i++) {
        const lineGeo = new THREE.BoxGeometry(lineLength, 0.2, lineThickness);
        const lineMesh = new THREE.Mesh(lineGeo, lineMaterial);
        lineMesh.position.set(0, 0, i * CELL_GAP + BOARD_OFFSET - CELL_GAP / 2);
        lineMesh.castShadow = true;
        boardGroup.add(lineMesh);
    }

    // 4. マス (判定用・透明)
    const cellGeo = new THREE.BoxGeometry(3, 0.5, 3);
    const cellMat = new THREE.MeshBasicMaterial({ 
        color: 0xff0000, 
        transparent: true, 
        opacity: 0,
        depthWrite: false
    });

    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            const cell = new THREE.Mesh(cellGeo, cellMat);
            cell.position.set(c * CELL_GAP + BOARD_OFFSET, 0.2, r * CELL_GAP + BOARD_OFFSET);
            cell.userData = { type: 'cell', r, c }; 
            boardGroup.add(cell);
            cellObjects.push(cell); 
        }
    }
    scene.add(boardGroup);
}

// 顔のテクスチャ生成
function createFaceTexture(colorHex) {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = colorHex;
    ctx.fillRect(0, 0, size, size);

    const centerX = size / 2;
    const eyeY = size * 0.38;
    const eyeOffset = size * 0.16; 
    const eyeW = size * 0.14;      
    const eyeH = size * 0.18;      

    function drawEllipse(x, y, w, h, color) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(x, y, w, h, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    drawEllipse(centerX - eyeOffset, eyeY, eyeW, eyeH, 'white');
    drawEllipse(centerX + eyeOffset, eyeY, eyeW, eyeH, 'white');

    const pupilSize = eyeW * 0.45;
    const pupilOffset = eyeW * 0.2; 
    drawEllipse(centerX - eyeOffset + pupilOffset, eyeY, pupilSize, pupilSize, '#333');
    drawEllipse(centerX - eyeOffset + pupilOffset + pupilSize*0.3, eyeY - pupilSize*0.3, pupilSize*0.3, pupilSize*0.3, 'white');
    drawEllipse(centerX + eyeOffset - pupilOffset, eyeY, pupilSize, pupilSize, '#333');
    drawEllipse(centerX + eyeOffset - pupilOffset + pupilSize*0.3, eyeY - pupilSize*0.3, pupilSize*0.3, pupilSize*0.3, 'white');

    ctx.strokeStyle = '#333';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(centerX - eyeOffset, eyeY - eyeH - 20, 30, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX + eyeOffset, eyeY - eyeH - 20, 30, Math.PI * 1.2, Math.PI * 1.8);
    ctx.stroke();

    const mouthY = size * 0.65;
    ctx.fillStyle = '#4a0404'; 
    ctx.beginPath();
    ctx.arc(centerX, mouthY, size * 0.15, 0, Math.PI, false);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.rect(centerX - size*0.1, mouthY, size*0.2, size*0.04);
    ctx.fill();
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.arc(centerX, mouthY + size*0.1, size * 0.08, 0, Math.PI * 2);
    ctx.fill();

    return new THREE.CanvasTexture(canvas);
}

// 木目調テクスチャを生成する関数
function createWoodTexture() {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // 1. ベースの色
    ctx.fillStyle = '#d4a76a';
    ctx.fillRect(0, 0, size, size);

    // 2. 木目を描く
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    
    for (let i = 0; i < 80; i++) {
        const alpha = 0.1 + Math.random() * 0.2;
        ctx.strokeStyle = `rgba(101, 67, 33, ${alpha})`; 

        ctx.beginPath();
        let x = Math.random() * size;
        let y = -10;
        ctx.moveTo(x, y);

        while (y < size + 10) {
            y += Math.random() * 20 + 10;
            x += (Math.random() - 0.5) * 10; 
            ctx.lineTo(x, y);
        }
        ctx.stroke();
    }

    // 3. 全体にノイズ
    const imageData = ctx.getImageData(0, 0, size, size);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
        if (Math.random() > 0.5) {
            const noise = (Math.random() - 0.5) * 20;
            data[i] = Math.min(255, Math.max(0, data[i] + noise));
            data[i+1] = Math.min(255, Math.max(0, data[i+1] + noise));
            data[i+2] = Math.min(255, Math.max(0, data[i+2] + noise));
        }
    }
    ctx.putImageData(imageData, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 4); 
    
    return texture;
}

// 駒メッシュ生成
function createPieceMesh(size, owner) {
    const { r, h } = PIECE_SIZES[size];
    const points = [];
    const segments = 12; 
    const domeRadius = r; 
    const bodyHeight = Math.max(0, h - domeRadius); 

    points.push(new THREE.Vector2(0, 0));
    points.push(new THREE.Vector2(r, 0));
    points.push(new THREE.Vector2(r, bodyHeight));

    for (let i = 0; i <= segments; i++) {
        const theta = (i / segments) * (Math.PI / 2);
        const x = domeRadius * Math.cos(theta);
        const y = bodyHeight + (domeRadius * Math.sin(theta));
        points.push(new THREE.Vector2(x, y));
    }

    const geometry = new THREE.LatheGeometry(points, 32);
    const baseColor = new THREE.Color(COLORS[owner]); 
    const texture = createFaceTexture('#' + baseColor.getHexString());

    const material = new THREE.MeshStandardMaterial({ 
        map: texture,
        color: 0xffffff, 
        roughness: 0.4
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    if (owner === 'Blue') {
        mesh.rotation.y = 0; 
    } else {
        mesh.rotation.y = Math.PI; 
    }
    return mesh;
}

// 手駒スロットを初期化する関数（固定配置）
function initHandSlots() {
    if (isHandInitialized) return;

    ['Blue', 'Orange'].forEach(owner => {
        const z = (owner === 'Blue') ? HAND_Z_Blue : HAND_Z_Orange;
        let x = HAND_X_START;

        // 固定順序: 大, 大, 中, 中, 小, 小
        const sizes = ['large', 'large', 'medium', 'medium', 'small', 'small'];

        sizes.forEach((size, idx) => {
            // メッシュ作成
            const mesh = createPieceMesh(size, owner);
            mesh.position.set(x, 0.1, z);
            
            // IDと情報を埋め込む
            mesh.userData = { type: 'hand', owner, size, slotId: idx }; 
            
            // 最初は非表示にしておく（renderで同期する）
            mesh.visible = false;
            
            scene.add(mesh);
            
            // 管理リストに追加
            handSlots[owner].push({
                mesh: mesh,
                size: size,
                slotId: idx
            });
            
            // Raycaster判定用リストにも追加
            handMeshes.push(mesh); 

            // 座標計算
            x += HAND_X_GAP;
            if (idx % 2 === 1) x += 0.5; // サイズごとの区切り
        });
    });

    isHandInitialized = true;
}

// --- アニメーション移動ヘルパー (GSAP) ---
function animateJump(mesh, targetX, targetZ, onComplete) {
    // 現在位置
    const startX = mesh.position.x;
    const startZ = mesh.position.z;
    const dist = Math.sqrt((targetX - startX)**2 + (targetZ - startZ)**2);
    
    if (dist < 0.1) {
        mesh.position.set(targetX, 0.1, targetZ); 
        if(onComplete) onComplete();
        return;
    }

    const jumpHeight = Math.max(2, dist * 0.5);

    if (typeof gsap !== 'undefined') {
        gsap.to(mesh.position, {
            duration: 0.6,
            x: targetX,
            z: targetZ,
            ease: "power1.inOut"
        });

        const tl = gsap.timeline({
            onComplete: () => {
                playSE('place'); 
                if (onComplete) onComplete();
            }
        });

        tl.to(mesh.position, {
            duration: 0.3,
            y: jumpHeight,
            ease: "power2.out"
        }).to(mesh.position, {
            duration: 0.3,
            y: 0.1, 
            ease: "bounce.out" 
        });
    } else {
        mesh.position.set(targetX, 0.1, targetZ);
    }
}

// --- メイン描画ループ (アニメーション対応版) ---
function render(stateObj) {
    state = stateObj;
    
    turnLabel.textContent = state.currentTurn || '—';
    // 待機中の表示を詳細に
    if (!state.started && !state.winner) {
        gameStateLabel.textContent = '待機中 (観戦者: ' + (state.spectatorCount || 0) + '人)';
    } else {
        gameStateLabel.textContent = state.winner ? `終了: ${state.winner}` : `進行中(観戦: ${state.spectatorCount || 0}人)`;
    }
    meLabel.textContent = mySlot ? `${mySlot}` : '未割当';

    // 1. 今回必要な駒のリストを作成
    const neededPieces = [];

    if (state.board) {
        for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
                const stack = (state.board[r] && state.board[r][c]) ? state.board[r][c] : [];
                const x = c * CELL_GAP + BOARD_OFFSET;
                const z = r * CELL_GAP + BOARD_OFFSET;
                
                for (let i = 0; i < stack.length; i++) {
                    const p = stack[i];
                    neededPieces.push({
                        owner: p.owner,
                        size: p.size,
                        targetX: x,
                        targetZ: z,
                        r: r, c: c,
                        isTop: (i === stack.length - 1)
                    });
                }
            }
        }
    }

    // 2. 既存メッシュのプールを作成（再利用のため）
    const pool = { 'Blue-small': [], 'Blue-medium': [], 'Blue-large': [], 'Orange-small': [], 'Orange-medium': [], 'Orange-large': [] };
    
    pieceMeshes.forEach(mesh => {
        const key = `${mesh.userData.owner}-${mesh.userData.size}`;
        if (pool[key]) pool[key].push(mesh);
    });

    // --- 3. 次フレーム用のメッシュリスト ---
    const nextPieceMeshes = [];
    const piecesToMoveOrCreate = []; 

    // 【ステップA】 すでにその場所にある駒（動かない駒）を先に確保する
    neededPieces.forEach(pData => {
        const key = `${pData.owner}-${pData.size}`;
        let foundIndex = -1;

        if (pool[key] && pool[key].length > 0) {
            foundIndex = pool[key].findIndex(m => {
                const distSq = (m.position.x - pData.targetX)**2 + (m.position.z - pData.targetZ)**2;
                return distSq < 0.01; 
            });
        }

        if (foundIndex !== -1) {
            const mesh = pool[key][foundIndex];
            pool[key].splice(foundIndex, 1); 

            mesh.userData.r = pData.r;
            mesh.userData.c = pData.c;
            mesh.userData.isTop = pData.isTop;
            mesh.userData.owner = pData.owner;
            mesh.userData.size = pData.size;
            mesh.userData.type = 'piece';

            animateJump(mesh, pData.targetX, pData.targetZ);
            nextPieceMeshes.push(mesh);
        } else {
            piecesToMoveOrCreate.push(pData);
        }
    });

    // 【ステップB】 残りの駒（移動 or 新規）に対して、一番近いメッシュを割り当てる
    piecesToMoveOrCreate.forEach(pData => {
        const key = `${pData.owner}-${pData.size}`;
        let mesh;

        let bestIndex = -1;
        let minDist = Infinity;

        if (pool[key] && pool[key].length > 0) {
            pool[key].forEach((m, idx) => {
                const d = (m.position.x - pData.targetX)**2 + (m.position.z - pData.targetZ)**2;
                if (d < minDist) {
                    minDist = d;
                    bestIndex = idx;
                }
            });
        }

        if (bestIndex !== -1) {
            mesh = pool[key][bestIndex];
            pool[key].splice(bestIndex, 1);
        } else {
            mesh = createPieceMesh(pData.size, pData.owner);
            scene.add(mesh);
            
            // 出現位置
            let startX = pData.targetX; 
            const startZ = (pData.owner === 'Blue') ? HAND_Z_Blue : HAND_Z_Orange;

            if (pData.owner === mySlot && lastSelectedHandX !== 0) {
                startX = lastSelectedHandX;
            } else if (pData.owner !== mySlot) {
                startX = (Math.random() - 0.5) * 8; 
            }
            mesh.position.set(startX, 0.1, startZ);
        }

        mesh.userData.r = pData.r;
        mesh.userData.c = pData.c;
        mesh.userData.isTop = pData.isTop;
        mesh.userData.owner = pData.owner;
        mesh.userData.size = pData.size;
        mesh.userData.type = 'piece';

        animateJump(mesh, pData.targetX, pData.targetZ);

        nextPieceMeshes.push(mesh);
    });

    // 4. 余ったメッシュ（取られた駒、またはリセット時）を削除
    Object.values(pool).forEach(list => {
        list.forEach(mesh => {
            if (typeof gsap !== 'undefined') {
                gsap.to(mesh.scale, {
                    duration: 0.3, x: 0, y: 0, z: 0,
                    onComplete: () => scene.remove(mesh)
                });
            } else {
                scene.remove(mesh);
            }
        });
    });

    pieceMeshes = nextPieceMeshes;
    renderHands3D(state.players);

    // ★追加: 待機画面制御 (winnerなし, started=false の場合)
    if (!state.started && !state.winner) {
        // もしリザルト画面が出ていた場合、プレイヤーが変わったら閉じる
        resultOverlay.classList.add('hidden');
    }
}

function onCanvasClick(event) {
    if (!state.started && !state.winner) return;
    // 観戦者は操作できない
    if (mySlot === 'spectator') return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);

    const objectsToIntersect = [...cellObjects, ...pieceMeshes, ...handMeshes]; 
    
    const intersects = raycaster.intersectObjects(objectsToIntersect);

    if (intersects.length > 0) {
        let clickedObj = intersects[0].object; 
        while(!clickedObj.userData.type && clickedObj.parent){
            clickedObj = clickedObj.parent;
        }

        const data = clickedObj.userData;
        let targetR, targetC;
        
        // --- 手駒選択 ---
        if (data.type === 'hand') {
            if (data.owner !== mySlot) {
                addLog('相手の駒は操作できません');
                return;
            }
            selectedPiece = { from: { type: 'hand' }, size: data.size };
            
            lastSelectedHandX = clickedObj.position.x;

            if (data.slotId !== undefined) {
                lastPlayedSlotId = data.slotId;
            }

            highlightSelection(clickedObj);
            playSE('select');
            addLog(`手駒選択: ${data.size}`);
            return;
        }

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
                playSE('select');
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
                if (ack && ack.error) {
                    showPopup(ack.error);
                    addLog('エラー: ' + ack.error);
                    return;
                }
                clearSelection();
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
                if (ack && ack.error) {
                    showPopup(ack.error);
                    addLog('エラー: ' + ack.error);
                    return;
                }
                clearSelection();
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
        selectedMesh.material.color.set(0xffffff); 
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
    if (!renderer) return;

    const size = isMobile
      ? Math.min(window.innerWidth * 0.92, 320)
      : 420;

    boardWrap.style.width = size + "px";
    boardWrap.style.height = size + "px";

    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.setSize(size, size);
}


// --- 既存のSocket.IOロジック (DOM手駒・ログ) ---

function addLog(s, isSystem = false){
  const t = new Date().toLocaleTimeString();
  const cls = isSystem ? ' class="system-msg"' : '';
  logEl.innerHTML = `<div${cls}>[${t}] ${escapeHtml(s)}</div>` + logEl.innerHTML;
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function renderHandDOM() {
    handContainer.innerHTML = ''; 
}

// 3D手駒を描画・管理する関数
function renderHands3D(players) {
    if (!isHandInitialized) initHandSlots();

    if (!players) return;

    ['Blue', 'Orange'].forEach(owner => {
        const pData = players[owner];
        // プレイヤーがいない場合、その手駒はすべて非表示にする
        if (!pData) {
            handSlots[owner].forEach(s => s.mesh.visible = false);
            return;
        }

        ['large', 'medium', 'small'].forEach(size => {
            const serverCount = pData.pieces[size] || 0;
            const slots = handSlots[owner].filter(s => s.size === size);
            const visibleSlots = slots.filter(s => s.mesh.visible);
            const diff = visibleSlots.length - serverCount;

            if (diff > 0) {
                let hiddenCount = 0;
                if (owner === mySlot && lastPlayedSlotId !== null) {
                    const target = visibleSlots.find(s => s.slotId === lastPlayedSlotId);
                    if (target) {
                        target.mesh.visible = false;
                        hiddenCount++;
                        lastPlayedSlotId = null; 
                    }
                }
                for (let i = visibleSlots.length - 1; i >= 0; i--) {
                    if (hiddenCount >= diff) break;
                    if (visibleSlots[i].mesh.visible) { 
                        visibleSlots[i].mesh.visible = false;
                        hiddenCount++;
                    }
                }

            } else if (diff < 0) {
                let showCount = 0;
                const needed = -diff; 
                for (let i = 0; i < slots.length; i++) {
                    if (showCount >= needed) break;
                    if (!slots[i].mesh.visible) {
                        slots[i].mesh.visible = true;
                        showCount++;
                    }
                }
            }
        });
    });
}

// --- モーダル関連イベント ---
if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
        if (gameActionsTab) gameActionsTab.style.display = 'block'; 
        modalOverlay.classList.remove('hidden');
        const envTab = document.querySelector('.tab-btn[data-tab="tab-env"]');
        if (envTab) envTab.click();
    });
}
if (homeSettingsBtn) {
    homeSettingsBtn.addEventListener('click', () => {
        if (gameActionsTab) gameActionsTab.style.display = 'none';
        const envTab = document.querySelector('.tab-btn[data-tab="tab-env"]');
        if (envTab) envTab.click(); 
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

if (modalLeaveBtn) {
    modalLeaveBtn.addEventListener('click', () => {
        // ★修正: サーバーへ退出を通知してからリロード
        if(confirm("退出してホームに戻りますか？")){
             socket.emit("leave_room");
             modalOverlay.classList.add('hidden');
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
                selectedMesh.material.color.set(0xffffff);
                selectedMesh = null;
                renderer.render(scene, camera);
            }
        }
    });
}

// --- リザルト画面の処理 ---
function showResult(winner) {
    resultOverlay.classList.remove('hidden');
    resultContent.classList.remove('lose'); 

    // 初期状態リセット
    resultWaitMsg.classList.add('hidden');
    [btnRematch, btnSpectate, btnLeave].forEach(b => {
        b.disabled = false;
        b.style.opacity = '1';
        b.style.cursor = 'pointer';
    });

    if (mySlot === 'spectator') {
        resultTitle.textContent = "GAME SET";
        resultMessage.textContent = `勝者: ${winner}`;
        playerActions.classList.add('hidden');
        spectatorActions.classList.remove('hidden');
    } else {
        // プレイヤーの場合
        playerActions.classList.remove('hidden');
        spectatorActions.classList.add('hidden');

        if (winner === mySlot) {
            resultTitle.textContent = "YOU WIN!";
            resultMessage.textContent = "おめでとうございます！";
            fireConfetti(); 
            playSE('win');
        } else {
            resultTitle.textContent = "YOU LOSE...";
            resultMessage.textContent = "ドンマイ！次は勝てます！";
            resultContent.classList.add('lose'); 
            playSE('lose');
        }
    }
}

// 決定ボタンを押した時のUI処理
function onDecisionMade(choice) {
    // ボタンを無効化
    [btnRematch, btnSpectate, btnLeave].forEach(b => {
        b.disabled = true;
        b.style.opacity = '0.5';
        b.style.cursor = 'not-allowed';
    });
    
    if (choice === 'leave') {
        socket.emit("leave_room");
        window.location.href = window.location.pathname; // ホームへ
        return;
    }

    // 待機メッセージ表示
    resultWaitMsg.classList.remove('hidden');
    
    // サーバーへ送信
    socket.emit("submit_decision", { choice });
}

btnRematch.addEventListener('click', () => onDecisionMade('rematch'));
btnSpectate.addEventListener('click', () => onDecisionMade('spectate'));
btnLeave.addEventListener('click', () => onDecisionMade('leave'));


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
    if (d && d.slot) {
        mySlot = d.slot;  
        meLabel.textContent = mySlot;
        addLog(`(System) Role Assigned: ${d.slot}`);
        
        // カメラ設定更新
        updateCameraForRole(mySlot);

        if (state) render(state);
    }
});

function updateCameraForRole(role) {
    if (role === 'Orange') {
        camera.position.set(0, 15, -18); 
        camera.lookAt(0, 0, 0);
    } else {
        // Blue or Spectator
        camera.position.set(0, 15, 18); 
        camera.lookAt(0, 0, 0);
    }
}

socket.on('start_game', (s) => {
  resultOverlay.classList.add('hidden'); // リザルトを閉じる
  addLog('ゲーム開始！');
  clearSelection();
  render(s);

   if (!mySlot || mySlot === 'spectator') {
    return; 
  }
   turnCutIn.classList.remove('hidden');
   if(s.currentTurn === mySlot) {
    cutinText.textContent = "あなたが【先攻】です！";
    cutinText.style.color = "#ff4757"; 
    turnCutIn.querySelector('.cutin-content').style.borderColor = "#ff4757";
   } else {
    cutinText.textContent = "あなたは【後攻】です";
    cutinText.style.color = "#2ed573"; 
    turnCutIn.querySelector('.cutin-content').style.borderColor = "#2ed573";
   }

   setTimeout(() => {
     turnCutIn.classList.add('hidden');
   }, 2000);
});
socket.on('update_state', (s) => {
    // 待機中に戻った場合はリザルトを消すかどうか？
    // 勝者が消えていればリセットとみなす
    if (!s.winner && !resultOverlay.classList.contains('hidden')) {
        // もし自分がSpectatorになっていて、前のゲームが終わったならリザルトを消す
        resultOverlay.classList.add('hidden');
    }
    render(s); 
});
socket.on('invalid_move', (d) => {
  addLog('不正手: ' + (d && d.reason ? d.reason : 'unknown'));
});
socket.on('game_over', (d) => {
  addLog('ゲーム終了: 勝者 = ' + d.winner);
  clearSelection();
  render(d.state);
  showResult(d.winner);
});
socket.on('system_message', (d) => {
  addLog(d.text, true);
});
socket.on('disconnect', () => {
  addLog('サーバー切断');
});

// --- 実行開始 ---
initThree(); 
buildBoard3D(); 
if (controls) controls.update(); 
renderer.render(scene, camera);