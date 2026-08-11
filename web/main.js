import * as THREE from "three";

/* ── 视口坐标层：触屏竖屏时 body 顺时针旋 90° 伪装横屏，
   逻辑视口宽高与指针坐标一律经此层换算 ── */
const fakeLandMq = matchMedia(
  "(max-width: 900px) and (orientation: portrait) and (pointer: coarse)");
function isFakeLand() { return fakeLandMq.matches; }
function vw() { return isFakeLand() ? innerHeight : innerWidth; }
function vh() { return isFakeLand() ? innerWidth : innerHeight; }
// rotate(90deg) translateY(-100%) 的逆：x' = y，y' = W - x
function toView(x, y) {
  return isFakeLand() ? { x: y, y: innerWidth - x } : { x, y };
}
function evPos(e) { return toView(e.clientX, e.clientY); }

document.body.classList.toggle("fake-land", isFakeLand());
fakeLandMq.addEventListener("change", () => {
  document.body.classList.toggle("fake-land", isFakeLand());
});

/* 伪横屏提示浮窗：8s 自动淡出，点击立即消失，提示过一次不再弹 */
function showRotateToast() {
  const toast = document.getElementById("rotate-toast");
  if (!isFakeLand() || !toast.hidden) return;
  try {
    if (localStorage.getItem("hud.rotToast")) return;
    localStorage.setItem("hud.rotToast", "1");
  } catch { /* 隐私模式 */ }
  toast.hidden = false;
  // 双 rAF：等 display 变化先完成一次样式计算，淡入过渡才会触发
  requestAnimationFrame(() =>
    requestAnimationFrame(() => toast.classList.add("on")));
  const close = () => {
    toast.classList.remove("on");
    setTimeout(() => { toast.hidden = true; }, 700);
  };
  const timer = setTimeout(close, 8000);
  toast.addEventListener("click", () => { clearTimeout(timer); close(); }, { once: true });
}

const SCENE_SCALE = 1 / 12;      // ly -> scene units
const STAR_STRIDE = 6;           // gx, gy, gz, vt_mag, bv_color, label
const EDGE_BASE = 0.006;         // resting opacity of the similarity graph
const EDGE_LIT = 0.9;

const TRAIL_MAX = 0.87;      // 相机全速时上一帧的保留比例
const TRAIL_DEADZONE = 0.05; // 低于此角速度不留尾，免得自转也拖影
const TRAIL_EXP = 2 / 3;     // 尾长随角速度的次线性增长指数
const TRAIL_K = 0.75;        // 使常规拖拽（约 1.3 rad/s）接近 TRAIL_MAX

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
// 手机上 DPR 常到 3，配上 4x MSAA 和两块半浮点缓冲会直接拖垮帧率
const coarse = matchMedia("(pointer: coarse)").matches;
renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
renderer.autoClear = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 20000);

/* ── 相机控制：轨道 + 推拉 + 平滑聚焦 ───────────────────── */
const cam = {
  target: new THREE.Vector3(),
  goalTarget: new THREE.Vector3(),
  // 起始视距放远，先看到整个盘的形状；场景总尺度约 335 单位
  theta: 0.7, phi: 1.22, radius: 160,
  goalTheta: 0.7, goalPhi: 1.22, goalRadius: 160,
  // 下限须留在固定逼近距离（8.12 ly ≈ 0.68 su）之下，否则辅助驾驶停稳后
  // 任意一次捏合缩放都会把半径钳向 minRadius，产生一次跳变式的镜头外甩
  minRadius: 0.5, maxRadius: 420,
  roll: 0,   // 纯视觉滚转（rad），只改 up 向量，不进 goal 追赶体系
};
const camDir = new THREE.Vector3();
const camRight = new THREE.Vector3();
const camUp = new THREE.Vector3();

/* 引擎绝对规格（场景单位 su，1 su = 12 ly）：矢量喷口（RCS）管转向与平移，
   主引擎管径向推进，前进与倒车上限不对称。手动与自动同一套引擎。 */
const ENGINE = {
  rcs: {
    angAccel: 1.05,               // rad/s²，半秒到角速度上限
    angMax: Math.PI / 6,          // rad/s（30°/s）
    panAccel: 2 * SCENE_SCALE,    // su/s²（2 ly/s²）
    panMax: 10 * SCENE_SCALE,     // su/s（10 ly/s）
  },
  main: {
    accel: 200 * SCENE_SCALE,     // su/s²（200 ly/s²）
    brake: 100 * SCENE_SCALE,     // su/s²（100 ly/s²）
    vFwd: 1000 * SCENE_SCALE,     // su/s（前进 1000 ly/s，半径减小）
    vRev: 100 * SCENE_SCALE,      // su/s（倒车 100 ly/s，半径增大）
  },
};
// 手动直控增益：只乘在手动路径（姿态角速率/角加速度、节流加减速），自动不乘
const MANUAL_BOOST = 1.5;
const vel = { theta: 0, phi: 0, r: 0, pan: 0 };
const panDelta = new THREE.Vector3();

// 带加减速的抵达：期望速度取 sqrt(2*a*误差)，于是到点时速度正好归零
function approach(cur, v, goal, accel, maxV, dt) {
  const err = goal - cur;
  if (Math.abs(err) < 1e-6) return [goal, 0];
  const want = THREE.MathUtils.clamp(
    Math.sign(err) * Math.sqrt(2 * accel * Math.abs(err)), -maxV, maxV);
  const nv = v + THREE.MathUtils.clamp(want - v, -accel * dt, accel * dt);
  const next = cur + nv * dt;
  if ((goal - next) * err <= 0) return [goal, 0];   // 越过就吸附，免得来回抖
  return [next, nv];
}

// 径向不对称抵达：期望速度 sqrt(2*brake*|err|) 截到方向上限，
// 提速受 accel、降速受 brake 封顶
function approachRadial(cur, v, goal, dt) {
  const err = goal - cur;
  if (Math.abs(err) < 1e-6) return [goal, 0];
  const m = ENGINE.main;
  const cap = err < 0 ? m.vFwd : m.vRev;
  const want = Math.sign(err) * Math.min(Math.sqrt(2 * m.brake * Math.abs(err)), cap);
  const speedingUp = want * v >= 0 && Math.abs(want) > Math.abs(v);
  const lim = (speedingUp ? m.accel : m.brake) * dt;
  const nv = v + THREE.MathUtils.clamp(want - v, -lim, lim);
  const next = cur + nv * dt;
  if ((goal - next) * err <= 0) return [goal, 0];
  return [next, nv];
}

/* 双轨：自动驾驶的 goal 已按引擎时序生成，直接指数平滑跟随（τ≈0.1s），
   重锚（target/radius 大跳）不会卡住追赶；手动才走引擎追赶。 */
function applyCamera(dt) {
  if (auto.on || auto.assist) {
    const k = 1 - Math.pow(1e-4, dt);
    const pt = cam.theta, pp = cam.phi, pr = cam.radius;
    cam.theta += (cam.goalTheta - cam.theta) * k;   // theta 已解缠，可直接插
    cam.phi = THREE.MathUtils.clamp(
      cam.phi + (cam.goalPhi - cam.phi) * k, 0.04, Math.PI - 0.04);
    cam.radius += (cam.goalRadius - cam.radius) * k;
    cam.target.lerp(cam.goalTarget, k);
    // 隐含速度写回 vel：打断切手动时引擎按制动包络接住动量，而不是一帧骤停
    vel.theta = (cam.theta - pt) / dt;
    vel.phi = (cam.phi - pp) / dt;
    vel.r = (cam.radius - pr) / dt;
    vel.pan = 0;
  } else {
    [cam.theta, vel.theta] = approach(cam.theta, vel.theta, cam.goalTheta,
      ENGINE.rcs.angAccel * MANUAL_BOOST, ENGINE.rcs.angMax * MANUAL_BOOST, dt);
    [cam.phi, vel.phi] = approach(cam.phi, vel.phi, cam.goalPhi,
      ENGINE.rcs.angAccel * MANUAL_BOOST, ENGINE.rcs.angMax * MANUAL_BOOST, dt);
    cam.phi = THREE.MathUtils.clamp(cam.phi, 0.04, Math.PI - 0.04);

    [cam.radius, vel.r] = approachRadial(cam.radius, vel.r, cam.goalRadius, dt);

    // 平移在绝对 su 空间限速
    panDelta.subVectors(cam.goalTarget, cam.target);
    const len = panDelta.length();
    if (len > 1e-6) {
      const [step, nv] = approach(0, vel.pan, len,
        ENGINE.rcs.panAccel, ENGINE.rcs.panMax, dt);
      vel.pan = nv;
      cam.target.addScaledVector(panDelta.divideScalar(len), Math.min(step, len));
    } else {
      vel.pan = 0;
    }
  }

  const sp = Math.sin(cam.phi);
  camera.position.set(
    cam.target.x + cam.radius * sp * Math.sin(cam.theta),
    cam.target.y + cam.radius * Math.cos(cam.phi),
    cam.target.z + cam.radius * sp * Math.cos(cam.theta),
  );
  // 滚转是纯视觉的机身绕视轴转动，不碰 theta/phi/target：
  // 先按世界系求出中性的右/上基向量，再绕视线把 up 转过 cam.roll
  camDir.copy(cam.target).sub(camera.position).normalize();
  if (Math.abs(camDir.y) < 0.999) {
    camRight.crossVectors(camDir, FLIP_UP).normalize();
  } else {
    camRight.copy(FLIP_RIGHT);
  }
  camUp.crossVectors(camRight, camDir).normalize();
  camera.up.copy(camUp).multiplyScalar(Math.cos(cam.roll))
    .addScaledVector(camRight, Math.sin(cam.roll));
  camera.lookAt(cam.target);
}

/* 指针：单指/左键旋转，双指捏合缩放 + 同向拖动平移。
   触屏没有滚轮，缩放和平移只能靠手势，否则移动端完全无法推拉。 */
const pointers = new Map();
const canHover = matchMedia("(hover: hover)").matches;
const TAP_SLOP = { mouse: 5, touch: 14, pen: 8 };
let dragging = false;
let pinch = null;

function pinchState() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}
// 双指数变化时重设基准，否则抬起一指的瞬间会跳一大步
function resetPinch() { pinch = pointers.size === 2 ? pinchState() : null; }

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointerdown", (e) => {
  // 鼠标：右键转视角，左键只用来选中；触摸：单指转、双指缩放平移
  const isMouse = e.pointerType === "mouse";
  if (isMouse && e.button !== 0 && e.button !== 2) return;
  const role = isMouse ? (e.button === 2 ? "orbit" : "pick") : "orbit";
  canvas.setPointerCapture(e.pointerId);
  const pos = evPos(e);
  pointers.set(e.pointerId,
    { x: pos.x, y: pos.y, moved: 0, type: e.pointerType, role, downAt: performance.now() });
  dragging = true;
  resetPinch();
  clearHover();                 // 拖拽期间不更新悬停，留着会是个跟错星的虚框
  elResults.classList.remove("on");
});

canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  const pos = evPos(e);
  if (!p) { if (canHover) hover(pos.x, pos.y); return; }
  const dx = pos.x - p.x, dy = pos.y - p.y;
  p.moved += Math.abs(dx) + Math.abs(dy);
  p.x = pos.x; p.y = pos.y;

  if (pointers.size === 1) {
    // 转向不再是拖拽增量：右键/单指按住即指向线操控，位置已在上面更新，
    // 每帧由 pointerSteerStep() 按当前位置与中心的距离转向（见下方）
  } else if (pointers.size === 2) {
    const s = pinchState();
    if (pinch) {
      if (s.d > 1 && pinch.d > 1) {
        cam.goalRadius = THREE.MathUtils.clamp(
          cam.goalRadius * (pinch.d / s.d), cam.minRadius, cam.maxRadius);
        leashRadius();
      }
      // 手势给的是像素，先换算成场景单位再喂平移
      const wpp = panWorldPerPixel();
      panScreen(-(s.mx - pinch.mx) * wpp, (s.my - pinch.my) * wpp);
    }
    pinch = s;
  }
});

function endPointer(e, tap) {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  pointers.delete(e.pointerId);
  if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  dragging = pointers.size > 0;
  resetPinch();
  // 鼠标只认左键选中，右键松开不该顺手选一颗；触摸轻点照常选中
  const canPick = p.type === "mouse" ? p.role === "pick" : true;
  if (tap && canPick && p.moved < (TAP_SLOP[p.type] ?? 8)) {
    const pos = evPos(e);
    pick(pos.x, pos.y, true);
  }
}
canvas.addEventListener("pointerup", (e) => endPointer(e, true));
canvas.addEventListener("pointercancel", (e) => endPointer(e, false));

/* 鼠标中键：按下立即清速度；按住不放超过阈值则持续转向银心，松开即停。
   不进 pointers 表，与左右键的选中/指向线互不相扰。 */
let midHeld = false, midTimer = null, steerCenter = false;
canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 1) return;
  e.preventDefault();
  midHeld = true;
  throttle.gear = 0; throttle.v = 0;
  midTimer = setTimeout(() => { if (midHeld) steerCenter = true; }, 350);
});
addEventListener("pointerup", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 1) return;
  midHeld = false; steerCenter = false;
  clearTimeout(midTimer);
});
addEventListener("blur", () => { midHeld = false; steerCenter = false; clearTimeout(midTimer); });

// 银心方向在相机系里的左右/上下分量，接近时收窄输入，转到位就停，不来回摆
function steerCenterStep() {
  if (!steerCenter) return;
  attLook.copy(camera.position).negate();   // 相机 -> 银心（原点）
  const dist = attLook.length();
  if (dist < 1e-3) return;
  attLook.divideScalar(dist);
  const right = attLook.dot(camRight), up = attLook.dot(camUp);
  const strength = Math.min(Math.hypot(right, up) / 0.15, 1);
  att.inYaw -= right * strength;
  att.inPitch += up * strength;
}

/* WASD 姿态键：AD 滚转、WS 俯仰，机位不动只转视线/机身 */
const held = new Set();
// AD 是滚筒转动（绕视轴 roll），不是转向；WS 仍是俯仰。
// 转向（偏航）交给右键/触屏的指向线操控与右摇杆
const ATT_KEYS = { KeyW: "pitchU", KeyS: "pitchD", KeyA: "rollL", KeyD: "rollR" };
const panRight = new THREE.Vector3();
const panUp = new THREE.Vector3();

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (ATT_KEYS[e.code]) { held.add(ATT_KEYS[e.code]); e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (ATT_KEYS[e.code]) held.delete(ATT_KEYS[e.code]);
});
// 任何会夺走键盘焦点的动作都可能让 keyup 丢失，键就永远卡在按下状态。
// 右键菜单是最容易触发的一种，这里把所有出口都兜住。
addEventListener("blur", () => held.clear());
addEventListener("contextmenu", () => held.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) held.clear();
});

const panScratch = new THREE.Vector3();

// 屏幕中心处 1px 对应的场景距离，手势像素输入用它换算 su
function panWorldPerPixel() {
  return (2 * cam.radius * Math.tan((camera.fov * Math.PI) / 360)) / vh();
}

// 沿屏幕平面平移视点，dx/dy 为场景单位。
// goal 拴在引擎短时可达范围内，任何输入路径都甩不开机体
function panScreen(dx, dy) {
  if (dx === 0 && dy === 0) return;
  camera.matrixWorld.extractBasis(panRight, panUp, panScratch);
  cam.goalTarget.addScaledVector(panRight, dx);
  cam.goalTarget.addScaledVector(panUp, dy);
  panDelta.subVectors(cam.goalTarget, cam.target);
  const leash = ENGINE.rcs.panMax * 1.5;
  if (panDelta.length() > leash) {
    cam.goalTarget.copy(cam.target).addScaledVector(panDelta.normalize(), leash);
  }
}

// 半径 goal 同理拴住：倒车侧只有 100 ly/s，不拴会积累几十秒的橡皮筋
function leashRadius() {
  cam.goalRadius = THREE.MathUtils.clamp(cam.goalRadius,
    Math.max(cam.minRadius, cam.radius - ENGINE.main.vFwd * 2),
    Math.min(cam.maxRadius, cam.radius + ENGINE.main.vRev * 2));
}

/* ── 手动飞行模型：姿态 + 节流阀 ─────────────────────
   姿态输入给期望角速率，经 RCS 斜坡收敛；每帧把视线绕机位旋转，
   再用 aimFrom 反解回轨道参数并同步 goal，机位纹丝不动。
   节流阀：滚轮/左杆改目标速度档位，v 收敛后沿视线平移 target。 */
const FLIP_UP = new THREE.Vector3(0, 1, 0);
const FLIP_RIGHT = new THREE.Vector3(1, 0, 0);
const att = { yaw: 0, pitch: 0, roll: 0, inYaw: 0, inPitch: 0 };   // rad/s 与本帧杆量
const throttle = { gear: 0, v: 0 };                        // su/s，带符号
// 低速段更密：档位间隔随速度增大，转向/巡航贴近的低速区能精细停靠
const GEAR_STEPS =
  [-100, -50, -20, 0, 10, 25, 50, 100, 175, 275, 400, 550, 775, 1000];  // ly/s
const GEAR_MIN = GEAR_STEPS[0] * SCENE_SCALE;
const GEAR_MAX = GEAR_STEPS[GEAR_STEPS.length - 1] * SCENE_SCALE;
const attPos = new THREE.Vector3();
const attDir = new THREE.Vector3();
const attRight = new THREE.Vector3();
const attLook = new THREE.Vector3();
const attPan = new THREE.Vector3();

function shiftGear(dir) {
  const g = throttle.gear / SCENE_SCALE;
  if (dir > 0) {
    const s = GEAR_STEPS.find((v) => v > g + 1e-3);
    if (s !== undefined) throttle.gear = s * SCENE_SCALE;
  } else {
    for (let i = GEAR_STEPS.length - 1; i >= 0; i--) {
      if (GEAR_STEPS[i] < g - 1e-3) { throttle.gear = GEAR_STEPS[i] * SCENE_SCALE; break; }
    }
  }
}

const TWO_PI = Math.PI * 2;
// roll 是循环量，钳到 (-π,π] 再用；这样自动模式的衰减总走最短弧回正，
// 也让 cos/sin(roll) 在环绕处连续，360° 连转不会卡顿或跳变
function wrapPi(a) {
  a = ((a % TWO_PI) + TWO_PI) % TWO_PI;
  return a > Math.PI ? a - TWO_PI : a;
}

function attitudeStep(dt) {
  if (auto.on || auto.assist) {
    att.yaw = 0; att.pitch = 0; att.roll = 0; att.inYaw = 0; att.inPitch = 0;
    // 自动接管时机身按最短弧自动回正，不再手动保持滚转
    if (cam.roll) {
      const r = wrapPi(cam.roll) * Math.pow(0.02, dt);
      cam.roll = Math.abs(r) > 1e-4 ? r : 0;
    }
    return;
  }
  const iy = THREE.MathUtils.clamp(att.inYaw, -1, 1);
  const ip = THREE.MathUtils.clamp(att.inPitch
    + (held.has("pitchU") ? 1 : 0) - (held.has("pitchD") ? 1 : 0), -1, 1);
  const ir = (held.has("rollR") ? 1 : 0) - (held.has("rollL") ? 1 : 0);
  att.inYaw = 0; att.inPitch = 0;
  const lim = ENGINE.rcs.angAccel * MANUAL_BOOST * dt;
  const cap = ENGINE.rcs.angMax * MANUAL_BOOST;
  att.yaw += THREE.MathUtils.clamp(iy * cap - att.yaw, -lim, lim);
  att.pitch += THREE.MathUtils.clamp(ip * cap - att.pitch, -lim, lim);
  att.roll += THREE.MathUtils.clamp(ir * cap - att.roll, -lim, lim);
  if (att.roll) cam.roll = wrapPi(cam.roll + att.roll * dt);
  if (!att.yaw && !att.pitch) return;

  // 机位与单位视线；偏航绕世界 Y，俯仰绕视线右轴（滚转只改 up，不进这里）
  const sp = Math.sin(cam.phi);
  attPos.set(
    cam.target.x + cam.radius * sp * Math.sin(cam.theta),
    cam.target.y + cam.radius * Math.cos(cam.phi),
    cam.target.z + cam.radius * sp * Math.cos(cam.theta));
  attDir.copy(cam.target).sub(attPos).divideScalar(cam.radius);
  const yawA = att.yaw * dt;
  const pitA = att.pitch * dt;
  if (yawA) attDir.applyAxisAngle(FLIP_UP, yawA);
  if (pitA) {
    // 单帧俯仰量夹在极区外：视线不越顶，反解 theta 不会翻 π
    const phiV = Math.acos(THREE.MathUtils.clamp(attDir.y, -1, 1));
    const db = THREE.MathUtils.clamp(pitA,
      phiV - (Math.PI - 0.04), phiV - 0.04);
    attRight.set(-attDir.z, 0, attDir.x).normalize();
    attDir.applyAxisAngle(attRight, db).normalize();
  }
  // 反解回 (target,theta,phi,radius)，cam 与 goal 同步，机位不动。
  // 捏合暂存在 goal 上的缩放/平移增量先取出再放回，姿态旋转不吞并发手势
  const dR = cam.goalRadius - cam.radius;
  attPan.subVectors(cam.goalTarget, cam.target);
  const a = aimFrom(attPos,
    attLook.copy(attPos).addScaledVector(attDir, cam.radius), cam.theta);
  cam.theta = cam.goalTheta = a.theta;
  cam.phi = cam.goalPhi = a.phi;
  cam.radius = a.radius;
  cam.goalRadius = a.radius + dR;
  cam.target.copy(a.target);
  cam.goalTarget.copy(a.target).add(attPan);
}

function throttleStep(dt) {
  // 自动接管时档位清零，前向动量指数泄放（一帧骤停太硬）
  if (auto.on || auto.assist) {
    throttle.gear = 0;
    if (Math.abs(throttle.v) > 0.01) {
      throttle.v *= Math.pow(0.02, dt);
      const sp0 = Math.sin(cam.phi);
      attDir.set(-sp0 * Math.sin(cam.theta), -Math.cos(cam.phi),
                 -sp0 * Math.cos(cam.theta));
      cam.target.addScaledVector(attDir, throttle.v * dt);
      cam.goalTarget.addScaledVector(attDir, throttle.v * dt);
    } else {
      throttle.v = 0;
    }
    return;
  }
  const m = ENGINE.main;
  const err = throttle.gear - throttle.v;
  if (err) {
    // 提速吃 accel、降速吃 brake，都带手动增益
    const speedingUp = throttle.gear * throttle.v >= 0
      && Math.abs(throttle.gear) > Math.abs(throttle.v);
    const cap = (speedingUp ? m.accel : m.brake) * MANUAL_BOOST * dt;
    throttle.v += THREE.MathUtils.clamp(err, -cap, cap);
  }
  if (!throttle.v) return;
  // 沿视线平移 target 与 goal：radius/theta/phi 不变即直线前飞
  const sp = Math.sin(cam.phi);
  attDir.set(-sp * Math.sin(cam.theta), -Math.cos(cam.phi), -sp * Math.cos(cam.theta));
  cam.target.addScaledVector(attDir, throttle.v * dt);
  cam.goalTarget.addScaledVector(attDir, throttle.v * dt);
}

/* ── 虚拟摇杆：左杆调节流档位、右杆偏航俯仰，仅触屏可见 ──────────
   pointermove 只写归一化矢量，消费集中在 frame 的 joyStep 里。
   各自 setPointerCapture 捕获指针，另一手仍可在画布上捏合缩放。 */
const JOY_DEAD = 0.15;
const joys = [
  { el: document.getElementById("joy-left"), vx: 0, vy: 0, id: -1 },
  { el: document.getElementById("joy-right"), vx: 0, vy: 0, id: -1 },
];
let joyActive = 0;

for (const j of joys) {
  const nub = j.el.querySelector(".joy-nub");
  const setNub = (x, y) => {
    nub.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
  };
  const move = (e) => {
    const r = j.el.getBoundingClientRect();
    const max = r.width / 2;
    // rect 是物理视口坐标，圆心与指针都换进旋转坐标系再作差
    const c = toView(r.left + max, r.top + max);
    const p = evPos(e);
    let dx = p.x - c.x;
    let dy = p.y - c.y;
    const len = Math.hypot(dx, dy);
    if (len > max) { dx *= max / len; dy *= max / len; }
    setNub(dx, dy);
    const m = Math.min(len / max, 1);
    if (m < JOY_DEAD) { j.vx = 0; j.vy = 0; return; }
    // 死区外重新归一化到 0..1，起步不跳变
    const s = (m - JOY_DEAD) / (1 - JOY_DEAD) / (m * max);
    j.vx = dx * s; j.vy = dy * s;
  };
  const release = () => {
    if (j.id < 0) return;
    j.id = -1;
    joyActive -= 1;
    j.el.classList.remove("drag");
    j.vx = 0; j.vy = 0;
    setNub(0, 0);
  };
  j.el.addEventListener("pointerdown", (e) => {
    if (j.id >= 0) return;
    j.el.setPointerCapture(e.pointerId);
    j.id = e.pointerId;
    joyActive += 1;
    j.el.classList.add("drag");
    setAuto(false);
    move(e);
  });
  j.el.addEventListener("pointermove", (e) => { if (e.pointerId === j.id) move(e); });
  j.el.addEventListener("pointerup", (e) => { if (e.pointerId === j.id) release(); });
  j.el.addEventListener("pointercancel", (e) => { if (e.pointerId === j.id) release(); });
  addEventListener("blur", release);
}

// 左杆纵轴连续调档，右杆偏航/俯仰（与姿态键同一路径）；无活动摇杆时零开销
function joyStep(dt) {
  if (!joyActive) return;
  const [jl, jr] = joys;
  // 握杆期间新启动的辅助驾驶也要被打断，否则杆量每帧被段插值覆盖
  if (jl.vx || jl.vy || jr.vx || jr.vy) setAuto(false);
  if (jl.vy) {
    // 满杆每秒 400 ly/s
    throttle.gear = THREE.MathUtils.clamp(
      throttle.gear - jl.vy * dt * 400 * SCENE_SCALE, GEAR_MIN, GEAR_MAX);
  }
  if (jr.vx || jr.vy) { att.inYaw -= jr.vx; att.inPitch -= jr.vy; }
}

/* ── 指向线操控：右键/触屏单指按住不放，转向由「光标与屏幕中心的
   距离」决定，而不是拖拽增量——按住不动也会持续转，越靠边转得越快。
   与右摇杆共用 att.inYaw/inPitch 这条输入线路，每帧读当前指针位置。 */
const elSteerLine = document.getElementById("steer-line");
const elSteerDot = document.getElementById("steer-dot");
const STEER_DEAD = 10;    // px，中心附近的死区，免得手抖乱转
const STEER_GRACE = 180;  // ms，按下多久才开始转向，普通点按（约50-300ms）不会误转

function pointerSteerStep() {
  // 单指/右键持续按住时才转向；捏合（两指）与左键选中都不算
  let p = null;
  if (pointers.size === 1) {
    const only = pointers.values().next().value;
    if (only.role === "orbit") p = only;
  }
  if (!p) {
    if (hudSvg.classList.contains("steering")) hudSvg.classList.remove("steering");
    return;
  }
  const cx = vw() / 2, cy = vh() / 2;
  const dx = p.x - cx, dy = p.y - cy;
  const dist = Math.hypot(dx, dy);
  hudSvg.classList.add("steering");
  elSteerLine.setAttribute("x1", cx.toFixed(1)); elSteerLine.setAttribute("y1", cy.toFixed(1));
  elSteerLine.setAttribute("x2", p.x.toFixed(1)); elSteerLine.setAttribute("y2", p.y.toFixed(1));
  elSteerDot.setAttribute("cx", p.x.toFixed(1)); elSteerDot.setAttribute("cy", p.y.toFixed(1));
  // 宽限期内只显示指向线（给按住的反馈），不写入转向，靠近边缘的轻点才不会带出一次机身偏转
  if (dist < STEER_DEAD || performance.now() - p.downAt < STEER_GRACE) return;
  // 死区外线性爬升到量程半径的 35% 处封顶，方向即光标偏移方向
  const R = 0.35 * Math.min(vw(), vh());
  const f = Math.min((dist - STEER_DEAD) / (R - STEER_DEAD), 1);
  att.inYaw -= (dx / dist) * f;
  att.inPitch -= (dy / dist) * f;
}

// 滚轮切档：累计 deltaY 约一格换一档，触发即清零，触控板不会一次跳多档
let wheelAcc = 0;
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  wheelAcc += e.deltaY;
  if (wheelAcc <= -90) { shiftGear(1); wheelAcc = 0; }
  else if (wheelAcc >= 90) { shiftGear(-1); wheelAcc = 0; }
}, { passive: false });

/* ── 光谱型 -> 恒星颜色 ──────────────────────────────
   横轴与数据里的 sp_axis 一致：O=0, B=1, A=2, F=3, G=4, K=5, M=6，
   小数位是次型。取值来自黑体色度的常用近似。 */
const SPECTRAL_RAMP = [
  [0.5, 0.608, 0.690, 1.000],  // O5
  [1.0, 0.635, 0.725, 1.000],  // B0
  [1.5, 0.725, 0.800, 1.000],  // B5
  [2.0, 0.792, 0.847, 1.000],  // A0
  [2.5, 0.871, 0.910, 1.000],  // A5
  [3.0, 0.953, 0.965, 1.000],  // F0
  [3.5, 0.988, 0.988, 1.000],  // F5
  [4.0, 1.000, 0.965, 0.925],  // G0
  [4.5, 1.000, 0.941, 0.871],  // G5
  [5.0, 1.000, 0.894, 0.769],  // K0
  [5.5, 1.000, 0.804, 0.596],  // K5
  [6.0, 1.000, 0.745, 0.498],  // M0
  [6.9, 1.000, 0.588, 0.314],  // M9
];
// 真实恒星色差本就很弱，直接用会是一片白。绕亮度提饱和，把 O..M 的冷暖拉开。
const SATURATION = 2.1;

function spectralColor(axis, out) {
  let i = 0;
  while (i < SPECTRAL_RAMP.length - 2 && axis > SPECTRAL_RAMP[i + 1][0]) i++;
  const a = SPECTRAL_RAMP[i], b = SPECTRAL_RAMP[i + 1];
  const t = THREE.MathUtils.clamp((axis - a[0]) / (b[0] - a[0]), 0, 1);
  const r = a[1] + (b[1] - a[1]) * t;
  const g = a[2] + (b[2] - a[2]) * t;
  const bl = a[3] + (b[3] - a[3]) * t;
  const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
  out[0] = THREE.MathUtils.clamp(lum + (r - lum) * SATURATION, 0, 1);
  out[1] = THREE.MathUtils.clamp(lum + (g - lum) * SATURATION, 0, 1);
  out[2] = THREE.MathUtils.clamp(lum + (bl - lum) * SATURATION, 0, 1);
}

// 光度级 I..III 是巨星/超巨星，半径大得多，给更宽更软的光晕；IV/V 是矮星
const SPECTRAL_LETTER = "OBAFGKM";
function giantness(lumCode) {
  return lumCode >= 1 && lumCode <= 3 ? (4 - lumCode) / 3 : 0;
}

/* ── 载入 ───────────────────────────────────────────── */
const base = new URL(".", import.meta.url);
const ASSETS = ["stars.bin", "edges.bin", "edge_weights.bin", "tracks.json"];

const elBar = document.getElementById("load-bar");
const elPct = document.getElementById("load-pct");

// 响应头的 content-length 是 gzip 后的长度，而流里读到的是解压字节，
// 两者对不上；sizes.json 存的是解压后的真实大小，进度才准。
const assetSizes = await fetch(new URL("data/sizes.json", base))
  .then((r) => r.json())
  .catch(() => null);
const totalBytes = assetSizes
  ? ASSETS.reduce((sum, name) => sum + (assetSizes[name] || 0), 0) : 0;
let loadedBytes = 0;

function reportProgress() {
  if (!totalBytes) return;
  const pct = Math.min(100, Math.round((loadedBytes / totalBytes) * 100));
  elBar.style.width = `${pct}%`;
  elPct.textContent = `${pct}%`;
}

async function fetchTracked(name) {
  const res = await fetch(new URL(`data/${name}`, base));
  if (!res.body || !totalBytes) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.byteLength;
    reportProgress();
  }
  return new Blob(chunks).arrayBuffer();
}

const [starBuf, edgeBuf, weightBuf, metaBuf] =
  await Promise.all(ASSETS.map(fetchTracked));
const meta = JSON.parse(new TextDecoder().decode(metaBuf));
elBar.style.width = "100%";
elPct.textContent = "100%";

const raw = new Float32Array(starBuf);
const N = meta.count;
const edgeIdx = new Uint16Array(edgeBuf);
const edgeW = new Float32Array(weightBuf);
const tracks = meta.tracks;

/* ── 恒星点云 ───────────────────────────────────────── */
const positions = new Float32Array(N * 3);
const colors = new Float32Array(N * 3);
const sizes = new Float32Array(N);
const giants = new Float32Array(N);
const spAxis = new Float32Array(N);
const rgb = [0, 0, 0];

for (let i = 0; i < N; i++) {
  const o = i * STAR_STRIDE;
  positions[i * 3] = raw[o] * SCENE_SCALE;
  positions[i * 3 + 1] = raw[o + 2] * SCENE_SCALE;   // 银道面法向 -> 场景 Y
  positions[i * 3 + 2] = -raw[o + 1] * SCENE_SCALE;
  spAxis[i] = raw[o + 4];
  spectralColor(spAxis[i], rgb);
  colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
  giants[i] = giantness(raw[o + 5]);
  // 视星等 -> 相对光通量，开方后作为半径，避免亮星过分压倒暗星
  sizes[i] = Math.sqrt(Math.pow(10, -0.4 * (raw[o + 3] - 6.4))) * 1.5 + 0.7;
}

const starGeom = new THREE.BufferGeometry();
starGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
starGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
starGeom.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
starGeom.setAttribute("giant", new THREE.BufferAttribute(giants, 1));
starGeom.setAttribute("flare", new THREE.BufferAttribute(new Float32Array(N), 1));

const starMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: {
    uScale: { value: 1 }, uGain: { value: 1 },
    // 相机速度，已除以轨道半径，量纲近似 rad/s
    uCamVel: { value: new THREE.Vector3() },
  },
  vertexShader: `
    attribute float size;
    attribute float flare;
    attribute float giant;
    varying vec3 vColor;
    varying float vFlare;
    varying float vGiant;
    varying float vShift;
    uniform float uScale;
    uniform vec3 uCamVel;
    void main() {
      vColor = color;
      vFlare = flare;
      vGiant = giant;
      // 视向相对速度决定这颗星的偏移量：相机朝它去为正（蓝移），离开为负（红移）
      vec4 world = modelMatrix * vec4(position, 1.0);
      vec3 toStar = normalize(world.xyz - cameraPosition);
      vShift = clamp(dot(uCamVel, toStar) / 1.2, -1.0, 1.0);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float d = max(-mv.z, 0.6);
      float s = size * (1.0 + giant * 0.45);
      gl_PointSize = clamp(s * uScale / d * 26.0, 1.3, 40.0) * (1.0 + flare * 2.0);
    }`,
  fragmentShader: `
    varying vec3 vColor;
    varying float vFlare;
    varying float vGiant;
    varying float vShift;
    uniform float uGain;
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float r = length(p) * 2.0;
      if (r > 1.0) discard;
      // 窄核 + 收敛的晕：晕过宽会让密集区糊成一片白。
      // 巨星/超巨星半径大得多，给更宽更软的晕以示区别。
      float core = pow(1.0 - r, mix(2.8, 2.1, vGiant));
      float halo = pow(1.0 - r, mix(1.6, 1.0, vGiant)) * (0.18 + vGiant * 0.20);
      vec3 c = mix(vColor, vec3(1.0), core * 0.5 + vFlare * 0.4);
      // 逼近的星压红通道（蓝移），退行的星压蓝通道（红移）。
      // 只压不抬，避免加性混合下过曝。
      c *= mix(vec3(1.0), vec3(0.80, 0.93, 1.0), max(vShift, 0.0));
      c *= mix(vec3(1.0), vec3(1.0, 0.90, 0.76), max(-vShift, 0.0));
      gl_FragColor = vec4(c, (core + halo) * (0.88 + vFlare * 1.0) * uGain);
    }`,
});
starMat.vertexColors = true;
const stars = new THREE.Points(starGeom, starMat);
stars.frustumCulled = false;
scene.add(stars);

/* ── 相似度连线 ─────────────────────────────────────── */
const E = edgeIdx.length / 2;
const edgePos = new Float32Array(E * 6);
const edgeAlpha = new Float32Array(E * 2);
const edgeCol = new Float32Array(E * 6);
const neighbours = Array.from({ length: N }, () => []);

for (let e = 0; e < E; e++) {
  const a = edgeIdx[e * 2], b = edgeIdx[e * 2 + 1];
  neighbours[a].push(e); neighbours[b].push(e);
  for (let k = 0; k < 3; k++) {
    edgePos[e * 6 + k] = positions[a * 3 + k];
    edgePos[e * 6 + 3 + k] = positions[b * 3 + k];
  }
  // 相似度越高线越暖
  const w = THREE.MathUtils.clamp((edgeW[e] - 0.28) / 0.5, 0, 1);
  for (const v of [0, 3]) {
    edgeCol[e * 6 + v] = 0.30 + w * 0.62;
    edgeCol[e * 6 + v + 1] = 0.58 - w * 0.06;
    edgeCol[e * 6 + v + 2] = 0.74 - w * 0.26;
  }
  edgeAlpha[e * 2] = edgeAlpha[e * 2 + 1] = EDGE_BASE;
}

const edgeGeom = new THREE.BufferGeometry();
edgeGeom.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
edgeGeom.setAttribute("color", new THREE.BufferAttribute(edgeCol, 3));
edgeGeom.setAttribute("alpha", new THREE.BufferAttribute(edgeAlpha, 1));

const edgeMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uGain: { value: 1 } },
  vertexShader: `
    attribute float alpha;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      vColor = color; vAlpha = alpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vColor; varying float vAlpha;
    uniform float uGain;
    void main() { gl_FragColor = vec4(vColor, vAlpha * uGain); }`,
});
edgeMat.vertexColors = true;
const edgeLines = new THREE.LineSegments(edgeGeom, edgeMat);
edgeLines.frustumCulled = false;
scene.add(edgeLines);

/* ── 背景微尘，给推拉一点纵深参照 ─────────────────────── */
const dustCount = 2600;
const dust = new Float32Array(dustCount * 3);
for (let i = 0; i < dustCount; i++) {
  const r = 400 + Math.random() * 900;
  const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  dust[i * 3] = r * s * Math.cos(a);
  dust[i * 3 + 1] = r * u * 0.42;
  dust[i * 3 + 2] = r * s * Math.sin(a);
}
const dustGeom = new THREE.BufferGeometry();
dustGeom.setAttribute("position", new THREE.BufferAttribute(dust, 3));
const DUST_OPACITY = 0.16;
const dustMat = new THREE.PointsMaterial({
  size: 0.9, sizeAttenuation: false, color: 0x93b6d4,
  transparent: true, opacity: DUST_OPACITY, depthWrite: false,
});
scene.add(new THREE.Points(dustGeom, dustMat));

/* ── 运动拖尾 ───────────────────────────────────────
   乒乓渲染目标做指数滑动平均：本帧 = 上一帧×decay + 场景×(1-decay)。
   总亮度守恒，静止画面不会越积越亮；decay 由相机角速度驱动，
   静止时归零，因此只有移动时才拖尾。 */
// samples 不能省：场景改渲染到离屏目标后就绕开了画布自带的 MSAA，
// 连线会重新出现锯齿，得让目标自己多重采样
const rtOpts = {
  type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  samples: coarse ? 2 : 4,
};
let rtPrev = new THREE.WebGLRenderTarget(2, 2, rtOpts);
let rtNext = new THREE.WebGLRenderTarget(2, 2, rtOpts);

const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadMat = new THREE.ShaderMaterial({
  uniforms: { uTex: { value: null }, uDecay: { value: 0 } },
  depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  // 这里不再统一染色：偏移量已经逐星算过，尾迹自然继承各自的冷暖，
  // 全局染红会把蓝移那侧的尾巴也一起污染
  fragmentShader: `
    uniform sampler2D uTex; uniform float uDecay;
    varying vec2 vUv;
    void main() { gl_FragColor = texture2D(uTex, vUv) * uDecay; }`,
});
const quadScene = new THREE.Scene();
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

function setGain(g) {
  starMat.uniforms.uGain.value = g;
  edgeMat.uniforms.uGain.value = g;
  dustMat.opacity = DUST_OPACITY * g;
}

/* ── 选中与悬停 ─────────────────────────────────────── */
const flare = starGeom.getAttribute("flare");
const projected = new Float32Array(N * 2);
const visible = new Uint8Array(N);
const tmp = new THREE.Vector3();
let selected = -1, hovered = -1;

function project() {
  const w = vw() * 0.5, h = vh() * 0.5;
  for (let i = 0; i < N; i++) {
    tmp.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).project(camera);
    visible[i] = tmp.z > -1 && tmp.z < 1 ? 1 : 0;
    projected[i * 2] = (tmp.x + 1) * w;
    projected[i * 2 + 1] = (1 - tmp.y) * h;
  }
}

function nearest(x, y, maxDist) {
  let best = -1, bestD = maxDist * maxDist;
  for (let i = 0; i < N; i++) {
    if (!visible[i]) continue;
    const dx = projected[i * 2] - x, dy = projected[i * 2 + 1] - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const tooltip = document.getElementById("tooltip");

function clearHover() {
  hovered = -1;
  tooltip.style.opacity = "0";
}

function hover(x, y) {
  const i = nearest(x, y, 15);
  if (i === hovered) {
    if (i >= 0) { tooltip.style.left = `${x + 14}px`; tooltip.style.top = `${y + 14}px`; }
    return;
  }
  hovered = i;
  if (i < 0) { tooltip.style.opacity = "0"; canvas.style.cursor = "grab"; return; }
  canvas.style.cursor = "pointer";
  tooltip.textContent = tracks[i].t;
  tooltip.style.left = `${x + 14}px`;
  tooltip.style.top = `${y + 14}px`;
  tooltip.style.opacity = "1";
}

const panelLeft = document.getElementById("panel-left");
const panelRight = document.getElementById("panel-right");
const elTitle = document.getElementById("title");
const F = Object.fromEntries(["author", "date", "view", "tyc", "sp", "mag"]
  .map((k) => [k, document.getElementById(`f-${k}`)]));
const elLinks = document.getElementById("links");
const elLinkCount = document.getElementById("link-count");
const elLinkList = document.getElementById("link-list");
const elCover = document.getElementById("cover");

const fmt = new Intl.NumberFormat("zh-CN");

function select(i) {
  stopPlayer();
  if (selected >= 0) {
    flare.array[selected] = 0;
    for (const e of neighbours[selected]) {
      edgeAlpha[e * 2] = edgeAlpha[e * 2 + 1] = EDGE_BASE;
    }
  }
  selected = i;
  if (i < 0) {
    panelRight.classList.remove("on");   // 文本面板常驻，只收起播放器
    clearLinks();
    linkLayer.classList.remove("sel");
    flare.needsUpdate = true; edgeGeom.getAttribute("alpha").needsUpdate = true;
    requestAnimationFrame(syncSkew);     // 曲目行隐藏后左板高度骤变
    return;
  }

  flare.array[i] = 1;
  for (const e of neighbours[i]) {
    edgeAlpha[e * 2] = edgeAlpha[e * 2 + 1] = EDGE_LIT;
    const other = edgeIdx[e * 2] === i ? edgeIdx[e * 2 + 1] : edgeIdx[e * 2];
    flare.array[other] = Math.max(flare.array[other], 0.5);
  }
  flare.needsUpdate = true;
  edgeGeom.getAttribute("alpha").needsUpdate = true;

  const t = tracks[i];
  panelRight.classList.add("on");
  elTitle.textContent = t.t;

  // 巡游时照常挂播放器，靠 autoplay=0 让它停在首帧、不出声，
  // 于是背景音乐可以一直放
  mountPlayer(i);

  F.author.textContent = t.a || `UID ${t.u}`;
  F.date.textContent = t.d;
  F.view.textContent = fmt.format(t.v);
  F.tyc.textContent = t.s;
  F.sp.textContent = t.y || "—";
  // 选中标注里的恒星类型字母（O/B/A/F/G/K/M），用该星的光谱色着色
  const cls = (t.y || "").match(/[OBAFGKM]/);
  elRingCls.textContent = cls ? cls[0] : "";
  elRingCls.style.fill = cls
    ? `rgb(${(colors[i * 3] * 255) | 0},${(colors[i * 3 + 1] * 255) | 0},${(colors[i * 3 + 2] * 255) | 0})`
    : "";
  F.mag.textContent = t.m.toFixed(2);
  fillLinks(i);
  requestAnimationFrame(syncSkew);   // 内容高度变了要重算倾角

  // 手动点选走辅助驾驶分段送达；巡游/漫游随后会用自己的段列表覆盖
  if (!auto.on) startAssist(i);
}

const elTargets = document.getElementById("targets");
const TARGET_MAX = 8;        // 每侧四个槽位
const TARGET_SPREAD = 16;    // 槽位在弧上张开的角度

const targetSlots = Array.from({ length: TARGET_MAX }, (_, k) => {
  const el = document.createElement("div");
  el.className = `target ${k < TARGET_MAX / 2 ? "left" : "right"}`;
  el.innerHTML = '<span class="t"></span><span class="w"></span>';
  el.addEventListener("click", () => {
    if (el.dataset.i) select(Number(el.dataset.i));
  });
  elTargets.appendChild(el);
  return el;
});

/* 面板剪影：顶边向中心上扬、底边向中心上扫，同向朝中心收拢；
   内侧边是贴上缘的窄带。两个角度恒定，与面板尺寸无关。
   剪影和描边多边形共用同一组顶点；空板高度不足时内侧带缩成尖劈。 */
const PANEL_TOP_DEG = 4.5;
const PANEL_BOT_DEG = 22;

function syncSkew() {
  for (const [el, innerRight] of [[panelLeft, true], [panelRight, false]]) {
    // rotateY 下 getBoundingClientRect 是投影包围盒，必须用 offset 尺寸
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) continue;
    const drop = Math.min(w * Math.tan((PANEL_TOP_DEG * Math.PI) / 180), h);
    const sweep = w * Math.tan((PANEL_BOT_DEG * Math.PI) / 180);
    const yB = Math.max(h - sweep, 0);
    const pts = innerRight
      ? [[0, drop], [w, 0], [w, yB], [0, h]]
      : [[0, 0], [w, drop], [w, h], [0, yB]];
    el.style.clipPath =
      `polygon(${pts.map(([x, y]) => `${x}px ${y.toFixed(1)}px`).join(", ")})`;
    const edge = el.querySelector(".panel-edge");
    edge.setAttribute("viewBox", `0 0 ${w} ${h}`);
    edge.firstElementChild.setAttribute("points",
      pts.map(([x, y]) => `${x},${y.toFixed(1)}`).join(" "));
  }
  // 内容跟着顶边倾斜：左板向中心上扬取负角，右板镜像取正，文字与顶边平行
  document.documentElement.style.setProperty("--skew-l", `${-PANEL_TOP_DEG}deg`);
  document.documentElement.style.setProperty("--skew-r", `${PANEL_TOP_DEG}deg`);
}
// 面板高度随内容增减，剪影要跟着重算
const panelRO = new ResizeObserver(() => syncSkew());
panelRO.observe(panelLeft);
panelRO.observe(panelRight);

// 触屏窄横屏时槽位弧向内收，给两侧边缘的摇杆让位
function targetArcR() {
  const base = vw() * 0.25;
  return coarse && vw() <= 1100 && vw() > vh()
    ? Math.min(base, Math.max(vw() / 2 - 250, 80)) : base;
}

// 槽位钉在以屏幕中心为圆心、半径约半个屏宽的弧上，与相机无关，只随窗口变化
function layoutTargets() {
  const cx = vw() / 2, cy = vh() / 2;
  const R = targetArcR() + 6;   // 贴在弧的外侧
  const half = TARGET_MAX / 2;
  targetSlots.forEach((el, k) => {
    const j = k % half;
    const off = -TARGET_SPREAD / 2 + (TARGET_SPREAD * j) / (half - 1);
    const deg = (k < half ? 180 : 0) + off;
    const a = (deg * Math.PI) / 180;
    el.style.left = `${(cx + R * Math.cos(a)).toFixed(1)}px`;
    el.style.top = `${(cy + R * Math.sin(a)).toFixed(1)}px`;
  });
}

function fillLinks(i) {
  const rows = neighbours[i]
    .map((e) => ({
      other: edgeIdx[e * 2] === i ? edgeIdx[e * 2 + 1] : edgeIdx[e * 2],
      w: edgeW[e],
    }))
    .sort((a, b) => b.w - a.w)
    .slice(0, TARGET_MAX);
  targetSlots.forEach((el, k) => {
    const r = rows[k];
    if (!r) { el.style.display = "none"; delete el.dataset.i; return; }
    el.style.display = "flex";
    el.dataset.i = r.other;
    el.querySelector(".t").textContent = tracks[r.other].t;
    el.querySelector(".w").textContent = r.w.toFixed(2);
  });
  elTargets.classList.add("on");
  document.body.classList.add("has-sel");
}

function clearLinks() {
  elTargets.classList.remove("on");
  document.body.classList.remove("has-sel");
}

function pick(x, y, focus) {
  const i = nearest(x, y, 16);
  // 取消选中只清标记，不动镜头 —— 回弹会把用户刚调好的视角冲掉
  if (i >= 0) select(i);
  else if (focus) select(-1);
}

/* ── 选中标记：平顶正六边形 + 接到信息框的引线 ─────────
   六边形与引线画在屏幕空间的 SVG 上，这样一端能贴住 DOM 信息框，
   另一端跟住恒星的投影位置，尺寸也不随镜头远近变化。 */
const linkLayer = document.getElementById("link-layer");
const elLeader = document.getElementById("leader");
const elRing = document.getElementById("ring");
const elRingGlow = document.getElementById("ring-glow");
const elHoverRing = document.getElementById("hover-ring");
const elRingDist = document.getElementById("ring-dist");
const elRingCls = document.getElementById("ring-cls");
const RING_R = parseFloat(
  getComputedStyle(document.documentElement).getPropertyValue("--ring-r")) || 19;

// 顶点取 0°/60°/…/300°，于是上下各有一条水平边 —— 平顶六边形
const HEX = Array.from({ length: 6 }, (_, k) => {
  const a = (k * Math.PI) / 3;
  return [Math.cos(a), Math.sin(a)];
});

function hexPoints(cx, cy, r) {
  return HEX.map(([dx, dy]) => `${(cx + dx * r).toFixed(1)},${(cy + dy * r).toFixed(1)}`)
            .join(" ");
}

// 拖尾把星点画成滞后的质心，标记按瞬时投影走会脱节；
// 用拖尾同源的 decay 做同步 EMA，decay=0（静止/防晕）时无平滑
const mark = { sx: 0, sy: 0, hx: 0, hy: 0, sel: -1, hov: -1 };

function updateMarker() {
  const k = 1 - decay;
  // 悬停标记与选中标记同形同尺寸，只靠透明度区分；选中的那颗不重复画
  const showHover = hovered >= 0 && hovered !== selected && visible[hovered];
  if (showHover) {
    const tx = projected[hovered * 2], ty = projected[hovered * 2 + 1];
    if (mark.hov !== hovered) { mark.hx = tx; mark.hy = ty; mark.hov = hovered; }
    else { mark.hx += (tx - mark.hx) * k; mark.hy += (ty - mark.hy) * k; }
    elHoverRing.setAttribute("points", hexPoints(mark.hx, mark.hy, RING_R));
  } else {
    mark.hov = -1;
  }
  linkLayer.classList.toggle("hov", showHover);

  if (selected < 0 || !visible[selected]) {
    mark.sel = -1;
    linkLayer.classList.remove("sel");
    return;
  }
  const px = projected[selected * 2], py = projected[selected * 2 + 1];
  if (mark.sel !== selected) { mark.sx = px; mark.sy = py; mark.sel = selected; }
  else { mark.sx += (px - mark.sx) * k; mark.sy += (py - mark.sy) * k; }
  const sx = mark.sx, sy = mark.sy;
  const pts = hexPoints(sx, sy, RING_R);
  elRing.setAttribute("points", pts);
  elRingGlow.setAttribute("points", pts);

  // 类型字母在左上、距离在右上，基线与平顶六边形的上边取平（0.866R）
  const dLy = camera.position.distanceTo(starVec(selected)) / SCENE_SCALE;
  elRingDist.textContent = `${dLy.toFixed(dLy >= 1000 ? 0 : 1)} ly`;
  const topY = (sy - RING_R * 0.866).toFixed(1);
  elRingCls.setAttribute("x", (sx - RING_R - 5).toFixed(1));
  elRingCls.setAttribute("y", topY);
  elRingDist.setAttribute("x", (sx + RING_R + 5).toFixed(1));
  elRingDist.setAttribute("y", topY);

  // 引线从信息框朝向恒星的那条边引出，止于六边形边缘。
  // 用射线与矩形求交，桌面端的左侧卡片和移动端的底部抽屉都能自然出线。
  let box = panelLeft.getBoundingClientRect();
  // 旋转 body 下 rect 是物理视口坐标，轴对齐换算回旋转坐标系
  if (isFakeLand()) {
    box = { left: box.top, top: innerWidth - box.right,
            width: box.height, height: box.width };
  }
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const vx = sx - cx, vy = sy - cy;
  const hw = box.width / 2 || 1, hh = box.height / 2 || 1;
  const t = 1 / Math.max(Math.abs(vx) / hw, Math.abs(vy) / hh, 1e-6);
  const ax = cx + vx * t, ay = cy + vy * t;

  const dx = sx - ax, dy = sy - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ex = sx - (dx / len) * RING_R, ey = sy - (dy / len) * RING_R;

  // 折角方向跟着出线的那条边：竖边先横走，横边先竖走
  const fromVertical = Math.abs(vx) / hw >= Math.abs(vy) / hh;
  const d = fromVertical
    ? `M${ax.toFixed(1)},${ay.toFixed(1)} L${(ax + (ex - ax) * 0.45).toFixed(1)},${ay.toFixed(1)} `
      + `L${ex.toFixed(1)},${ey.toFixed(1)}`
    : `M${ax.toFixed(1)},${ay.toFixed(1)} L${ax.toFixed(1)},${(ay + (ey - ay) * 0.45).toFixed(1)} `
      + `L${ex.toFixed(1)},${ey.toFixed(1)}`;
  elLeader.setAttribute("d", d);
  linkLayer.classList.add("sel");
}

/* ── 内嵌播放器 ─────────────────────────────────────── */
function stopPlayer() {
  elCover.querySelector("iframe")?.remove();
}

// 选中即挂载，autoplay=0，播放器停在自己的首帧上 —— 封面直接借它的，
// 不必再单独取一张图，也省掉了防盗链那套。
function mountPlayer(i) {
  const t = tracks[i];
  if (!t) return;
  stopPlayer();
  const frame = document.createElement("iframe");
  const q = new URLSearchParams({
    isOutside: "true", bvid: t.b, cid: String(t.i), p: String(t.p),
    autoplay: "0", danmaku: "0", high_quality: "1",
  });
  frame.src = `https://player.bilibili.com/player.html?${q}`;
  frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  frame.allowFullscreen = true;
  frame.scrolling = "no";
  frame.referrerPolicy = "no-referrer";
  frame.addEventListener("load", () => frame.classList.add("on"));
  elCover.appendChild(frame);
}

/* ── 显示选项 ───────────────────────────────────────
   存进 localStorage，刷新后不用重设 */
const optBtn = document.getElementById("opt-btn");
const optsBox = document.getElementById("opts");
const OPTS = {
  reticle: ["o-reticle", "no-reticle", true],
  targets: ["o-targets", "no-targets", true],
  navball: ["o-navball", "no-navball", true],
  footer: ["o-footer", "no-footer", true],
  spin: ["o-spin", null, true],
  safe: ["o-safe", null, false],
};
const opt = {};

function applyOpt(key) {
  const [id, cls] = OPTS[key];
  const el = document.getElementById(id);
  opt[key] = el.checked;
  if (cls) document.body.classList.toggle(cls, !el.checked);
  try { localStorage.setItem(`hud.${key}`, el.checked ? "1" : "0"); } catch { /* 隐私模式 */ }
}

for (const key of Object.keys(OPTS)) {
  const [id, , def] = OPTS[key];
  const el = document.getElementById(id);
  let saved = null;
  try { saved = localStorage.getItem(`hud.${key}`); } catch { /* 隐私模式 */ }
  el.checked = saved === null ? def : saved === "1";
  el.addEventListener("change", () => applyOpt(key));
  applyOpt(key);
}

optBtn.addEventListener("click", () => {
  optsBox.classList.toggle("on");
  optBtn.classList.toggle("on", optsBox.classList.contains("on"));
});

/* ── 自动巡游 / 漫游 ────────────────────────────────
   巡游：聚焦某颗星与随机运镜轮换，偶尔退到全景；
   连续聚焦时有 25% 概率跳到相近曲目，让巡游沿着曲风网络走一段。
   漫游：随机路点间穿行不驻留，偶尔翻转视线或就近展示一颗星。 */
const modeBtns = {
  manual: document.getElementById("mode-manual"),
  cruise: document.getElementById("mode-cruise"),
  wander: document.getElementById("mode-wander"),
};
const bgm = document.getElementById("bgm");

// 曲目顺序即优先级，放完最后一首回到第一首
const BGM_LIST = ["audio/star-wish.m4a", "audio/star-lalala.m4a"];
let bgmIndex = 0;

function loadBgm(i, play) {
  bgmIndex = ((i % BGM_LIST.length) + BGM_LIST.length) % BGM_LIST.length;
  bgm.src = new URL(BGM_LIST[bgmIndex], base).href;
  if (play) bgm.play().catch(() => {});
}
bgm.addEventListener("ended", () => loadBgm(bgmIndex + 1, auto.on));

const auto = {
  on: false, mode: "", t0: 0, lastWasSelect: false,
  segs: null, idx: 0, from: null, engine: "",
  assist: false, canShow: false,
};
const FIELD_R = 26;   // 随机目标点的活动半径，场景单位

const rnd = (a, b) => a + Math.random() * (b - a);
const easeInOut = (u) => u * u * (3 - 2 * u);
// 两端更平缓的五次缓动，转向不会一上来就窜出去
const easeSoft = (u) => u * u * u * (u * (u * 6 - 15) + 10);
const easeIn = (u) => u * u;              // 点火加速
const easeOut = (u) => 1 - (1 - u) * (1 - u);   // 熄火滑行

function snapshotCam() {
  // 取机体实际位形而非 goal：滚轮/拖拽可能让 goal 甩开机体，
  // 段起点若取 goal，直跟分支会把脱开量一口吞成瞬移
  return {
    theta: cam.theta, phi: cam.phi, radius: cam.radius,
    target: cam.target.clone(),
  };
}

/* 瞄准：机位不动，只把注视点转到目标上。
   相机位置由 target + 球面偏移决定，所以要反解出让 P 保持不变的那组
   (theta, phi, radius)，否则"转向"会连人带机一起漂过去。 */
const aimV = new THREE.Vector3();

// atan2 的结果落在 (-pi, pi]，直接插值会在跨越边界时绕远路转一大圈。
// 解缠到离当前角度最近的等价值，转向才走短弧。
function unwrap(target, ref) {
  let d = (target - ref) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return ref + d;
}

function aimFrom(pos, point, thetaRef) {
  aimV.copy(pos).sub(point);
  const r = Math.max(aimV.length(), 1);
  return {
    target: point.clone(),
    radius: r,
    theta: unwrap(Math.atan2(aimV.x, aimV.z), thetaRef),
    phi: Math.acos(THREE.MathUtils.clamp(aimV.y / r, -1, 1)),
  };
}

// 由 (target, theta, phi, radius) 还原机位，给后续段的瞄准反解用
function stateCamPos(s) {
  const sp = Math.sin(s.phi);
  return new THREE.Vector3(
    s.target.x + s.radius * sp * Math.sin(s.theta),
    s.target.y + s.radius * Math.cos(s.phi),
    s.target.z + s.radius * sp * Math.cos(s.theta));
}

// 视线过竖直时把注视点沿水平推开：极区反解 theta 不稳
function levelPoint(pivot, point, minPhi) {
  const dx = pivot.x - point.x, dy = pivot.y - point.y, dz = pivot.z - point.z;
  const r = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const phi = Math.acos(THREE.MathUtils.clamp(dy / r, -1, 1));
  const phiC = THREE.MathUtils.clamp(phi, minPhi, Math.PI - minPhi);
  if (phiC === phi) return point;
  const h = Math.hypot(dx, dz);
  const hC = r * Math.sin(phiC);
  const hx = h > 1e-6 ? dx / h : 1, hz = h > 1e-6 ? dz / h : 0;
  point.set(pivot.x - hx * hC, pivot.y - r * Math.cos(phiC), pivot.z - hz * hC);
  return point;
}

const starPos = new THREE.Vector3();
function starVec(i) {
  return starPos.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
}

// 一次动作拆成若干段依次播放，构成"瞄准 -> 飞过去 -> 停留"的节奏
function startSegs(segs) {
  auto.segs = segs;
  auto.idx = 0;
  auto.from = snapshotCam();
  auto.t0 = performance.now();
}

// 角向段时长：1.9 盖过 easeSoft 峰值斜率 1.875，常数项留给起停斜坡
function angTime(a, b) {
  const ang = Math.max(Math.abs(b.theta - a.theta), Math.abs(b.phi - a.phi));
  return (ang / ENGINE.rcs.angMax) * 1.9 + 0.4;
}

// 主燃时序：对行程 D 取 v = min(方向上限, sqrt(2D·a·b/(a+b)))。
// 触顶时中间有匀速巡航段，必须独立成段——加速+巡航合并在一个 easeIn 里
// 会让段末 goal 速率冲到 2v，仪表读数破引擎上限
function burnPlan(rFrom, rTo) {
  const m = ENGINE.main;
  const D = Math.abs(rTo - rFrom);
  if (D < 1e-6) {
    return { dAcc: 0, dCruise: 0, tAcc: 0.3, tCruise: 0, tRetro: 0.3 };
  }
  const cap = rTo < rFrom ? m.vFwd : m.vRev;
  const v = Math.min(cap, Math.sqrt((2 * D * m.accel * m.brake) / (m.accel + m.brake)));
  const dAcc = (v * v) / (2 * m.accel);
  const dRetro = (v * v) / (2 * m.brake);
  const dCruise = Math.max(0, D - dAcc - dRetro);
  return { dAcc, dCruise, tAcc: v / m.accel,
           tCruise: dCruise / Math.max(v, 1e-3), tRetro: v / m.brake };
}

// 按 burnPlan 生成 主燃(加速)[+巡航]+反推 段列表；theta 弧线按行程占比扫
function burnSegs(fromState, arriveState, plan) {
  const dR = arriveState.radius - fromState.radius;
  const dT = arriveState.theta - fromState.theta;
  const D = Math.abs(dR);
  const fAcc = D > 1e-6 ? plan.dAcc / D : 0.5;
  const fCru = D > 1e-6 ? (plan.dAcc + plan.dCruise) / D : 0.5;
  const mid = (f) => ({ ...arriveState, target: arriveState.target.clone(),
    theta: fromState.theta + dT * f, radius: fromState.radius + dR * f });
  const segs = [{ to: mid(fAcc), dur: plan.tAcc, ease: easeIn, engine: "main" }];
  if (plan.tCruise > 0.05) {
    segs.push({ to: mid(fCru), dur: plan.tCruise, ease: (u) => u, engine: "main" });
  }
  segs.push({ to: arriveState, dur: plan.tRetro, ease: easeOut, engine: "retro" });
  return segs;
}

// 一次机动拆成四段，对应真实的推进时序：
// 矢量喷口转向 -> 主引擎点火加速 -> 反推减速 -> 入轨环绕
// 瞄准段带 pivot：机位钉死，goal 逐帧由注视点反解，段末与 aim 精确衔接
function flyTo(point, finalRadius, holdSec, arcTheta = 0) {
  const from = snapshotCam();
  const pivot = stateCamPos(from);
  levelPoint(pivot, point, 0.12);
  const aim = aimFrom(pivot, point, from.theta);

  // arcTheta 让推进段同时转向，走一条弧线而不是直着往后退
  const arrive = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta, radius: finalRadius };
  // 入轨漂移量受停留时长与 RCS 角速度上限约束，停留短就少转一点
  const orbit = { ...arrive, target: arrive.target.clone(),
                  theta: arrive.theta
                    + Math.min(rnd(0.15, 0.35), holdSec * ENGINE.rcs.angMax * 0.6) };

  const segs = [
    { to: aim, dur: angTime(from, aim), ease: easeSoft, engine: "rcs", pivot },
    ...burnSegs(aim, arrive, burnPlan(aim.radius, finalRadius)),
  ];
  if (holdSec > 0) {
    segs.push({ to: orbit, dur: holdSec, ease: (u) => u, engine: "orbit" });
  }
  return segs;
}

// 全景：一律机头朝前 —— 倒车上限 100 ly/s 拖不动大半径外推。
// 沿背离银心方向外推出系，反推停住后原地掉头回望银心；
// arcTheta 变体把出口方向绕 Y 侧偏，燃烧段再扫一条大弧
function panorama(holdSec, arcTheta = 0) {
  const from = snapshotCam();
  const pivot = stateCamPos(from);
  const out = pivot.clone();
  if (out.length() < 1) out.set(rnd(-1, 1), 0.5, rnd(-1, 1));
  out.normalize();
  if (arcTheta) {
    out.applyAxisAngle(FLIP_UP, (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 0.9));
  }
  // 出口必须在当前机位之外，否则「出系」会变成向心俯冲
  const exitDist = Math.min(430,
    Math.max(rnd(150, 260), pivot.length() * 1.15 + 30));
  const exitPt = out.multiplyScalar(exitDist);
  levelPoint(pivot, exitPt, 0.12);
  const aim = aimFrom(pivot, exitPt, from.theta);
  const nearR = rnd(5, 9);
  const arrive = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta, radius: nearR };
  // 掉头仍是机位反解：注视点回到银心附近，半径自然放大成全景
  const pivotB = stateCamPos(arrive);
  const backPt = new THREE.Vector3(rnd(-8, 8), rnd(-5, 5), rnd(-8, 8));
  levelPoint(pivotB, backPt, 0.15);
  const back = aimFrom(pivotB, backPt, arrive.theta);
  const orbit = { ...back, target: back.target.clone(),
                  theta: back.theta
                    + Math.min(rnd(0.1, 0.25), holdSec * ENGINE.rcs.angMax * 0.6) };
  return [
    { to: aim, dur: angTime(from, aim), ease: easeSoft, engine: "rcs", pivot },
    ...burnSegs(aim, arrive, burnPlan(aim.radius, nearR)),
    { to: back,  dur: angTime(arrive, back), ease: easeSoft, engine: "rcs",
      pivot: pivotB },
    { to: orbit, dur: holdSec,               ease: (u) => u, engine: "orbit" },
  ];
}

const APPROACH_LY = 8.12;   // 自动逼近固定停在这个距离，不再随当前半径浮动

// 手动点选后的辅助驾驶：同一套分段送达，无 orbit 段，任何主动操作打断
function startAssist(i) {
  auto.assist = true;
  startSegs(flyTo(starVec(i), APPROACH_LY * SCENE_SCALE, 0));
}

// 只在决策瞬间线性扫一次全表，禁止逐帧
function nearestStarTo(pos) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < N; i++) {
    const dx = positions[i * 3] - pos.x;
    const dy = positions[i * 3 + 1] - pos.y;
    const dz = positions[i * 3 + 2] - pos.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// 就近展示：转头看向那颗星并短暂驻留，机位钉在 pivot
function wanderShow(i) {
  const from = snapshotCam();
  const pivot = stateCamPos(from);
  const pt = starVec(i).clone();
  levelPoint(pivot, pt, 0.12);
  const aim = aimFrom(pivot, pt, from.theta);
  const hold = rnd(4, 7);
  const orbit = { ...aim, target: aim.target.clone(),
                  theta: aim.theta
                    + Math.min(rnd(0.08, 0.2), hold * ENGINE.rcs.angMax * 0.6) };
  return [
    { to: aim,   dur: angTime(from, aim), ease: easeSoft, engine: "rcs", pivot },
    { to: orbit, dur: hold,               ease: (u) => u, engine: "orbit" },
  ];
}

function nextWander() {
  if (selected >= 0) {
    select(-1);                    // 展示结束，继续赶路
  } else if (auto.canShow && Math.random() < 0.4) {
    auto.canShow = false;
    const i = nearestStarTo(camera.position);
    select(i);
    startSegs(wanderShow(i));
    return;
  }
  auto.canShow = false;
  // 连续小弧度绕行：沿当前航向小角偏转前推；跑出场界时强制朝银心侧回弯
  const from = snapshotCam();
  const pos = stateCamPos(from);
  const heading = from.target.clone().sub(pos);
  heading.y = 0;
  if (heading.lengthSq() < 1e-6) {
    heading.set(-Math.sin(from.theta), 0, -Math.cos(from.theta));
  }
  heading.normalize();
  let sign = Math.random() < 0.5 ? -1 : 1;
  if (pos.length() > FIELD_R * 1.8) {
    // cross(航向, 指心方向).y 的符号即回弯侧
    sign = Math.sign(heading.x * pos.z - heading.z * pos.x) || 1;
  }
  heading.applyAxisAngle(FLIP_UP, sign * rnd(0.15, 0.5));
  const dist = rnd(25, 70);
  const point = pos.clone().addScaledVector(heading, dist);
  point.y = THREE.MathUtils.clamp(pos.y + rnd(-5, 5), -FIELD_R, FIELD_R);
  const arc = (Math.random() < 0.5 ? -1 : 1) * rnd(0.1, 0.3);
  // 终末半径小于路点距离，保证整段向前
  startSegs(flyTo(point, Math.max(6, dist * rnd(0.25, 0.55)), rnd(0.3, 1.0), arc));
  auto.canShow = true;             // 抵达路点后允许就近展示
}

function nextAction() {
  // 上一步是聚焦时，有 25% 概率沿相近曲目走
  if (auto.lastWasSelect && selected >= 0 && Math.random() < 0.25
      && neighbours[selected].length) {
    const e = neighbours[selected][(Math.random() * neighbours[selected].length) | 0];
    const other = edgeIdx[e * 2] === selected ? edgeIdx[e * 2 + 1] : edgeIdx[e * 2];
    select(other);
    startSegs(flyTo(starVec(other), rnd(12, 26), 10));
    auto.lastWasSelect = true;
  } else if (Math.random() < 0.55) {
    const i = (Math.random() * N) | 0;
    select(i);
    startSegs(flyTo(starVec(i), rnd(12, 26), 10));
    auto.lastWasSelect = true;
  } else {
    const wide = Math.random() < 0.18;
    // 纯运镜段不留选中，信息框和引线挂着不动会显得镜头脱节；
    // 但退到全景是例外 —— 那正好用引线把选中的星指出来
    if (!wide) select(-1);
    if (wide) {
      startSegs(panorama(rnd(4, 8), Math.random() < 0.5
        ? 0 : (Math.random() < 0.5 ? -1 : 1) * rnd(1.0, 1.6)));
    } else {
      const point = new THREE.Vector3(rnd(-FIELD_R, FIELD_R),
        rnd(-FIELD_R * 0.4, FIELD_R * 0.4), rnd(-FIELD_R, FIELD_R));
      const arc = (Math.random() < 0.5 ? -1 : 1) * rnd(0.2, 0.7);
      startSegs(flyTo(point, rnd(20, 90), rnd(2.5, 6.0), arc));
    }
    auto.lastWasSelect = false;
  }
}

const lookPoint = new THREE.Vector3();
const pivD0 = new THREE.Vector3();
const pivD1 = new THREE.Vector3();
const pivAxis = new THREE.Vector3();
function stepAuto() {
  if (!auto.on && !auto.assist) { auto.engine = ""; return; }
  if (!auto.segs || auto.idx >= auto.segs.length) {
    if (auto.assist) { auto.assist = false; auto.segs = null; auto.engine = ""; return; }
    if (auto.mode === "wander") nextWander(); else nextAction();
    return;
  }

  const seg = auto.segs[auto.idx];
  auto.engine = seg.engine;
  const raw = (performance.now() - auto.t0) / (seg.dur * 1000);
  const u = seg.ease(THREE.MathUtils.clamp(raw, 0, 1));
  const f = auto.from, t = seg.to;
  if (seg.pivot) {
    // 机位钉死在 pivot：注视「方向」做球面插值、距离线性插值，逐帧反解。
    // 注视点走直线弦在转角近 180° 时会穿过机位——半径塌缩、视线甩鞭
    pivD0.copy(f.target).sub(seg.pivot);
    pivD1.copy(t.target).sub(seg.pivot);
    const r0 = Math.max(pivD0.length(), 1e-4), r1 = Math.max(pivD1.length(), 1e-4);
    pivD0.divideScalar(r0); pivD1.divideScalar(r1);
    const ang = Math.acos(THREE.MathUtils.clamp(pivD0.dot(pivD1), -1, 1));
    pivAxis.crossVectors(pivD0, pivD1);
    if (pivAxis.lengthSq() < 1e-8) {
      // 近反向共线：绕世界 Y 掉头；视线本身近竖直时退回绕 X
      pivAxis.copy(Math.abs(pivD0.y) < 0.95 ? FLIP_UP : FLIP_RIGHT);
      pivAxis.addScaledVector(pivD0, -pivAxis.dot(pivD0));
    }
    pivAxis.normalize();
    lookPoint.copy(pivD0).applyAxisAngle(pivAxis, ang * u)
      .multiplyScalar(r0 + (r1 - r0) * u).add(seg.pivot);
    const g = aimFrom(seg.pivot, lookPoint, cam.goalTheta);
    cam.goalTheta = g.theta;
    cam.goalPhi = g.phi;
    cam.goalRadius = g.radius;
    cam.goalTarget.copy(g.target);
  } else {
    cam.goalTheta = f.theta + (t.theta - f.theta) * u;
    cam.goalPhi = f.phi + (t.phi - f.phi) * u;
    // 恒加速模型下 r 随时间是缓动×线性，半径走线性插值
    cam.goalRadius = f.radius + (t.radius - f.radius) * u;
    cam.goalTarget.lerpVectors(f.target, t.target, u);
  }

  if (raw >= 1) {
    auto.from = { ...t, target: t.target.clone() };
    auto.idx += 1;
    auto.t0 = performance.now();
  }
}

function setAuto(on, mode = "cruise") {
  // 任何入口都先取消辅助驾驶段，早退之前就得清掉
  if (auto.assist) { auto.assist = false; auto.segs = null; auto.engine = ""; }
  if (auto.on === on && (!on || auto.mode === mode)) return;
  auto.on = on;
  auto.mode = on ? mode : "";
  document.body.classList.toggle("auto", on && mode === "cruise");
  document.body.classList.toggle("wander", on && mode === "wander");
  for (const [k, el] of Object.entries(modeBtns)) {
    el.classList.toggle("cur", on ? k === mode : k === "manual");
  }
  refreshBgmName();
  if (on) {
    auto.segs = null;
    auto.engine = "";
    auto.lastWasSelect = false;
    auto.canShow = false;
    bgm.volume = 0.55;
    if (!bgm.src) loadBgm(0, false);
    bgm.play().catch(() => {});    // 自动播放被拦就静默跳过
  } else {
    bgm.pause();
  }
}

// 三段式切换：巡游/漫游互斥，两类皆无即手动
modeBtns.manual.addEventListener("click", () => setAuto(false));
modeBtns.cruise.addEventListener("click", () => setAuto(true, "cruise"));
modeBtns.wander.addEventListener("click", () => setAuto(true, "wander"));
// 任何主动操作都退出巡游
for (const ev of ["pointerdown", "wheel"]) {
  canvas.addEventListener(ev, () => setAuto(false), { passive: true });
}
addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;   // 搜索框里打 wasd 不算飞行操作
  if (ATT_KEYS[e.code]) setAuto(false);
});

/* ── 搜索 ───────────────────────────────────────────── */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 预折叠成小写检索串，避免每次按键都重新拼
const haystack = tracks.map((t) =>
  `${t.t}${t.a}${t.s}${t.u}`.toLowerCase());

/* 延长药丸：点放大镜后药丸自身横向展开露出内嵌输入框，
   再点/Esc/失焦收回；收起时清空输入并藏结果 */
const searchWrap = document.getElementById("search-wrap");
const searchBtn = document.getElementById("search-btn");
const elSearch = document.getElementById("search");
const elResults = document.getElementById("results");
let hits = [], cursor = -1;

function openSearch() {
  searchWrap.classList.add("on");
  elSearch.focus();
}

function closeSearch() {
  searchWrap.classList.remove("on");
  elSearch.value = "";
  hits = []; cursor = -1;
  elResults.classList.remove("on");
  if (document.activeElement === elSearch) elSearch.blur();
}

searchBtn.addEventListener("click", () => {
  if (searchWrap.classList.contains("on")) closeSearch();
  else openSearch();
});
// 药丸内按下不抢输入框焦点：失焦收起才不会被按钮/结果行误触发
searchWrap.addEventListener("pointerdown", (e) => {
  if (e.target !== elSearch) e.preventDefault();
});
elSearch.addEventListener("blur", () => closeSearch());

function highlight(text, q) {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return escapeHtml(text);
  return escapeHtml(text.slice(0, i))
       + "<mark>" + escapeHtml(text.slice(i, i + q.length)) + "</mark>"
       + escapeHtml(text.slice(i + q.length));
}

function runSearch() {
  const q = elSearch.value.trim().toLowerCase();
  cursor = -1;
  if (q.length < 1) { elResults.classList.remove("on"); hits = []; return; }

  hits = [];
  for (let i = 0; i < haystack.length && hits.length < 40; i++) {
    if (haystack[i].includes(q)) hits.push(i);
  }
  elResults.classList.add("on");
  if (!hits.length) {
    elResults.innerHTML = '<div class="none">没有匹配的曲目</div>';
    return;
  }
  elResults.innerHTML = hits.map((i) => {
    const t = tracks[i];
    const who = t.a || `UID ${t.u}`;
    return `<div class="hit" data-i="${i}">`
         + `<span class="n">${highlight(t.t, q)}</span>`
         + `<span class="s">${highlight(who, q)} · ${highlight(t.s, q)}`
         + ` · ${fmt.format(Math.round(t.l))} 光年</span></div>`;
  }).join("");
}

function moveCursor(step) {
  if (!hits.length) return;
  cursor = (cursor + step + hits.length) % hits.length;
  [...elResults.children].forEach((el, k) => el.classList.toggle("cur", k === cursor));
  elResults.children[cursor]?.scrollIntoView({ block: "nearest" });
}

function chooseHit(i) {
  select(i);
  elResults.classList.remove("on");
  elSearch.blur();
}

elSearch.addEventListener("input", runSearch);
elSearch.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); }
  else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); }
  else if (e.key === "Enter") {
    e.preventDefault();
    if (hits.length) chooseHit(hits[cursor >= 0 ? cursor : 0]);
  } else if (e.key === "Escape") {
    closeSearch();
  }
});
elResults.addEventListener("click", (e) => {
  const row = e.target.closest(".hit");
  if (row) chooseHit(Number(row.dataset.i));
});
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== elSearch) {
    e.preventDefault();
    openSearch();
  }
});

/* ── 底部弧形仪表 ───────────────────────────────────
   两条同心弧画在视口下方的圆心上，只露出顶部一小段。
   内弧是速度（三角游标），外弧是当前曲目进度。 */
const hudSvg = document.getElementById("hud");
const arcBgmBg = document.getElementById("arc-bgm-bg");
const arcBgm = document.getElementById("arc-bgm");
const arcSpeedBg = document.getElementById("arc-speed-bg");
const speedTicks = document.getElementById("speed-ticks");
const speedMark = document.getElementById("speed-mark");
const speedSet = document.getElementById("speed-set");
const speedZero = document.getElementById("speed-zero");
const labels = document.getElementById("hud-labels");
const arcTgtL = document.getElementById("arc-tgt-l");
const arcTgtR = document.getElementById("arc-tgt-r");
const elBgmName = document.getElementById("f-bgm");
const elSpeed = document.getElementById("speed-readout");
const ICONS = Object.fromEntries(["main", "rcs", "auto", "lock", "rev"]
  .map((k) => [k, document.getElementById(`ic-${k}`)]));

// 弧心在屏幕中心略上方，弧长 90 度、以正下方为中点：右半段前进、左半段倒车
const A_SPAN = 90, A_MID = 90;
const A0 = A_MID + A_SPAN / 2;   // 左端（倒车满）
const A1 = A_MID - A_SPAN / 2;   // 右端（前进满）
// 零点放在弧长 1/5 处：倒车上限只有 100 ly/s，不该占太多刻度
const A_ZERO = A0 + (A1 - A0) / 5;
const SPEED_FULL = 1000;         // 量程上限 ly/s，即主引擎前进上限
const REV_FULL = 100;            // 倒车上限 ly/s，独立归一才能把 1/5 区占满
const SPEED_GAMMA = 0.42;        // <1 使低速段更精细，指针在起步阶段更敏感

const polar = (cx, cy, r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arcPath(cx, cy, r, d0, d1) {
  const [x0, y0] = polar(cx, cy, r, d0);
  const [x1, y1] = polar(cx, cy, r, d1);
  const large = Math.abs(d1 - d0) > 180 ? 1 : 0;
  const sweep = d1 > d0 ? 1 : 0;
  return `M${x0.toFixed(1)},${y0.toFixed(1)} `
       + `A${r},${r} 0 ${large} ${sweep} ${x1.toFixed(1)},${y1.toFixed(1)}`;
}

let hudGeom = null;
function layoutHud() {
  const w = vw(), h = vh();
  hudSvg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  // 圆心仍在屏幕中心略上方；半径缩到 1/3 后再高就会和准星叠在一起
  const cx = w / 2, cy = h * 0.48;
  const rSpeed = Math.min(h * 0.38, w * 0.3) / 3;
  const rBgm = rSpeed + 24;      // 中间那圈留给速度读数
  hudGeom = { cx, cy, rSpeed, rBgm };

  arcSpeedBg.setAttribute("d", arcPath(cx, cy, rSpeed, A0, A1));
  arcBgmBg.setAttribute("d", arcPath(cx, cy, rBgm, A0, A1));
  arcBgm.setAttribute("d", arcPath(cx, cy, rBgm, A0, A1));
  arcBgm.style.strokeDasharray = `0 ${arcBgm.getTotalLength()}`;

  const [zx0, zy0] = polar(cx, cy, rSpeed - 7, A_ZERO);
  const [zx1, zy1] = polar(cx, cy, rSpeed + 4, A_ZERO);
  speedZero.setAttribute("x1", zx0.toFixed(1)); speedZero.setAttribute("y1", zy0.toFixed(1));
  speedZero.setAttribute("x2", zx1.toFixed(1)); speedZero.setAttribute("y2", zy1.toFixed(1));

  speedTicks.innerHTML = Array.from({ length: 9 }, (_, k) => {
    const d = A0 + ((A1 - A0) * k) / 8;
    const [ax, ay] = polar(cx, cy, rSpeed - 6, d);
    const [bx, by] = polar(cx, cy, rSpeed - (k % 4 === 0 ? 14 : 10), d);
    return `<line class="tick" x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}"`
         + ` x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}"/>`;
  }).join("");

  labels.style.top = `${(cy + rBgm + 18).toFixed(0)}px`;
  elSpeed.style.left = `${cx.toFixed(0)}px`;
  elSpeed.style.top = `${(cy + rSpeed + 12).toFixed(0)}px`;

  // 攻击指示器的内圈弧，贴在槽位弧的内侧
  const rt = targetArcR();
  const half = TARGET_SPREAD / 2;
  arcTgtL.setAttribute("d", arcPath(cx, h / 2, rt, 180 - half, 180 + half));
  arcTgtR.setAttribute("d", arcPath(cx, h / 2, rt, -half, half));
}

let shownSpeed = 0;
function updateHud(signedSpeed, dt, angRate, radRateSmooth) {
  if (!hudGeom) return;
  const { cx, cy, rSpeed } = hudGeom;

  // 阻尼：时间常数固定，指针跟得慢一点、有配重感
  shownSpeed += (signedSpeed - shownSpeed) * (1 - Math.pow(0.05, dt));
  // 幂压缩量程（指数 <1），低速段分辨率更高；正反各自按自己的上限归一，
  // 倒车才能在只占 1/5 弧长的区间里也走到底
  const arcOf = (v) => {
    const full = v >= 0 ? SPEED_FULL : REV_FULL;
    const mag = THREE.MathUtils.clamp(Math.pow(Math.abs(v) / full, SPEED_GAMMA), 0, 1);
    const f = Math.sign(v) * mag;
    return f >= 0 ? A_ZERO + (A1 - A_ZERO) * f : A_ZERO + (A_ZERO - A0) * f;
  };
  // 游标嵌在两条弧之间的缝里。尺寸按像素给，否则半径一缩角度宽度就失真
  const triPts = (deg) => {
    const rad = (deg * Math.PI) / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad);    // 径向
    const tanx = -uy, tany = ux;                      // 切向
    const mid = rSpeed - 3;      // 略微内移，免得顶到外环
    const p = (ar, at) =>
      `${(cx + ux * ar + tanx * at).toFixed(1)},${(cy + uy * ar + tany * at).toFixed(1)}`;
    return `${p(mid + 5, 0)} ${p(mid, -4.5)} ${p(mid, 4.5)}`;
  };
  // 实心三角=实际速度，空心三角=节流目标档位，同一量程映射
  speedMark.setAttribute("points", triPts(arcOf(shownSpeed)));
  speedSet.setAttribute("points", triPts(arcOf(throttle.gear / SCENE_SCALE)));

  const rev = shownSpeed < -1;
  hudSvg.classList.toggle("rev", rev);
  document.body.classList.toggle("rev", rev);

  // 矢量喷口看视角是否在动；主引擎看是否在明显靠近目标
  const turning = angRate > 0.12;
  const closing = radRateSmooth < -Math.max(3, Math.abs(shownSpeed) * 0.15);
  const vt = throttle.v / SCENE_SCALE;   // ly/s
  const gearErr = Math.abs(throttle.gear - throttle.v) / SCENE_SCALE;
  // 自动/辅助驾驶亮推进程序对应的灯，orbit 段全灭；
  // 手动：姿态灯看角速率，主推灯看节流收敛，反推灯看倒档（启发式兜底）
  const eng = auto.on || auto.assist ? auto.engine : "";
  const attRate = Math.abs(att.yaw) + Math.abs(att.pitch);
  ICONS.rcs.classList.toggle("on", eng ? eng === "rcs" : (attRate > 0.04 || turning));
  ICONS.main.classList.toggle("on", eng ? eng === "main"
    : (Math.abs(vt) > 1 || gearErr > 1 || closing));
  ICONS.auto.classList.toggle("on", auto.on);
  ICONS.lock.classList.toggle("on", selected >= 0);
  ICONS.rev.classList.toggle("on", eng ? eng === "retro" : (vt < -0.5 || rev));
  const abs = Math.abs(shownSpeed);
  elSpeed.innerHTML = `${abs.toFixed(abs < 100 ? 1 : 0)} <em>ly/s</em>`;

  const total = arcBgm.getTotalLength();
  const pr = bgm.duration ? THREE.MathUtils.clamp(bgm.currentTime / bgm.duration, 0, 1) : 0;
  arcBgm.style.strokeDasharray = `${(total * pr).toFixed(1)} ${total.toFixed(1)}`;
}

const BGM_TITLE = { "star-wish.m4a": "星愿 StarWish", "star-lalala.m4a": "StarLaLaLa" };
function refreshBgmName() {
  const f = (bgm.currentSrc || "").split("/").pop();
  const name = bgm.paused ? "—" : (BGM_TITLE[f] || "—");
  elBgmName.textContent = name;
  document.body.classList.toggle("bgm-on", !bgm.paused);
  requestAnimationFrame(syncSkew);   // 「正在播放」行的增删会改左板高度
}
bgm.addEventListener("loadedmetadata", refreshBgmName);
bgm.addEventListener("play", refreshBgmName);
bgm.addEventListener("pause", refreshBgmName);

/* ── 主循环 ─────────────────────────────────────────── */

function resize() {
  const w = vw(), h = vh();
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  starMat.uniforms.uScale.value = h / 900;
  const dpr = renderer.getPixelRatio();
  rtPrev.setSize(w * dpr, h * dpr);
  rtNext.setSize(w * dpr, h * dpr);
  layoutHud();
  layoutTargets();
  syncSkew();
}
addEventListener("resize", resize);
// 伪横屏切换等同一次视口尺寸变化
fakeLandMq.addEventListener("change", () => { resize(); showRotateToast(); });
resize();
showRotateToast();

let prev = performance.now();
let decay = 0;
const lastCamPos = new THREE.Vector3();
const camVel = new THREE.Vector3();
const worldVel = new THREE.Vector3();
let lastRadius = cam.radius;
let lastTheta = cam.theta;
let lastPhi = cam.phi;
let radRateSmooth = 0;

function frame(now) {
  // 下界不能省：dt 为负会让下面的 pow 指数翻转，平滑系数变成负数，decay 发散
  const dt = THREE.MathUtils.clamp((now - prev) / 1000, 1 / 240, 0.1);
  prev = now;
  stepAuto();
  if (opt.spin && !dragging && held.size === 0 && !auto.on && !joyActive)
    cam.goalTheta += dt * 0.012;
  joyStep(dt);          // 杆量先落进姿态/节流输入
  pointerSteerStep();   // 指向线同一路输入
  steerCenterStep();    // 中键长按转向银心，同一路输入
  attitudeStep(dt);
  throttleStep(dt);
  applyCamera(dt);
  project();
  updateMarker();
  renderNavBall();

  // 位移除以轨道半径 -> 角速度，与场景尺度无关，推拉和旋转都能算进去。
  // 同一个位移量再作为速度矢量喂给着色器，用于逐星的视向多普勒偏移。
  camVel.subVectors(camera.position, lastCamPos)
        .divideScalar(Math.max(dt, 1e-3) * Math.max(cam.radius, 1));
  const speed = camVel.length();
  // 倒车判据用轨道半径的变化率：拉远即倒车。
  // 用视向分量会过于敏感 —— 选中飞入时相机绕到目标另一侧也会瞬间判成倒车。
  worldVel.subVectors(camera.position, lastCamPos).divideScalar(Math.max(dt, 1e-3));
  const totalSpeed = worldVel.length() / SCENE_SCALE;
  const radRate = (cam.radius - lastRadius) / Math.max(dt, 1e-3) / SCENE_SCALE;
  radRateSmooth += (radRate - radRateSmooth) * (1 - Math.pow(0.02, dt));
  const angRate = (Math.abs(cam.theta - lastTheta) + Math.abs(cam.phi - lastPhi))
                / Math.max(dt, 1e-3);
  lastRadius = cam.radius; lastTheta = cam.theta; lastPhi = cam.phi;
  // 退而不转才算倒车；一边外推一边转向是主引擎在画弧（比如退到全景）。
  // 手动时以节流 v 的符号为准，径向启发式只作兜底
  let backing = radRate > totalSpeed * 0.25 && angRate < 0.10;
  if (!auto.on && !auto.assist && Math.abs(throttle.v) > 0.5 * SCENE_SCALE)
    backing = throttle.v < 0;
  const signedSpeed = backing ? -totalSpeed : totalSpeed;
  lastCamPos.copy(camera.position);
  starMat.uniforms.uCamVel.value.copy(camVel);
  updateHud(signedSpeed, dt, angRate, radRateSmooth);

  const excess = Math.max(speed - TRAIL_DEADZONE, 0);
  const want = THREE.MathUtils.clamp(
    TRAIL_K * Math.pow(excess, TRAIL_EXP), 0, TRAIL_MAX);
  decay = opt.safe ? 0 : THREE.MathUtils.clamp(
    decay + (want - decay) * (1 - Math.pow(0.002, dt)), 0, TRAIL_MAX);

  // 上一帧衰减后写入 rtNext，场景以 (1-decay) 的增益叠加其上
  renderer.setRenderTarget(rtNext);
  renderer.clear(true, true, true);
  quadMat.uniforms.uTex.value = rtPrev.texture;
  quadMat.uniforms.uDecay.value = decay;
  renderer.render(quadScene, quadCam);
  // 严格能量守恒（gain = 1-decay）会把尾巴压到看不见；留一部分累积，
  // 让星点在移动时拉出更亮的光迹，静止时 decay=0 自动回到原亮度
  setGain(1 - decay * 0.7);
  renderer.render(scene, camera);

  renderer.setRenderTarget(null);
  renderer.clear(true, true, true);
  quadMat.uniforms.uTex.value = rtNext.texture;
  quadMat.uniforms.uDecay.value = 1;
  renderer.render(quadScene, quadCam);

  const swap = rtPrev; rtPrev = rtNext; rtNext = swap;
  requestAnimationFrame(frame);
}

document.getElementById("loading").classList.add("done");
requestAnimationFrame(frame);

/* ── 全屏 ───────────────────────────────────────────── */
const fsBtn = document.getElementById("fs-btn");
if (document.documentElement.requestFullscreen) {
  fsBtn.hidden = false;
  fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.documentElement.requestFullscreen()
        .then(() => screen.orientation?.lock?.("landscape")?.catch(() => {}))
        .catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fsBtn.classList.toggle("on", !!document.fullscreenElement);
  });
}

/* ── 姿态指示器：底部中央圆形仪表 ─────────────────────
   独立小渲染器渲到 #attitude；场景根节点每帧取主相机四元数的共轭，
   世界在仪表中反向旋转，等价机头姿态仪（含滚转）。
   正交相机近远平面裁掉背半球，环与点云只显示面朝的一侧；
   到目标的指向线走全量程相机（layer 1），背向时也保留投影方向。 */
const navCanvas = document.getElementById("attitude");
const navRenderer = new THREE.WebGLRenderer(
  { canvas: navCanvas, antialias: true, alpha: true });
navRenderer.setPixelRatio(Math.min(devicePixelRatio, 2));
navRenderer.autoClear = false;
const navScene = new THREE.Scene();
const navRoot = new THREE.Group();
navScene.add(navRoot);
const navCam = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, -0.03, 1.2);
const navCamFull = new THREE.OrthographicCamera(-1.12, 1.12, 1.12, -1.12, -1.2, 1.2);
navCamFull.layers.set(1);

// 银道水平面：XZ 参考圆环 + 十字细线
const NAV_R = 0.95;
const navRing = new THREE.BufferGeometry().setFromPoints(
  Array.from({ length: 65 }, (_, k) => {
    const a = (k / 64) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * NAV_R, 0, Math.sin(a) * NAV_R);
  }));
navRoot.add(new THREE.Line(navRing, new THREE.LineBasicMaterial(
  { color: 0x93b6d4, transparent: true, opacity: 0.5 })));
const navCross = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-NAV_R, 0, 0), new THREE.Vector3(NAV_R, 0, 0),
  new THREE.Vector3(0, 0, -NAV_R), new THREE.Vector3(0, 0, NAV_R),
]);
navRoot.add(new THREE.LineSegments(navCross, new THREE.LineBasicMaterial(
  { color: 0x93b6d4, transparent: true, opacity: 0.2 })));

// XYZ 短轴线与端点：X/Z 蓝灰、Y（银道法向）金色
const NAV_AXES = [
  [new THREE.Vector3(1, 0, 0), 0x7ea8cc],
  [new THREE.Vector3(0, 1, 0), 0xf2c84b],
  [new THREE.Vector3(0, 0, 1), 0x7ea8cc],
];
const navTipPos = [];
const navTipCol = [];
for (const [dir, color] of NAV_AXES) {
  const g = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(), dir.clone().multiplyScalar(0.55)]);
  navRoot.add(new THREE.Line(g, new THREE.LineBasicMaterial(
    { color, transparent: true, opacity: 0.85 })));
  navTipPos.push(dir.x * 0.55, dir.y * 0.55, dir.z * 0.55);
  const c = new THREE.Color(color);
  navTipCol.push(c.r, c.g, c.b);
}
const navTips = new THREE.BufferGeometry();
navTips.setAttribute("position",
  new THREE.BufferAttribute(new Float32Array(navTipPos), 3));
navTips.setAttribute("color",
  new THREE.BufferAttribute(new Float32Array(navTipCol), 3));
navRoot.add(new THREE.Points(navTips, new THREE.PointsMaterial(
  { size: 3, sizeAttenuation: false, vertexColors: true,
    transparent: true, opacity: 0.95, depthWrite: false })));

// 星团抽样微点云：按方向投到单位球面，方向感参照，几何一次构建
const navStride = Math.max(1, Math.round(N / 400));
const navStars = [];
for (let i = 0; i < N; i += navStride) {
  const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
  const l = Math.hypot(x, y, z);
  if (l < 1e-4) continue;
  navStars.push((x / l) * 0.92, (y / l) * 0.92, (z / l) * 0.92);
}
const navCloud = new THREE.BufferGeometry();
navCloud.setAttribute("position",
  new THREE.BufferAttribute(new Float32Array(navStars), 3));
navRoot.add(new THREE.Points(navCloud, new THREE.PointsMaterial(
  { color: 0xcfe0f2, size: 1, sizeAttenuation: false,
    transparent: true, opacity: 0.38, depthWrite: false })));

// 到目标的金色指向线：选中时从球心指向该星方向
const navTgtGeom = new THREE.BufferGeometry();
navTgtGeom.setAttribute("position",
  new THREE.BufferAttribute(new Float32Array(6), 3));
const navTgt = new THREE.Line(navTgtGeom, new THREE.LineBasicMaterial(
  { color: 0xf2c84b, transparent: true, opacity: 0.9 }));
navTgt.layers.set(1);
navTgt.visible = false;
navRoot.add(navTgt);

const navDir = new THREE.Vector3();
let navW = 0, navH = 0;

function renderNavBall() {
  if (!opt.navball) return;
  const w = navCanvas.clientWidth, h = navCanvas.clientHeight;
  if (!w || !h) return;
  if (w !== navW || h !== navH) {
    navW = w; navH = h;
    navRenderer.setSize(w, h, false);
  }
  navRoot.quaternion.copy(camera.quaternion).invert();
  if (selected >= 0) {
    navDir.set(positions[selected * 3], positions[selected * 3 + 1],
               positions[selected * 3 + 2]).sub(camera.position);
    const l = navDir.length();
    navTgt.visible = l > 1e-4;
    if (navTgt.visible) {
      navDir.multiplyScalar(NAV_R / l);
      const a = navTgtGeom.getAttribute("position");
      a.setXYZ(1, navDir.x, navDir.y, navDir.z);
      a.needsUpdate = true;
    }
  } else {
    navTgt.visible = false;
  }
  navRenderer.clear(true, true, true);
  navRenderer.render(navScene, navCam);
  navRenderer.render(navScene, navCamFull);
}

/* ── 操作指南弹窗：首访自动弹出，显示菜单可重开 ──────── */
const helpModal = document.getElementById("help-modal");
const helpClose = document.getElementById("help-close");
const helpOpen = document.getElementById("help-open");

// 弹窗只挡「新」输入（捕获阶段 keydown + 遮罩挡 canvas 指针），
// 已经按住的键、已经设定的档位不会被冻结——开窗时顺手清掉，
// 免得飞船在弹窗背后继续滚转/巡航
function openHelp() {
  helpModal.hidden = false;
  held.clear();
  throttle.gear = 0; throttle.v = 0;
  midHeld = false; steerCenter = false; clearTimeout(midTimer);
}
function closeHelp() { helpModal.hidden = true; }

helpClose.addEventListener("click", closeHelp);
helpModal.addEventListener("click", (e) => {
  if (e.target === helpModal) closeHelp();
});
helpOpen.addEventListener("click", () => {
  optsBox.classList.remove("on");
  optBtn.classList.remove("on");
  openHelp();
});
// 弹窗打开期间捕获按键：Esc 关闭，其余不落到飞行/搜索快捷键
addEventListener("keydown", (e) => {
  if (helpModal.hidden) return;
  if (e.key === "Escape") closeHelp();
  e.stopPropagation();
}, true);

let helpSeen = false;
try { helpSeen = !!localStorage.getItem("hud.helpSeen"); } catch { /* 隐私模式 */ }
if (!helpSeen) {
  try { localStorage.setItem("hud.helpSeen", "1"); } catch { /* 隐私模式 */ }
  openHelp();
}
