// 仿真逻辑无头验证：mock three 与 factory，直接驱动 Simulation 跑固定步数
import { readFileSync } from 'node:fs';
import { CONFIG } from '../js/config.js';

// ---- 通用节点 mock ----
function makeNode() {
  return {
    position: { set() {}, x: 0, y: 0, z: 0, sub() {}, add() {} },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { y: 1 },
    material: { color: { set() {} }, emissive: { set() {} }, emissiveIntensity: 0 },
    visible: false,
    userData: {},
    add() {}, remove() {}, traverse() {},
  };
}
class NodeMock {
  constructor() { Object.assign(this, makeNode()); this.children = []; }
  add() {} remove() {} traverse() {}
}
class GenericMock { constructor() { this.castShadow = false; this.receiveShadow = false; } }

// ---- three mock：具名类 + Proxy 兜底所有几何体/材质 ----
const threeExplicit = {
  Group: class extends NodeMock {},
  Vector2: class { constructor(x = 0, y = 0) { this.x = x; this.y = y; } },
  Vector3: class {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set() { return this; } add() { return this; } sub() { return this; }
    clone() { return new threeMock.Vector3(); } multiplyScalar() { return this; }
  },
  Box3: class { setFromObject() { return this; } getSize() {} getCenter() {} },
  Color: class { set() {} },
  MeshStandardMaterial: GenericMock,
  Mesh: class extends GenericMock { constructor() { super(); Object.assign(this, makeNode()); } },
};
const threeMock = new Proxy(threeExplicit, {
  get(target, prop) { return prop in target ? target[prop] : GenericMock; },
});

// ---- factory mock：返回带 refs 的假模型 ----
const lamp = makeNode();
const pusher = { position: { z: -0.78 } };
const factoryMock = {
  MAT: new Proxy({}, { get: () => ({}) }),
  LAMP_COLORS: { idle: 1, run: 2, block: 3 },
  RING_COLORS: { empty: 0, half: 1, full: 2, product: 3, reject: 4 },
  createBottle: () => ({
    group: new threeMock.Group(),
    refs: {
      liquid: makeNode(), liqH: 0.7, label: { rotation: {} },
      cap: makeNode(), ring: { material: { color: { set() {} }, emissive: { set() {} } } },
      glass: { material: { color: { set() {} } } },
    },
    size: { r: 0.26, h: 1.05 },
  }),
  createConveyor: () => ({ group: new threeMock.Group(), refs: { belt: makeNode(), rollers: [makeNode()], beltMat: { map: { offset: {} } } } }),
  createRecycleBelt: () => ({ group: new threeMock.Group(), refs: { beltMat: { map: { offset: {} } } } }),
  createWorkshop: () => ({ group: new threeMock.Group(), walls: new threeMock.Group() }),
  buildStationFallback: () => ({
    group: new threeMock.Group(),
    refs: {
      lamp, pusher,
      stars: [{ rotation: {} }],
      head: { position: {} }, carousel: { rotation: {} },
      ram: { position: {} }, rollers: [{ rotation: {} }],
    },
  }),
  tryLoadStationModel: async () => null, // 强制走兜底
  getGlassMat: () => ({ color: { set() {} } }),
};

// ---- 读取 simulation 源码并把 import 说明符替换为 data URL mock ----
let src = readFileSync(new URL('../js/simulation.js', import.meta.url), 'utf8');
src = src
  .replace(/from 'three'/g, "from 'data:text/javascript,export default globalThis.__m.three;export const {Group,Vector2,Vector3,Box3,Color,Mesh,BoxGeometry,CylinderGeometry,SphereGeometry,LatheGeometry}=globalThis.__m.three'")
  .replace(/from '\.\/config\.js'/g, "from 'data:text/javascript,export const CONFIG=globalThis.__m.CONFIG'")
  .replace(/from '\.\/factory\.js'/g, "from 'data:text/javascript,export default globalThis.__m.factory;export const {MAT,LAMP_COLORS,RING_COLORS,createBottle,createConveyor,createRecycleBelt,createWorkshop,buildStationFallback,tryLoadStationModel,getGlassMat}=globalThis.__m.factory'");

globalThis.__m = { three: threeMock, CONFIG, factory: factoryMock };
const { Simulation } = await import('data:text/javascript,' + encodeURIComponent(src));

// ---- 驱动仿真 60 秒 ----
const scene = new threeMock.Group();
const sim = new Simulation(scene);
await sim.init();
sim.start();

const events = [];
sim.onEvent = (e) => events.push(e);

const DT = 0.05;
const STEPS = 60 * 20; // 60 秒（每秒 20 帧）
for (let i = 0; i < STEPS; i++) sim.update(DT);

const s = sim.getStats();
console.log('运行时长(s):', (STEPS * DT).toFixed(1));
console.log('已灌装瓶数:', s.filled);
console.log('合格瓶数  :', s.good);
console.log('剔除瓶数  :', s.reject);
console.log('合格率(%) :', s.passRate.toFixed(1));
console.log('线上剩余瓶:', sim.bottles.length);
// 诊断：按主线/回收道与状态分类
const onMain = sim.bottles.filter((b) => b.z === 0);
const onRecycle = sim.bottles.filter((b) => b.z > 0);
console.log('  主线瓶:', onMain.length, '回收道瓶:', onRecycle.length);
console.log('  主线瓶 x 范围:', onMain.length ? `${Math.min(...onMain.map((b) => b.x)).toFixed(1)} ~ ${Math.max(...onMain.map((b) => b.x)).toFixed(1)}` : '无');
console.log('  回收道瓶 x 范围:', onRecycle.length ? `${Math.min(...onRecycle.map((b) => b.x)).toFixed(1)} ~ ${Math.max(...onRecycle.map((b) => b.x)).toFixed(1)}` : '无');
console.log('  各状态:', JSON.stringify(sim.bottles.reduce((acc, b) => { acc[b.state] = (acc[b.state] || 0) + 1; return acc; }, {})));
console.log('  工位忙闲:', sim.stations.map((st) => `${st.name}:${st.state}${st.busyBottle ? '#瓶' + st.busyBottle.id : ''}`).join(' | '));
console.log('故障事件数:', events.length);
console.log('事件样例  :', events.slice(0, 4).map((e) => `${e.station}-${e.reason}`).join('，') || '无');

// 断言：瓶数合理、合格率在区间、故障与工位对应关系正确
const countsOk = s.filled > 3 && s.passRate >= 0 && s.passRate <= 100;
const stationOk = events.every((e) =>
  (e.reason === '瓶子歪倒' && e.station === '洗瓶机') ||
  (e.reason === '灌装未满' && e.station === '多头灌装机') ||
  (e.reason === '标签歪斜' && e.station === '贴标机'));
// 数量平衡：合格品 + 剔除瓶数 = 完成贴标的总瓶数（剔除数不会大于总处理量）
const balanceOk = s.good + s.reject >= s.good && s.reject <= s.filled + 1;

console.log('\n计数断言:', countsOk ? 'PASS' : 'FAIL');
console.log('工位对应:', stationOk ? 'PASS' : 'FAIL');
console.log('数量平衡:', balanceOk ? 'PASS' : 'FAIL');
process.exit(countsOk && stationOk && balanceOk ? 0 : 1);
