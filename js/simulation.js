// =============================================================
// 仿真核心：瓶子由输送带进度驱动，工位按节拍触发动作；
// 故障按概率随机注入，问题瓶由拨杆横移剔到回收道。
// =============================================================
import * as THREE from 'three';
import { CONFIG } from './config.js';
import {
  MAT, LAMP_COLORS, RING_COLORS,
  createBottle, createConveyor, createRecycleBelt, createWorkshop,
  buildStationFallback, tryLoadStationModel, getGlassMat,
} from './factory.js';

let bottleSeq = 0;
const MIN_GAP = CONFIG.bottleSpacing * 0.85; // 线上瓶子最小间距
const REJECT_DURATION = 0.7;                 // 拨杆横移动作时长 s
const easeInOut = (t) => 0.5 - Math.cos(Math.max(0, Math.min(1, t)) * Math.PI) / 2;

export class Simulation {
  constructor(scene) {
    this.scene = scene;
    // ---- 运行状态 ----
    this.running = false;        // 全线运行标志
    this.estop = false;          // 急停标志
    this.speedFactor = 1;        // 线速倍率（面板滑块）
    this.capacityName = '330ml'; // 当前瓶型容量
    this.colorName = '琥珀棕';   // 当前瓶身配色
    this.time = 0;
    this.spawnTimer = 0;
    this.beltSpeed = 0;          // 当前实际带速 m/s
    // ---- 对象集合 ----
    this.bottles = [];
    this.stations = [];
    this.stats = { filled: 0, good: 0, reject: 0 };
    this.onEvent = null;         // 事件回调（故障日志等）
    this.onModelFallback = null; // glTF 加载失败回调（UI 提示）
    this.beltRefs = null;
    this.recycleRefs = null;
    this.workshopWalls = null;
  }

  // ----------------------------------------------------------
  // 场景搭建：车间、输送链、回收道、四个工位（glTF 优先，失败兜底）
  // ----------------------------------------------------------
  async init() {
    const workshop = createWorkshop();
    this.scene.add(workshop.group);
    this.workshopWalls = workshop.walls;

    const belt = createConveyor();
    this.scene.add(belt.group);
    this.beltRefs = belt.refs;

    const recycle = createRecycleBelt();
    this.scene.add(recycle.group);
    this.recycleRefs = recycle.refs;

    // 进料台 / 出料台
    const tableMat = MAT.frame;
    for (const x of [CONFIG.spawnX - 1.1, CONFIG.outfeedX + 1.0]) {
      const table = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.16, 1.3), tableMat);
      table.position.set(x, CONFIG.belt.topY - 0.08, 0);
      table.castShadow = table.receiveShadow = true;
      this.scene.add(table);
    }

    for (const cfg of CONFIG.stations) {
      // 每个工位用一个包装组，内部模型可在 glTF/兜底之间替换，灯柱与拨杆作为叠加层始终保留
      const wrapper = new THREE.Group();
      wrapper.position.set(cfg.x, 0, 0);
      wrapper.userData.stationKey = cfg.key;
      this.scene.add(wrapper);

      const fallback = buildStationFallback(cfg.key);
      wrapper.add(fallback.group);

      // 灯柱 + 拨杆叠加层（兜底模型内已含，glTF 模式下另外补建）
      const overlay = new THREE.Group();
      const st = {
        ...cfg,
        wrapper,
        modelGroup: fallback.group,
        fbRefs: fallback.refs,
        isGLTF: false,
        state: 'idle',
        busyBottle: null,
        timer: 0,
        cooldownTimer: 0,
        pushTimer: -1,
        pusher: fallback.refs.pusher,
        lamp: fallback.refs.lamp,
      };
      wrapper.userData.station = st;
      this.stations.push(st);

      // 异步尝试 glTF，成功则替换兜底模型，并补装灯柱/拨杆
      const gltfModel = await tryLoadStationModel(CONFIG.modelUrls[cfg.key], 3.4);
      if (gltfModel) {
        wrapper.remove(fallback.group);
        wrapper.add(gltfModel);
        st.modelGroup = gltfModel;
        st.isGLTF = true;
        const { lampPost, pusher } = this._buildOverlay();
        overlay.add(lampPost);
        overlay.add(pusher);
        wrapper.add(overlay);
        st.lamp = lampPost.userData.lamp;
        st.pusher = pusher;
      } else if (this.onModelFallback) {
        this.onModelFallback(cfg.name);
      }
    }
  }

  /** glTF 模式下补建的灯柱与拨杆 */
  _buildOverlay() {
    const g = new THREE.Group();
    const poleMat = MAT.frame;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.7, 10), poleMat);
    pole.position.set(1.0, CONFIG.belt.topY + 0.35, 0.85);
    pole.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), MAT.lampOff.clone());
    lamp.position.set(1.0, CONFIG.belt.topY + 0.78, 0.85);
    g.add(pole, lamp);
    const lampPost = new THREE.Group();
    lampPost.add(pole, lamp);
    lampPost.userData.lamp = lamp;

    const pusher = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), MAT.yellow);
    arm.position.y = CONFIG.belt.topY + 0.25;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.42, 0.55), MAT.yellow);
    plate.position.set(0, CONFIG.belt.topY + 0.32, 0.3);
    pusher.add(arm, plate);
    pusher.position.set(0, 0, -0.78);
    pusher.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return { lampPost, pusher };
  }

  // ----------------------------------------------------------
  // 面板操作
  // ----------------------------------------------------------
  start() {
    if (this.estop) return;      // 急停未复位前禁止启动
    this.running = true;
  }

  pause() {
    this.running = false;
  }

  /** 急停：全线立即停止，所有工位转堵塞红灯 */
  estopLine() {
    this.estop = true;
    this.running = false;
  }

  /** 复位：清除急停、清空线上瓶子与故障，工位回到待机 */
  reset() {
    this.estop = false;
    this.running = false;
    this.time = 0;
    this.spawnTimer = 0;
    this.beltSpeed = 0;
    for (const b of this.bottles) this.scene.remove(b.group);
    this.bottles = [];
    this.stats = { filled: 0, good: 0, reject: 0 };
    for (const st of this.stations) {
      st.state = 'idle';
      st.busyBottle = null;
      st.timer = 0;
      st.cooldownTimer = 0;
      st.pushTimer = -1;
      st.pusher.position.z = -0.78;
      this._setLamp(st, 'idle');
    }
  }

  setSpeedFactor(v) { this.speedFactor = v; }
  setCapacity(v) { this.capacityName = v; }
  setBottleColor(name) {
    this.colorName = name;
    // 已在线上的瓶子替换为对应配色的共享材质（直接改色会污染材质缓存）
    for (const b of this.bottles) b.refs.glass.material = getGlassMat(name);
  }
  setFaultEnabled(on) { CONFIG.fault.enabled = on; }
  setWallsVisible(v) { if (this.workshopWalls) this.workshopWalls.visible = v; }

  // ----------------------------------------------------------
  // 进瓶：按间隔在进料台生成新瓶，并在出生时随机注入故障
  // ----------------------------------------------------------
  _spawnBottle() {
    const model = createBottle(this.capacityName, this.colorName);
    const b = {
      id: ++bottleSeq,
      ...model,
      x: CONFIG.spawnX,
      z: 0,
      state: 'empty',       // empty / half / full / product / reject
      fillLevel: 0,
      capped: false,
      labelApplied: false,
      fallen: false,
      crooked: false,
      fault: this._rollFault(),
      nextIdx: 0,           // 下一个要进入的工位序号
      processing: false,
      rejectT: 0,
      despawn: false,
    };
    b.group.position.set(b.x, CONFIG.belt.topY, b.z);
    b.group.userData.bottleId = b.id;
    this.scene.add(b.group);
    this.bottles.push(b);
  }

  /** 随机故障判定：歪倒 / 灌装未满 / 标签歪斜，每瓶最多一种 */
  _rollFault() {
    if (!CONFIG.fault.enabled) return null;
    const f = CONFIG.fault;
    if (Math.random() < f.fall) return 'fall';
    if (Math.random() < f.underfill) return 'underfill';
    if (Math.random() < f.crooked) return 'crooked';
    return null;
  }

  // ----------------------------------------------------------
  // 主更新
  // ----------------------------------------------------------
  update(rawDt) {
    const dt = Math.min(rawDt, 0.05); // 钳制帧间隔，防止切后台后跳变
    // 输送链视觉始终与运行标志同步（暂停/急停即停）
    this.beltSpeed = this.running ? CONFIG.belt.baseSpeed * this.speedFactor : 0;
    this._animateBelt(dt);

    if (this.running) {
      this.time += dt;
      this._updateSpawn(dt);
      this._updateStations(dt);
      this._moveBottles(dt);
    }
    this._updateBottleVisuals(dt);
    this._animateMachines(dt);
    this._updateStationLamps();
  }

  /** 进瓶节拍：间隔随线速缩短，进料位被占时等待 */
  _updateSpawn(dt) {
    this.spawnTimer += dt;
    const interval = CONFIG.spawnInterval / this.speedFactor;
    const blocked = this.bottles.some((b) => !b.despawn && b.x < CONFIG.spawnX + MIN_GAP);
    if (this.spawnTimer >= interval && !blocked) {
      this.spawnTimer = 0;
      this._spawnBottle();
    }
  }

  // ----------------------------------------------------------
  // 工位节拍：瓶子到达 → 锁定加工 → 计时 → 判定放行/剔除
  // ----------------------------------------------------------
  _updateStations(dt) {
    for (const st of this.stations) {
      if (st.cooldownTimer > 0) st.cooldownTimer -= dt;
      if (st.pushTimer >= 0) st.pushTimer -= dt; // 拨杆计时

      const b = st.busyBottle;
      if (!b) {
        if (st.state === 'run') st.state = 'idle';
        continue;
      }
      st.timer += dt;
      st.state = 'run';

      // 灌装过程中液位随加工进度实时上升；未满故障瓶只灌到 60%
      if (st.key === 'filler') {
        const finalLevel = b.fault === 'underfill' ? 0.6 : 1;
        b.fillLevel = finalLevel * Math.min(1, st.timer / st.duration);
      }

      if (st.timer >= st.duration) {
        // 加工到时：若前方瓶未走够距离则堵塞等待
        const blocked = this.bottles.some(
          (o) => o !== b && !o.despawn && o.z === 0 && o.x > st.x && o.x - st.x < MIN_GAP
        );
        if (blocked) {
          st.state = 'block';
          continue;
        }
        this._completeStation(st, b);
      }
    }
  }

  /** 工位加工完成：按工序更新瓶子状态，故障瓶转入剔除流程 */
  _completeStation(st, b) {
    const idx = this.stations.indexOf(st);
    b.processing = false;
    st.busyBottle = null;
    st.timer = 0;
    st.cooldownTimer = st.cooldown;
    st.state = 'idle';
    b.nextIdx = idx + 1;

    switch (st.key) {
      case 'washer':
        // 洗瓶仅清洗；歪倒瓶直接剔除
        if (b.fault === 'fall') {
          this._reject(b, st, '瓶子歪倒');
          return;
        }
        break;
      case 'filler':
        this.stats.filled++; // 经过灌装即计入已灌装瓶数
        if (b.fault === 'underfill') {
          b.fillLevel = 0.6;            // 未灌满，液位只到 60%
          b.state = 'half';
          this._reject(b, st, '灌装未满');
          return;
        }
        b.fillLevel = 1;
        b.state = 'full';
        break;
      case 'capper':
        b.capped = true;                // 压盖头完成封口
        break;
      case 'labeler':
        b.labelApplied = true;
        if (b.fault === 'crooked') {
          b.crooked = true;             // 标签贴歪
          this._reject(b, st, '标签歪斜');
          return;
        }
        b.state = 'product';
        this.stats.good++;              // 合格品计数
        break;
    }
  }

  /** 剔除：状态转 reject，启动该工位拨杆横移动作 */
  _reject(b, st, reason) {
    b.state = 'reject';
    b.rejectT = 0;
    b.processing = false;
    st.busyBottle = null;
    st.pushTimer = REJECT_DURATION;
    this.stats.reject++;
    const faultName = { fall: '瓶子歪倒', underfill: '灌装未满', crooked: '标签歪斜' }[b.fault] || reason;
    if (this.onEvent) this.onEvent({ type: 'fault', station: st.name, bottleId: b.id, reason: faultName });
  }

  // ----------------------------------------------------------
  // 瓶子移动：输送带进度驱动，加工中锁定，前方有瓶排队
  // ----------------------------------------------------------
  _moveBottles(dt) {
    const move = this.beltSpeed * dt;
    // 按 x 从大到小处理，先保证前瓶位置
    const sorted = [...this.bottles].sort((a, b) => b.x - a.x);

    for (const b of sorted) {
      if (b.despawn) continue;

      // —— 剔除横移动作：主线 → 回收道 ——
      if (b.state === 'reject' && b.z < CONFIG.recycle.z - 0.01) {
        b.rejectT += dt;
        const k = easeInOut(b.rejectT / REJECT_DURATION);
        b.z = CONFIG.recycle.z * k;
        if (b.rejectT >= REJECT_DURATION) b.z = CONFIG.recycle.z;
        continue; // 横移期间暂停前进
      }

      // —— 回收道上的问题瓶：继续前行直到回收斗 ——
      if (b.z > 0) {
        b.x += move;
        if (b.x > 13.4) { b.despawn = true; this.scene.remove(b.group); }
        continue;
      }

      // 加工中的瓶子锁定在工位中心
      if (b.processing) { b.x = this.stations[b.nextIdx].x; continue; }

      // 计算本帧允许到达的最远 x：前瓶间距 + 下一个工位的接瓶条件
      let limit = CONFIG.outfeedX + 0.6;
      const front = this.bottles.find((o) => o !== b && !o.despawn && o.z === 0 && o.x > b.x);
      if (front) limit = Math.min(limit, front.x - MIN_GAP);

      if (b.nextIdx < this.stations.length) {
        const st = this.stations[b.nextIdx];
        if (!this._canAccept(st)) limit = Math.min(limit, st.x); // 工位忙，瓶在工位前排队
      }

      const prevX = b.x;
      b.x = Math.min(b.x + move, limit);

      // 瓶子正好到达工位且工位可接 → 锁定开始加工
      if (b.nextIdx < this.stations.length) {
        const st = this.stations[b.nextIdx];
        if (b.x >= st.x - 0.001 && prevX <= st.x + 0.01 && this._canAccept(st)) {
          b.x = st.x;
          b.processing = true;
          st.busyBottle = b;
          st.timer = 0;
          st.state = 'run';
        }
      }

      // 成品瓶到达出料台后离场
      if (b.x >= CONFIG.outfeedX + 0.55) {
        b.despawn = true;
        this.scene.remove(b.group);
      }
    }

    // 清理已离场对象
    this.bottles = this.bottles.filter((b) => !b.despawn);
  }

  /** 工位是否可接瓶：无在制瓶、冷却结束、无正在横移的剔除瓶 */
  _canAccept(st) {
    if (st.busyBottle || st.cooldownTimer > 0) return false;
    if (this.bottles.some((b) => b.state === 'reject' && Math.abs(b.x - st.x) < 1.2)) return false;
    return true;
  }

  // ----------------------------------------------------------
  // 瓶子视觉：液位插值、瓶盖、标签歪斜、歪倒、状态环颜色
  // ----------------------------------------------------------
  _updateBottleVisuals(dt) {
    for (const b of this.bottles) {
      const { liquid, liqH, cap, ring, label } = b.refs;

      // 液位高度按 fillLevel 缩放（灌装时间插值在工位节拍中累积）
      const target = b.fillLevel;
      if (target > 0) {
        liquid.visible = true;
        const cur = liquid.scale.y;
        liquid.scale.y = Math.max(0.001, cur + (target - cur) * Math.min(1, dt * 2.2));
        liquid.position.y = 0.04 + (liqH * liquid.scale.y) / 2;
      } else {
        liquid.visible = false;
      }

      cap.visible = b.capped;
      label.rotation.z = b.crooked ? 0.4 : 0;

      // 贴标加工中瓶子绕竖直轴自转一圈，配合刷标轮把标签卷贴到瓶身
      const activeSt = b.processing ? this.stations[b.nextIdx] : null;
      if (activeSt && activeSt.key === 'labeler') {
        b.group.rotation.y = st_progress(activeSt) * Math.PI * 2;
      }

      // 歪倒瓶：绕 Z 轴躺倒在链板上
      const targetRotZ = b.fallen ? 1.35 : 0;
      b.group.rotation.z += (targetRotZ - b.group.rotation.z) * Math.min(1, dt * 6);
      const targetY = b.fallen ? CONFIG.belt.topY + b.size.r : CONFIG.belt.topY;
      b.group.position.y += (targetY - b.group.position.y) * Math.min(1, dt * 6);

      // 状态环颜色
      const colorKey = b.state;
      ring.material.color.set(RING_COLORS[colorKey]);
      ring.material.emissive.set(RING_COLORS[colorKey]);

      // 洗瓶加工中触发歪倒（进度到 35% 时倒下）
      const washer = this.stations[0];
      if (!b.fallen && b.fault === 'fall' && washer.busyBottle === b && st_progress(washer) > 0.35) {
        b.fallen = true;
      }

      b.group.position.x = b.x;
      b.group.position.z = b.z;
    }
  }

  // ----------------------------------------------------------
  // 机械动画：输送链、星轮、灌装阀往复、压盖下行、贴标滚轮、拨杆
  // ----------------------------------------------------------
  _animateBelt(dt) {
    const v = this.beltSpeed;
    const { beltMat, rollers } = this.beltRefs;
    beltMat.map.offset.x -= dt * v * 0.28;
    for (const r of rollers) r.rotation.y += dt * v * 2.4;
    this.recycleRefs.beltMat.map.offset.x -= dt * v * 0.28;
  }

  _animateMachines(dt) {
    const v = this.beltSpeed;
    // 暂停/急停时所有运动部件冻结（拨杆复位除外）
    const adt = this.running ? dt : 0;
    for (const st of this.stations) {
      // 拨杆横移与复位（sin 曲线：推出再收回）
      if (st.pushTimer >= 0) {
        const k = 1 - st.pushTimer / REJECT_DURATION;
        st.pusher.position.z = -0.78 + (CONFIG.recycle.z - 0.55 + 0.78) * Math.sin(k * Math.PI);
      } else {
        st.pusher.position.z += (-0.78 - st.pusher.position.z) * Math.min(1, dt * 8);
      }

      // glTF 模型没有内部运动部件，仅做轻微整体摆动示意运行
      if (st.isGLTF) {
        st.modelGroup.rotation.y = st.busyBottle ? Math.sin(this.time * 4) * 0.03 : 0;
        continue;
      }      const refs = st.fbRefs;
      const busy = !!st.busyBottle;
      const progress = busy ? st.timer / st.duration : 0;

      if (st.key === 'washer') {
        for (const s of refs.stars) s.rotation.y += adt * v * 1.6;
      }
      if (st.key === 'filler') {
        refs.carousel.rotation.y += adt * (v * 1.2 + (busy ? 1.4 : 0)); // 星轮/阀转盘旋转
        // 灌装头整体下行注液，节拍结束抬起
        refs.head.position.y = CONFIG.belt.topY + 1.55 - (busy ? Math.sin(progress * Math.PI) * 0.45 : 0);
      }
      if (st.key === 'capper') {
        for (const s of refs.stars) s.rotation.y += adt * v * 1.6;
        // 压盖头下行扣盖
        refs.ram.position.y = CONFIG.belt.topY + 1.55 - (busy ? Math.sin(progress * Math.PI) * 0.5 : 0);
      }
      if (st.key === 'labeler') {
        // 送标滚轮与刷标轮旋转，加工时提速
        for (const r of refs.rollers) r.rotation.z += adt * (v * 2 + (busy ? 3 : 0));
      }
    }
  }

  _updateStationLamps() {
    for (const st of this.stations) {
      const mode = this.estop ? 'block' : (this.running ? st.state : 'idle');
      this._setLamp(st, mode);
    }
  }

  _setLamp(st, mode) {
    const c = LAMP_COLORS[mode];
    st.lamp.material.color.set(c);
    st.lamp.material.emissive.set(c);
    st.lamp.material.emissiveIntensity = mode === 'idle' ? 0.25 : 0.9;
  }

  // ----------------------------------------------------------
  // 查询接口（UI / 相机使用）
  // ----------------------------------------------------------
  getStats() {
    const total = this.stats.good + this.stats.reject;
    const passRate = total ? (this.stats.good / total) * 100 : 100;
    return { ...this.stats, passRate, beltSpeed: this.beltSpeed * 60 }; // m/min
  }

  getStationStates() {
    return this.stations.map((st) => ({
      key: st.key, name: st.name,
      state: this.estop ? 'block' : (this.running ? st.state : 'idle'),
      desc: st.desc,
    }));
  }

  /** 跟随机位取瓶：优先主线上最接近画面中央的在制瓶 */
  getFollowBottle() {
    const main = this.bottles.filter((b) => b.z === 0 && !b.despawn);
    if (!main.length) return null;
    main.sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
    return main[0];
  }

  getBottleById(id) {
    return this.bottles.find((b) => b.id === id) || null;
  }
}

/** 工位加工进度 0~1（供视觉触发用） */
function st_progress(st) {
  return st.duration ? Math.min(1, st.timer / st.duration) : 0;
}
