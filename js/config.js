// =============================================================
// 全局配置：渲染、灯光、车间、工位节拍、故障概率、模型路径统一管理
// =============================================================
export const CONFIG = {
  // ---- 渲染参数 ----
  renderer: {
    antialias: true,
    pixelRatioCap: 2,
    shadowMapSize: 2048,
    clearColor: 0xeef0f3,
  },

  // ---- 灯光与环境（集中配置） ----
  lights: {
    hemiSky: 0xfff7e8,       // 半球光天光色
    hemiGround: 0x9aa0a6,    // 半球光地面反弹色
    hemiIntensity: 0.85,
    dirColor: 0xffffff,
    dirIntensity: 1.7,
    dirPosition: [12, 20, 10],
    ambientIntensity: 0.25,
    fogColor: 0xeef0f3,
    fogNear: 32,
    fogFar: 78,
  },

  // ---- 车间尺寸 ----
  room: {
    length: 40,   // X 方向
    width: 14,    // Z 方向
    wallHeight: 6.5,
    wallColor: 0xf3f1ec,
    floorColor: 0xd9dce0,
  },

  // ---- 输送链 ----
  belt: {
    length: 36,
    width: 1.1,
    topY: 1.0,            // 输送带顶面高度
    baseSpeed: 1.0,       // 基准线速 m/s
  },
  recycle: { z: 2.15 },   // 回收道中心 Z
  bottleSpacing: 1.15,    // 瓶间距
  spawnX: -16.4,          // 进瓶位置
  outfeedX: 16.2,         // 出瓶剔除位置
  // 进瓶节拍与瓶颈工位（灌装机 3.6s + 冷却 0.6s ≈ 4.2s）匹配，避免空瓶在入口积压
  spawnInterval: 3.8,

  // ---- 工位节拍配置（x 为工位中心坐标，duration 加工节拍，cooldown 出料冷却） ----
  stations: [
    {
      key: 'washer', name: '洗瓶机', x: -9, duration: 2.6, cooldown: 0.5,
      desc: '瓶子由星轮拨入冲洗舱，高压喷嘴对瓶内外壁进行冲洗，去除灰尘与杂质后送入灌装工位。',
    },
    {
      key: 'filler', name: '多头灌装机', x: -3, duration: 3.6, cooldown: 0.6,
      desc: '六头旋转阀等压灌装，阀门下行对准瓶口，液位随灌装时间匀速上升，支持 330ml / 500ml 容量切换。',
    },
    {
      key: 'capper', name: '压盖机', x: 3, duration: 2.0, cooldown: 0.4,
      desc: '皇冠盖经理盖斗与滑道送至瓶口，压盖头下行把瓶盖压紧封口，完成密封。',
    },
    {
      key: 'labeler', name: '贴标机', x: 9, duration: 2.4, cooldown: 0.5,
      desc: '标签卷经滚轮送标，刷标轮将标签卷贴到瓶身侧面并压合，贴标后瓶子进入出料台。',
    },
  ],

  // ---- 随机故障概率（每次进瓶独立判定，可在面板关闭） ----
  fault: {
    enabled: true,
    fall: 0.05,        // 瓶子歪倒（洗瓶机处剔出）
    underfill: 0.07,   // 灌装未满（灌装机处剔出）
    crooked: 0.06,     // 标签歪斜（贴标机处剔出）
  },

  // ---- glTF 模型路径（统一管理；加载失败自动使用几何体兜底模型） ----
  // 可改为在线 URL，例如 https://example.com/models/washer.glb
  modelUrls: {
    washer: 'models/washer.glb',
    filler: 'models/filler.glb',
    capper: 'models/capper.glb',
    labeler: 'models/labeler.glb',
  },

  // ---- 瓶身配色 ----
  bottleColors: {
    琥珀棕: 0x7a5230,
    墨绿: 0x1f4d3a,
    透明白: 0xcfe4f5,
  },

  // ---- 瓶装容量对应的瓶型尺寸 ----
  capacity: {
    '330ml': { r: 0.26, h: 1.05 },
    '500ml': { r: 0.29, h: 1.22 },
  },
};
