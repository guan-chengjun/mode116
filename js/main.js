// =============================================================
// 主程序：渲染器/灯光/相机机位/鼠标交互/UI 绑定/渲染循环
// =============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from './config.js';
import { Simulation } from './simulation.js';

// ---------- 基础场景 ----------
const app = document.getElementById('app');
const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.renderer.clearColor);
scene.fog = new THREE.Fog(CONFIG.lights.fogColor, CONFIG.lights.fogNear, CONFIG.lights.fogFar);

const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 200);
// 俯视机位需高角度越过 6.5m 高的车间外墙，避免墙面遮挡线体
camera.position.set(0, 20, 16);

const renderer = new THREE.WebGLRenderer({ antialias: CONFIG.renderer.antialias });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.renderer.pixelRatioCap));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
app.appendChild(renderer.domElement);

// 鼠标控制：左键环绕、滚轮缩放、右键平移
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 2;
controls.maxDistance = 55;
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- 灯光（参数集中在 CONFIG.lights） ----------
const L = CONFIG.lights;
scene.add(new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemiIntensity));
scene.add(new THREE.AmbientLight(0xffffff, L.ambientIntensity));
const dirLight = new THREE.DirectionalLight(L.dirColor, L.dirIntensity);
dirLight.position.set(...L.dirPosition);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(CONFIG.renderer.shadowMapSize, CONFIG.renderer.shadowMapSize);
dirLight.shadow.camera.left = -22;
dirLight.shadow.camera.right = 22;
dirLight.shadow.camera.top = 18;
dirLight.shadow.camera.bottom = -18;
dirLight.shadow.camera.far = 60;
scene.add(dirLight);

// ---------- 仿真实例 ----------
const sim = new Simulation(scene);

// ---------- 相机机位管理 ----------
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const cameraMode = { current: 'overview', fly: null, closeupIdx: 0 };

function flyTo(pos, target) {
  cameraMode.fly = {
    t: 0,
    fromPos: camera.position.clone(),
    fromTarget: controls.target.clone(),
    toPos: pos.clone(),
    toTarget: target.clone(),
  };
}

function switchCameraMode(mode) {
  cameraMode.current = mode;
  document.querySelectorAll('.cam-btn').forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));

  if (mode === 'overview') {
    flyTo(new THREE.Vector3(0, 20, 16), new THREE.Vector3(0, 0.8, 0));
  } else if (mode === 'closeup') {
    jumpToStation(cameraMode.closeupIdx);
  } else if (mode === 'follow') {
    cameraMode.followId = null;
    const b = sim.getFollowBottle();
    if (!b) { showToast('当前线上没有瓶子，启动后自动跟随', 'warn'); }
    // 直接把视角放到瓶旁，后续每帧随瓶子平移
    const target = b ? new THREE.Vector3(b.x, CONFIG.belt.topY + 0.6, b.z) : controls.target.clone();
    if (b) cameraMode.followId = b.id;
    flyTo(target.clone().add(new THREE.Vector3(0, 3.2, 4.4)), target);
  }
}

/** 工位特写机位 */
function jumpToStation(idx) {
  const st = sim.stations[idx];
  if (!st) return;
  cameraMode.closeupIdx = idx;
  flyTo(
    new THREE.Vector3(st.x, 3.4, 5.2),
    new THREE.Vector3(st.x, CONFIG.belt.topY + 0.8, 0)
  );
}

function updateCamera(dt) {
  // 飞行过渡
  if (cameraMode.fly) {
    cameraMode.fly.t += dt / 1.1;
    const k = easeInOutCubic(Math.min(1, cameraMode.fly.t));
    camera.position.lerpVectors(cameraMode.fly.fromPos, cameraMode.fly.toPos, k);
    controls.target.lerpVectors(cameraMode.fly.fromTarget, cameraMode.fly.toTarget, k);
    if (cameraMode.fly.t >= 1) cameraMode.fly = null;
  }

  // 跟随单瓶：保持用户环绕角，整体随瓶子平滑平移；瓶离场后切换新瓶
  if (cameraMode.current === 'follow' && cameraMode.fly === null) {
    let b = cameraMode.followId != null ? sim.getBottleById(cameraMode.followId) : null;
    if (!b) {
      b = sim.getFollowBottle();
      if (b) cameraMode.followId = b.id;
    }
    if (b) {
      const desired = new THREE.Vector3(b.x, CONFIG.belt.topY + 0.6, b.z);
      const delta = desired.sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
      controls.target.add(delta);
      camera.position.add(delta);
    }
  }
}

// ---------- 点击工位查看信息（区分拖拽与点击） ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 6) return; // 拖拽环绕，不触发点击
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(sim.stations.map((s) => s.wrapper), true);
  if (hits.length) {
    let obj = hits[0].object;
    while (obj && !obj.userData.station) obj = obj.parent;
    if (obj && obj.userData.station) showStationInfo(obj.userData.station);
  }
});

// ---------- DOM 工具 ----------
const $ = (id) => document.getElementById(id);
const stateText = { idle: '待机', run: '运行', block: '堵塞' };

function showToast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function showStationInfo(st) {
  const mode = sim.estop ? 'block' : (sim.running ? st.state : 'idle');
  $('info-name').textContent = st.name;
  $('info-status').textContent = stateText[mode];
  $('info-desc').textContent = st.desc;
  $('info-card').hidden = false;
  // 特写机位下点击工位可直接跳转
  if (cameraMode.current === 'closeup') {
    const idx = sim.stations.findIndex((s) => s.key === st.key);
    if (idx >= 0) jumpToStation(idx);
  }
}

// ---------- UI 绑定 ----------
function refreshButtons() {
  $('btn-start').disabled = sim.running || sim.estop;
  $('btn-pause').disabled = !sim.running;
  $('btn-estop').classList.toggle('flashing', sim.estop);
}

$('btn-start').addEventListener('click', () => { sim.start(); refreshButtons(); });
$('btn-pause').addEventListener('click', () => { sim.pause(); refreshButtons(); });
$('btn-estop').addEventListener('click', () => {
  sim.estopLine();
  refreshButtons();
  showToast('急停已触发：全线停止，按复位清除', 'warn');
});
$('btn-reset').addEventListener('click', () => {
  sim.reset();
  refreshButtons();
  // 清空故障日志并恢复占位
  const ul = $('fault-log');
  ul.innerHTML = '<li class="log-empty">暂无故障记录</li>';
  showToast('系统已复位');
});

$('speed-range').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  sim.setSpeedFactor(v);
  $('speed-val').textContent = v.toFixed(1) + '×';
});
$('cap-select').addEventListener('change', (e) => sim.setCapacity(e.target.value));
$('color-select').addEventListener('change', (e) => sim.setBottleColor(e.target.value));
$('fault-check').addEventListener('change', (e) => sim.setFaultEnabled(e.target.checked));
$('wall-check').addEventListener('change', (e) => sim.setWallsVisible(!e.target.checked));

document.querySelectorAll('.cam-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchCameraMode(btn.dataset.cam));
});
$('info-close').addEventListener('click', () => { $('info-card').hidden = true; });

// 故障日志（仿真事件回调）
sim.onEvent = (ev) => {
  if (ev.type !== 'fault') return;
  const ul = $('fault-log');
  ul.querySelector('.log-empty')?.remove();
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  li.textContent = `${t}｜${ev.station}｜#${ev.bottleId} 瓶：${ev.reason}，已剔出`;
  ul.prepend(li);
  while (ul.children.length > 6) ul.lastElementChild.remove();
  showToast(`${ev.station}故障：${ev.reason}，问题瓶已剔除`, 'warn');
};

// 模型兜底提示
sim.onModelFallback = (name) => showToast(`${name} glTF 加载失败，已启用几何体兜底模型`, 'warn');

// ---------- 工位状态列表 ----------
function buildStationList() {
  const ul = $('station-list');
  ul.innerHTML = '';
  for (const st of sim.getStationStates()) {
    const li = document.createElement('li');
    li.dataset.key = st.key;
    li.innerHTML = `<span class="station-dot"></span><span class="station-name">${st.name}</span><span class="station-state">待机</span>`;
    li.style.cursor = 'pointer';
    li.addEventListener('click', () => {
      const full = sim.stations.find((s) => s.key === st.key);
      showStationInfo(full);
    });
    ul.appendChild(li);
  }
}

function refreshStats() {
  const s = sim.getStats();
  $('stat-speed').textContent = s.beltSpeed.toFixed(1) + ' m/min';
  $('stat-filled').textContent = s.filled;
  $('stat-good').textContent = s.good;
  $('stat-reject').textContent = s.reject;
  $('stat-pass').textContent = s.passRate.toFixed(1) + '%';

  for (const st of sim.getStationStates()) {
    const li = document.querySelector(`#station-list li[data-key="${st.key}"]`);
    if (!li) continue;
    const dot = li.querySelector('.station-dot');
    dot.className = 'station-dot ' + (st.state === 'idle' ? '' : st.state);
    li.querySelector('.station-state').textContent = stateText[st.state];
  }
}

// ---------- 自适应 ----------
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 渲染循环 ----------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  sim.update(dt);
  updateCamera(dt);
  controls.update();
  renderer.render(scene, camera);
}

// ---------- 启动 ----------
sim.init().then(() => {
  buildStationList();
  refreshButtons();
  setInterval(refreshStats, 250); // 数据刷新降频，避免频繁操作 DOM
  animate();
  // 调试钩子：URL 带 #autostart 时自动开线（便于无人值守验证）
  if (location.hash.includes('autostart')) {
    sim.start();
    refreshButtons();
    // 无头浏览器虚拟时间模式下 rAF 触发极少，用定时器补驱动仿真（正常浏览器仍由 rAF 驱动）
    if (location.hash.includes('headless')) {
      let acc = 0;
      setInterval(() => { acc += 0.05; sim.update(0.05); refreshStats(); }, 50);
    }
  }
});
