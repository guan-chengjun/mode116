// =============================================================
// 模型工厂：几何体兜底建模 + glTF 加载（加载失败自动回退）
// =============================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CONFIG } from './config.js';

const BELT_TOP = CONFIG.belt.topY;

// ---------- 共享材质 ----------
export const MAT = {
  frame: new THREE.MeshStandardMaterial({ color: 0x8a95a1, metalness: 0.65, roughness: 0.42 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x3a4754, metalness: 0.45, roughness: 0.5 }),
  cabinet: new THREE.MeshStandardMaterial({ color: 0xd8dde3, metalness: 0.25, roughness: 0.55 }),
  tunnel: new THREE.MeshStandardMaterial({ color: 0x22303d, metalness: 0.3, roughness: 0.7 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf0c33c, metalness: 0.2, roughness: 0.5 }),
  red: new THREE.MeshStandardMaterial({ color: 0xd24b42, metalness: 0.2, roughness: 0.45 }),
  metal: new THREE.MeshStandardMaterial({ color: 0xb8c0c9, metalness: 0.85, roughness: 0.28 }),
  glassPanel: new THREE.MeshStandardMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.35, roughness: 0.15 }),
  liquid: new THREE.MeshStandardMaterial({ color: 0xd89526, transparent: true, opacity: 0.78, roughness: 0.2 }),
  cap: new THREE.MeshStandardMaterial({ color: 0x4a6b3a, metalness: 0.7, roughness: 0.35 }),
  lampOff: new THREE.MeshStandardMaterial({ color: 0x555f68, emissive: 0x000000 }),
};

// 状态指示灯颜色（待机/运行/堵塞）
export const LAMP_COLORS = {
  idle: 0x9aa6b2,
  run: 0x2e9e5b,
  block: 0xd24b42,
};

// 瓶身状态环颜色：空瓶/半满/满瓶/成品/剔除
export const RING_COLORS = {
  empty: 0x9aa6b2,
  half: 0x4aa3ff,
  full: 0x2f78c4,
  product: 0x2e9e5b,
  reject: 0xd24b42,
};

// ---------- 基础工具 ----------
function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function cyl(rt, rb, h, mat, seg = 20) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 递归开启阴影 */
export function setShadow(obj) {
  obj.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  return obj;
}

// ---------- Canvas 文字纹理（工位标牌 / 瓶身标签） ----------
export function makeTextTexture(text, bg = '#2f78c4', fg = '#ffffff', w = 512, h = 128) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, w - 12, h - 12);
  ctx.fillStyle = fg;
  ctx.font = `bold ${Math.floor(h * 0.46)}px "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function makeBottleLabelTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 160;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f6efdd';
  ctx.fillRect(0, 0, 256, 160);
  ctx.fillStyle = '#b53a2e';
  ctx.fillRect(0, 0, 256, 26);
  ctx.fillRect(0, 134, 256, 26);
  ctx.fillStyle = '#7a4a1e';
  ctx.font = 'bold 44px "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('纯生啤酒', 128, 86);
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#9a7a52';
  ctx.fillText('FRESH BEER', 128, 118);
  return new THREE.CanvasTexture(c);
}

/** 输送带条纹纹理（随链条滚动做 UV 偏移动画） */
function makeBeltTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2b333c';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#46525e';
  ctx.lineWidth = 10;
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + 128, 128);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 1);
  return tex;
}

// =============================================================
// 瓶子模型：玻璃瓶 + 半透明液体 + 标签 + 瓶盖 + 状态环
// =============================================================
const glassCache = {};
/** 按配色名取（或惰性创建）共享玻璃材质，避免切换配色时污染缓存 */
export function getGlassMat(colorName) {
  if (!glassCache[colorName]) {
    glassCache[colorName] = new THREE.MeshStandardMaterial({
      color: CONFIG.bottleColors[colorName],
      transparent: true,
      opacity: 0.38,
      roughness: 0.12,
      metalness: 0,
      depthWrite: false,
    });
  }
  return glassCache[colorName];
}

export function createBottle(capacityName, colorName) {
  const { r, h } = CONFIG.capacity[capacityName];
  const g = new THREE.Group();

  // —— 瓶身（车削曲面）——
  const pts = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(r * 0.85, 0),
    new THREE.Vector2(r, h * 0.06),
    new THREE.Vector2(r, h * 0.7),
    new THREE.Vector2(r * 0.92, h * 0.77),
    new THREE.Vector2(r * 0.46, h * 0.85),
    new THREE.Vector2(r * 0.42, h * 0.97),
    new THREE.Vector2(r * 0.5, h),
    new THREE.Vector2(0, h),
  ];
  const glass = new THREE.Mesh(new THREE.LatheGeometry(pts, 24), getGlassMat(colorName));
  glass.castShadow = true;
  g.add(glass);

  // —— 液体（半透明，scale.y 即液位 0~1）——
  const liqH = h * 0.66;
  const liquid = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.86, r * 0.88, liqH, 20), MAT.liquid);
  liquid.position.y = 0.04 + liqH / 2;
  liquid.scale.y = 0.001;
  liquid.visible = false;
  liquid.castShadow = true;
  g.add(liquid);

  // —— 瓶身标签（圆柱弧面）——
  const labelMat = new THREE.MeshStandardMaterial({
    map: makeBottleLabelTexture(),
    side: THREE.DoubleSide,
    roughness: 0.6,
  });
  const label = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 1.015, r * 1.015, h * 0.24, 20, 1, true, -0.9, 1.8),
    labelMat
  );
  label.position.y = h * 0.46;
  label.castShadow = true;
  g.add(label);

  // —— 瓶盖（压盖后显示）——
  const cap = cyl(r * 0.52, r * 0.55, 0.09, MAT.cap, 18);
  cap.position.y = h + 0.02;
  cap.visible = false;
  g.add(cap);

  // —— 状态环（区分空瓶/半满/满瓶/成品/剔除）——
  const ringMat = new THREE.MeshStandardMaterial({ color: RING_COLORS.empty, emissive: RING_COLORS.empty, emissiveIntensity: 0.35 });
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.28, r * 1.28, 0.022, 24), ringMat);
  ring.position.y = 0.012;
  g.add(ring);

  return { group: g, refs: { liquid, liqH, label, cap, ring, glass }, size: { r, h } };
}

// =============================================================
// 主输送链：链板 + 护栏 + 机架 + 端部滚筒
// =============================================================
export function createConveyor() {
  const g = new THREE.Group();
  const L = CONFIG.belt.length;

  // 链板（带条纹纹理，运行时滚动 UV）
  const beltMat = new THREE.MeshStandardMaterial({ map: makeBeltTexture(), roughness: 0.85 });
  const belt = box(L, 0.18, CONFIG.belt.width, beltMat);
  belt.position.y = BELT_TOP - 0.09;
  g.add(belt);

  // 下层回程罩板
  const skirt = box(L, 0.12, CONFIG.belt.width * 0.82, MAT.dark);
  skirt.position.y = BELT_TOP - 0.42;
  g.add(skirt);

  // 两侧机架梁
  for (const z of [-(CONFIG.belt.width / 2 + 0.06), CONFIG.belt.width / 2 + 0.06]) {
    const beam = box(L, 0.14, 0.1, MAT.frame);
    beam.position.set(0, BELT_TOP - 0.02, z);
    g.add(beam);
  }

  // 护栏（高出链板的细杆 + 立柱）
  for (const z of [-0.62, 0.62]) {
    const rail = box(L, 0.06, 0.06, MAT.metal);
    rail.position.set(0, BELT_TOP + 0.28, z);
    g.add(rail);
    for (let x = -L / 2 + 0.6; x < L / 2; x += 2.4) {
      const post = box(0.05, 0.34, 0.05, MAT.frame);
      post.position.set(x, BELT_TOP + 0.13, z);
      g.add(post);
    }
  }

  // 支腿
  for (let x = -L / 2 + 1.2; x < L / 2; x += 3.2) {
    for (const z of [-0.42, 0.42]) {
      const leg = box(0.12, BELT_TOP - 0.18, 0.12, MAT.frame);
      leg.position.set(x, (BELT_TOP - 0.18) / 2, z);
      g.add(leg);
    }
  }

  // 端部驱动滚筒（旋转动画）
  const rollers = [];
  for (const x of [-L / 2, L / 2]) {
    const roller = cyl(0.16, 0.16, CONFIG.belt.width, MAT.metal, 20);
    roller.rotation.x = Math.PI / 2;
    roller.position.set(x, BELT_TOP - 0.09, 0);
    g.add(roller);
    rollers.push(roller);
  }

  // —— 小型电控柜（线体旁）——
  const cabinet = box(0.9, 1.35, 0.5, MAT.cabinet);
  cabinet.position.set(-15.2, 0.675, 1.25);
  g.add(cabinet);
  const cabDoor = box(0.7, 1.05, 0.03, MAT.frame);
  cabDoor.position.set(-15.2, 0.72, 1.51);
  g.add(cabDoor);
  const cabLamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10),
    new THREE.MeshStandardMaterial({ color: LAMP_COLORS.run, emissive: LAMP_COLORS.run, emissiveIntensity: 0.8 }));
  cabLamp.position.set(-14.85, 1.28, 1.51);
  g.add(cabLamp);

  return { group: g, refs: { belt, rollers, beltMat } };
}

// =============================================================
// 旁侧回收道（剔出的问题瓶在此排走）
// =============================================================
export function createRecycleBelt() {
  const g = new THREE.Group();
  const z = CONFIG.recycle.z;
  const beltMat = new THREE.MeshStandardMaterial({ map: makeBeltTexture(), roughness: 0.85 });
  beltMat.map.repeat.set(14, 1);

  const belt = box(24, 0.14, 0.7, beltMat);
  belt.position.set(0, BELT_TOP - 0.07, z);
  g.add(belt);
  for (const zz of [z - 0.4, z + 0.4]) {
    const rail = box(24, 0.05, 0.05, MAT.metal);
    rail.position.set(0, BELT_TOP + 0.2, zz);
    g.add(rail);
  }
  // 回收斗
  const bin = box(1.4, 0.9, 0.9, MAT.dark);
  bin.position.set(12.6, 0.45, z);
  g.add(bin);
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.4),
    new THREE.MeshStandardMaterial({ map: makeTextTexture('次品回收道', '#8a3a34'), side: THREE.DoubleSide })
  );
  sign.position.set(12.6, 1.35, z + 0.46);
  g.add(sign);

  return { group: g, refs: { beltMat } };
}

// =============================================================
// 通用：状态灯柱、工位标牌、拨杆
// =============================================================
function makeLampPost() {
  const g = new THREE.Group();
  const pole = cyl(0.035, 0.035, 0.7, MAT.frame, 10);
  pole.position.y = 0.35;
  g.add(pole);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), MAT.lampOff.clone());
  lamp.position.y = 0.78;
  g.add(lamp);
  return { group: g, lamp };
}

function makeSign(text) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(2.3, 0.55),
    new THREE.MeshStandardMaterial({ map: makeTextTexture(text), side: THREE.DoubleSide })
  );
}

/** 剔瓶拨杆：初始位于主线远侧，动作时横移把瓶子推向回收道 */
function makePusher() {
  const g = new THREE.Group();
  const arm = box(0.12, 0.5, 0.12, MAT.yellow);
  arm.position.y = 0.25;
  g.add(arm);
  const plate = box(0.1, 0.42, 0.55, MAT.yellow);
  plate.position.set(0, 0.32, 0.3);
  g.add(plate);
  g.position.set(0, BELT_TOP, -0.78);
  return g;
}

/** 星轮（圆盘 + 6 个拨齿），绕 Y 轴旋转 */
function makeStarWheel(radius = 0.42) {
  const g = new THREE.Group();
  const disc = cyl(radius, radius, 0.06, MAT.metal, 24);
  g.add(disc);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const tooth = box(0.12, 0.08, 0.22, MAT.frame);
    tooth.position.set(Math.cos(a) * radius * 0.8, 0, Math.sin(a) * radius * 0.8);
    tooth.rotation.y = -a;
    g.add(tooth);
  }
  g.position.y = BELT_TOP + 0.06;
  return g;
}

// =============================================================
// 工位 1：洗瓶机
// =============================================================
function buildWasher() {
  const g = new THREE.Group();
  const refs = { stars: [], rollers: [] };

  const base = box(2.8, 0.3, 1.9, MAT.frame);
  base.position.y = BELT_TOP - 0.15;
  g.add(base);

  // 冲洗舱（中部留深色贯通隧道）
  const body = box(2.3, 1.9, 1.7, MAT.cabinet);
  body.position.y = BELT_TOP + 0.95;
  g.add(body);
  const tunnel = box(2.34, 0.75, 0.62, MAT.tunnel);
  tunnel.position.y = BELT_TOP + 0.32;
  g.add(tunnel);

  // 顶部喷管与喷嘴
  for (const dx of [-0.6, 0, 0.6]) {
    const pipe = cyl(0.03, 0.03, 0.8, MAT.metal, 10);
    pipe.position.set(dx, BELT_TOP + 1.5, 0);
    g.add(pipe);
    const nozzle = cyl(0.05, 0.02, 0.12, MAT.metal, 10);
    nozzle.position.set(dx, BELT_TOP + 1.05, 0);
    g.add(nozzle);
  }

  // 进出瓶星轮
  for (const dx of [-1.15, 1.15]) {
    const star = makeStarWheel(0.4);
    star.position.x = dx;
    g.add(star);
    refs.stars.push(star);
  }

  refs.pusher = makePusher();
  g.add(refs.pusher);

  const { group: lampPost, lamp } = makeLampPost();
  lampPost.position.set(0.95, BELT_TOP + 1.9, 0.7);
  g.add(lampPost);
  refs.lamp = lamp;

  const sign = makeSign('洗瓶机');
  sign.position.set(0, BELT_TOP + 2.55, 0.86);
  g.add(sign);

  return { group: setShadow(g), refs };
}

// =============================================================
// 工位 2：多头灌装机（六阀旋转灌装头，整体下行注液）
// =============================================================
function buildFiller() {
  const g = new THREE.Group();
  const refs = { valves: [] };

  const base = box(2.8, 0.3, 1.9, MAT.frame);
  base.position.y = BELT_TOP - 0.15;
  g.add(base);

  // 四根立柱 + 顶部平台
  for (const dx of [-1.1, 1.1]) {
    for (const dz of [-0.7, 0.7]) {
      const col = box(0.14, 2.1, 0.14, MAT.frame);
      col.position.set(dx, BELT_TOP + 1.05, dz);
      g.add(col);
    }
  }
  const platform = box(2.6, 0.18, 1.7, MAT.cabinet);
  platform.position.y = BELT_TOP + 2.15;
  g.add(platform);

  // 储液罐
  const tank = cyl(0.5, 0.5, 0.9, MAT.metal, 24);
  tank.position.y = BELT_TOP + 2.7;
  g.add(tank);

  // —— 灌装头总成（整体上下往复 + 转盘旋转）——
  const head = new THREE.Group();
  head.position.y = BELT_TOP + 1.55;
  const carousel = new THREE.Group();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const valve = cyl(0.05, 0.05, 0.75, MAT.metal, 12);
    valve.position.set(Math.cos(a) * 0.42, -0.32, Math.sin(a) * 0.42);
    carousel.add(valve);
    refs.valves.push(valve);
    const tip = cyl(0.03, 0.03, 0.16, MAT.dark, 10);
    tip.position.set(Math.cos(a) * 0.42, -0.74, Math.sin(a) * 0.42);
    carousel.add(tip);
  }
  head.add(carousel);
  g.add(head);
  refs.head = head;
  refs.carousel = carousel;

  // 进瓶星轮
  const star = makeStarWheel(0.4);
  star.position.x = -1.25;
  g.add(star);
  refs.stars = [star];

  refs.pusher = makePusher();
  g.add(refs.pusher);

  const { group: lampPost, lamp } = makeLampPost();
  lampPost.position.set(1.0, BELT_TOP + 2.15, 0.72);
  g.add(lampPost);
  refs.lamp = lamp;

  const sign = makeSign('多头灌装机');
  sign.position.set(0, BELT_TOP + 3.35, 0.86);
  g.add(sign);

  return { group: setShadow(g), refs };
}

// =============================================================
// 工位 3：压盖机（压盖头下行扣皇冠盖）
// =============================================================
function buildCapper() {
  const g = new THREE.Group();
  const refs = {};

  const base = box(2.4, 0.3, 1.8, MAT.frame);
  base.position.y = BELT_TOP - 0.15;
  g.add(base);

  // 龙门架
  for (const dx of [-0.9, 0.9]) {
    const col = box(0.16, 2.2, 0.16, MAT.frame);
    col.position.set(dx, BELT_TOP + 1.1, 0);
    g.add(col);
  }
  const beam = box(2.0, 0.2, 0.5, MAT.frame);
  beam.position.set(0, BELT_TOP + 2.2, 0);
  g.add(beam);

  // 理盖斗（倒锥）+ 滑道
  const hopper = cyl(0.12, 0.42, 0.55, MAT.metal, 20);
  hopper.position.set(0.75, BELT_TOP + 2.55, 0);
  g.add(hopper);
  const chute = box(0.1, 0.7, 0.1, MAT.metal);
  chute.position.set(0.42, BELT_TOP + 1.95, 0);
  chute.rotation.z = 0.5;
  g.add(chute);

  // —— 压盖头（往复下行）——
  const ram = new THREE.Group();
  const rod = cyl(0.05, 0.05, 0.7, MAT.metal, 12);
  rod.position.y = 0.15;
  ram.add(rod);
  const press = cyl(0.16, 0.2, 0.16, MAT.dark, 18);
  press.position.y = -0.28;
  ram.add(press);
  ram.position.set(0, BELT_TOP + 1.55, 0);
  g.add(ram);
  refs.ram = ram;

  const star = makeStarWheel(0.38);
  star.position.x = -1.05;
  g.add(star);
  refs.stars = [star];

  refs.pusher = makePusher();
  g.add(refs.pusher);

  const { group: lampPost, lamp } = makeLampPost();
  lampPost.position.set(0.95, BELT_TOP + 2.2, 0.68);
  g.add(lampPost);
  refs.lamp = lamp;

  const sign = makeSign('压盖机');
  sign.position.set(0, BELT_TOP + 3.05, 0.86);
  g.add(sign);

  return { group: setShadow(g), refs };
}

// =============================================================
// 工位 4：贴标机（送标滚轮 + 刷标轮把标签贴到瓶身侧面）
// =============================================================
function buildLabeler() {
  const g = new THREE.Group();
  const refs = { rollers: [] };

  const base = box(2.6, 0.3, 1.9, MAT.frame);
  base.position.y = BELT_TOP - 0.15;
  g.add(base);

  const body = box(2.1, 1.6, 1.5, MAT.cabinet);
  body.position.set(-0.2, BELT_TOP + 0.8, 0.15);
  g.add(body);
  const tunnel = box(2.14, 0.7, 0.6, MAT.tunnel);
  tunnel.position.set(-0.2, BELT_TOP + 0.3, 0.15);
  g.add(tunnel);

  // 标签卷（大滚轮）+ 导向小滚轮，绕 Z 轴旋转
  function roller(radius, x, y, z, width = 0.16) {
    const m = cyl(radius, radius, width, MAT.metal, 22);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    g.add(m);
    refs.rollers.push(m);
    return m;
  }
  roller(0.34, -0.85, BELT_TOP + 1.45, 0.78);
  roller(0.14, -0.35, BELT_TOP + 1.25, 0.78);
  roller(0.14, 0.15, BELT_TOP + 1.25, 0.78);

  // 刷标轮（竖直圆盘，贴标时旋转）
  const brush = cyl(0.3, 0.3, 0.1, MAT.yellow, 22);
  brush.rotation.x = Math.PI / 2;
  brush.position.set(0.45, BELT_TOP + 0.55, 0.62);
  g.add(brush);
  refs.rollers.push(brush);

  refs.pusher = makePusher();
  g.add(refs.pusher);

  const { group: lampPost, lamp } = makeLampPost();
  lampPost.position.set(0.95, BELT_TOP + 1.7, 0.72);
  g.add(lampPost);
  refs.lamp = lamp;

  const sign = makeSign('贴标机');
  sign.position.set(0, BELT_TOP + 2.5, 0.86);
  g.add(sign);

  return { group: setShadow(g), refs };
}

/** 按工位 key 创建兜底几何体模型 */
export function buildStationFallback(key) {
  switch (key) {
    case 'washer': return buildWasher();
    case 'filler': return buildFiller();
    case 'capper': return buildCapper();
    case 'labeler': return buildLabeler();
    default: throw new Error('未知工位：' + key);
  }
}

// =============================================================
// 车间环境：地面、通道线、浅色墙面与采光窗、顶灯
// =============================================================
export function createWorkshop() {
  const { length: L, width: W, wallHeight: H } = CONFIG.room;
  const g = new THREE.Group();
  const walls = new THREE.Group();

  // 地面
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(L, W),
    new THREE.MeshStandardMaterial({ color: CONFIG.room.floorColor, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  g.add(floor);

  // 通道线（黄色虚线，沿输送带两侧）
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xf0c33c, roughness: 0.7 });
  for (const z of [-1.75, 1.75]) {
    for (let x = -L / 2 + 1; x < L / 2; x += 1.6) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.12), lineMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.012, z);
      g.add(dash);
    }
  }
  // 端部横向通道线
  for (const x of [-17.2, 17.2]) {
    for (let z = -W / 2 + 1; z < W / 2; z += 1.4) {
      const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.8), lineMat);
      dash.rotation.x = -Math.PI / 2;
      dash.position.set(x, 0.013, z);
      g.add(dash);
    }
  }

  // 墙面 + 采光窗
  const wallMat = new THREE.MeshStandardMaterial({ color: CONFIG.room.wallColor, roughness: 0.95 });
  const winMat = new THREE.MeshStandardMaterial({
    color: 0xcfe6f7, emissive: 0xaad4f2, emissiveIntensity: 0.55, roughness: 0.3,
  });
  for (const z of [-W / 2, W / 2]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(L, H, 0.24), wallMat);
    wall.position.set(0, H / 2, z);
    wall.receiveShadow = true;
    walls.add(wall);
    // 采光窗带
    for (let x = -L / 2 + 3; x < L / 2 - 1; x += 4) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.5), winMat);
      win.position.set(x, H * 0.62, z + (z < 0 ? 0.13 : -0.13));
      win.rotation.y = z < 0 ? 0 : Math.PI;
      walls.add(win);
    }
  }
  // 两侧端墙
  for (const x of [-L / 2, L / 2]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(0.24, H, W), wallMat);
    wall.position.set(x, H / 2, 0);
    walls.add(wall);
  }
  g.add(walls);

  // 厂房顶灯（发光灯条）
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.9 });
  for (let x = -15; x <= 15; x += 6) {
    for (const z of [-3.6, 3.6]) {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.5), lampMat);
      lamp.position.set(x, H - 0.5, z);
      g.add(lamp);
    }
  }

  return { group: g, walls };
}

// =============================================================
// glTF 加载：统一资源入口，失败时返回 null 由调用方兜底
// =============================================================
const gltfLoader = new GLTFLoader();

export function loadGLTF(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, (gltf) => resolve(gltf), undefined, (err) => reject(err));
  });
}

/**
 * 尝试加载工位 glTF 模型并归一化：
 * 1. 居中并贴地  2. 缩放到目标尺寸  3. 开启阴影
 * 加载失败（404/网络错误）返回 null，调用方改用几何体兜底
 */
export async function tryLoadStationModel(url, targetHeight = 3.2) {
  try {
    const gltf = await loadGLTF(url);
    const model = gltf.scene;
    const box3 = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    box3.getSize(size);
    const scale = targetHeight / Math.max(size.x, size.y, size.z);
    model.scale.setScalar(scale);
    // 重新计算包围盒后居中到原点、贴地
    const box2 = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    box2.getCenter(center);
    model.position.sub(center);
    model.position.y -= box2.min.y - center.y;
    return setShadow(model);
  } catch (err) {
    console.warn(`[模型加载失败] ${url} → 启用几何体兜底`, err);
    return null;
  }
}
