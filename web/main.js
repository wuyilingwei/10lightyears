import * as THREE from "three";

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
  minRadius: 2, maxRadius: 420,
};

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
    cam.theta += (cam.goalTheta - cam.theta) * k;   // theta 已解缠，可直接插
    cam.phi = THREE.MathUtils.clamp(
      cam.phi + (cam.goalPhi - cam.phi) * k, 0.04, Math.PI - 0.04);
    cam.radius += (cam.goalRadius - cam.radius) * k;
    cam.target.lerp(cam.goalTarget, k);
    vel.theta = vel.phi = vel.r = vel.pan = 0;
  } else {
    [cam.theta, vel.theta] = approach(cam.theta, vel.theta, cam.goalTheta,
      ENGINE.rcs.angAccel, ENGINE.rcs.angMax, dt);
    [cam.phi, vel.phi] = approach(cam.phi, vel.phi, cam.goalPhi,
      ENGINE.rcs.angAccel, ENGINE.rcs.angMax, dt);
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
  pointers.set(e.pointerId,
    { x: e.clientX, y: e.clientY, moved: 0, type: e.pointerType, role });
  dragging = true;
  resetPinch();
  clearHover();                 // 拖拽期间不更新悬停，留着会是个跟错星的虚框
  elResults.classList.remove("on");
});

canvas.addEventListener("pointermove", (e) => {
  const p = pointers.get(e.pointerId);
  if (!p) { if (canHover) hover(e.clientX, e.clientY); return; }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.moved += Math.abs(dx) + Math.abs(dy);
  p.x = e.clientX; p.y = e.clientY;

  if (pointers.size === 1) {
    if (p.role !== "orbit") return;      // 左键拖动不转视角
    cam.goalTheta -= dx * 0.0042;
    cam.goalPhi = THREE.MathUtils.clamp(cam.goalPhi - dy * 0.0042, 0.04, Math.PI - 0.04);
  } else if (pointers.size === 2) {
    const s = pinchState();
    if (pinch) {
      if (s.d > 1 && pinch.d > 1) {
        cam.goalRadius = THREE.MathUtils.clamp(
          cam.goalRadius * (pinch.d / s.d), cam.minRadius, cam.maxRadius);
      }
      panScreen(-(s.mx - pinch.mx), s.my - pinch.my);
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
    pick(e.clientX, e.clientY, true);
  }
}
canvas.addEventListener("pointerup", (e) => endPointer(e, true));
canvas.addEventListener("pointercancel", (e) => endPointer(e, false));
/* WASD 沿当前视角平移，视点不再钉在原点 */
const held = new Set();
const PAN_KEYS = { KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right" };
const panRight = new THREE.Vector3();
const panUp = new THREE.Vector3();

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (PAN_KEYS[e.code]) { held.add(PAN_KEYS[e.code]); e.preventDefault(); }
});
addEventListener("keyup", (e) => {
  if (PAN_KEYS[e.code]) held.delete(PAN_KEYS[e.code]);
});
// 任何会夺走键盘焦点的动作都可能让 keyup 丢失，键就永远卡在按下状态。
// 右键菜单是最容易触发的一种，这里把所有出口都兜住。
addEventListener("blur", () => held.clear());
addEventListener("contextmenu", () => held.clear());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) held.clear();
});

const panScratch = new THREE.Vector3();

// 沿屏幕平面平移视点，dx/dy 为场景单位
function panScreen(dx, dy) {
  if (dx === 0 && dy === 0) return;
  camera.matrixWorld.extractBasis(panRight, panUp, panScratch);
  cam.goalTarget.addScaledVector(panRight, dx);
  cam.goalTarget.addScaledVector(panUp, dy);
}

// 步长取平移引擎绝对上限，goal 不甩开引擎
function pan(dt) {
  if (held.size === 0) return;
  const step = ENGINE.rcs.panMax * dt;
  panScreen(
    (held.has("right") ? step : 0) - (held.has("left") ? step : 0),
    (held.has("up") ? step : 0) - (held.has("down") ? step : 0));
}

/* ── 虚拟摇杆：左杆平移、右杆转视角，仅触屏可见 ──────────
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
    let dx = e.clientX - (r.left + max);
    let dy = e.clientY - (r.top + max);
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

// 左杆等效 WASD 平移，右杆转视角；无活动摇杆时零开销
function joyStep(dt) {
  if (!joyActive) return;
  const [jl, jr] = joys;
  // 握杆期间新启动的辅助驾驶也要被打断，否则杆量每帧被段插值覆盖
  if (jl.vx || jl.vy || jr.vx || jr.vy) setAuto(false);
  if (jl.vx || jl.vy) {
    const step = ENGINE.rcs.panMax * dt;
    panScreen(jl.vx * step, -jl.vy * step);
  }
  if (jr.vx || jr.vy) {
    // 满偏 0.5 rad/s，略低于 RCS 角速度上限（π/6），goal 不甩开引擎
    cam.goalTheta -= jr.vx * dt * 0.5;
    cam.goalPhi = THREE.MathUtils.clamp(
      cam.goalPhi - jr.vy * dt * 0.5, 0.04, Math.PI - 0.04);
  }
}

// 滚轮不直接改半径，而是喂给一个会衰减的缩放速度，滑起来有惯性
let zoomVel = 0;
const ZOOM_KEEP = 0.006;   // 每秒保留比例
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  zoomVel += e.deltaY * 0.0016;
}, { passive: false });

function stepZoom(dt) {
  if (Math.abs(zoomVel) < 1e-4) { zoomVel = 0; return; }
  cam.goalRadius = THREE.MathUtils.clamp(
    cam.goalRadius * Math.exp(zoomVel * dt * 5), cam.minRadius, cam.maxRadius);
  zoomVel *= Math.pow(ZOOM_KEEP, dt);
}

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
  const w = innerWidth * 0.5, h = innerHeight * 0.5;
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

/* 面板平行四边形：两板共用同一屏幕斜率（内侧边高、外侧边矮），
   高度差按各自实测宽高比换算；rotateY 之后 getBoundingClientRect
   是投影后的包围盒，必须用 offsetWidth/offsetHeight */
const PANEL_SLOPE = 0.14;                                    // tan(倾角)

function syncSkew() {
  const root = document.documentElement.style;
  for (const [el, skewVar, sign] of [
    [panelLeft, "--skew-l", -1],
    [panelRight, "--skew-r", 1],
  ]) {
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) continue;
    // 高度不足以达到统一斜率时收在 45%，内容倾角跟随实际边缘
    const d = Math.min(((PANEL_SLOPE * w) / h) * 100, 45);
    const skew = (Math.atan(((d / 100) * h) / w) * 180) / Math.PI;
    const lo = d.toFixed(2), hi = (100 - d).toFixed(2);
    // sign<0 为左板：右缘是内侧边；右板镜像
    el.style.clipPath = sign < 0
      ? `polygon(0 ${lo}%, 100% 0, 100% ${hi}%, 0 100%)`
      : `polygon(0 0, 100% ${lo}%, 100% 100%, 0 ${hi}%)`;
    el.querySelector(".panel-edge polygon")?.setAttribute("points", sign < 0
      ? `0,${lo} 100,0 100,${hi} 0,100`
      : `0,0 100,${lo} 100,100 0,${hi}`);
    root.setProperty(skewVar, `${(sign * skew).toFixed(2)}deg`);
  }
}

// 触屏窄横屏时槽位弧向内收，给两侧边缘的摇杆让位
function targetArcR() {
  const base = innerWidth * 0.25;
  return coarse && innerWidth <= 1100 && innerWidth > innerHeight
    ? Math.min(base, Math.max(innerWidth / 2 - 250, 80)) : base;
}

// 槽位钉在以屏幕中心为圆心、半径约半个屏宽的弧上，与相机无关，只随窗口变化
function layoutTargets() {
  const cx = innerWidth / 2, cy = innerHeight / 2;
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

function updateMarker() {
  // 悬停标记与选中标记同形同尺寸，只靠透明度区分；选中的那颗不重复画
  const showHover = hovered >= 0 && hovered !== selected && visible[hovered];
  if (showHover) {
    elHoverRing.setAttribute("points", hexPoints(
      projected[hovered * 2], projected[hovered * 2 + 1], RING_R));
  }
  linkLayer.classList.toggle("hov", showHover);

  if (selected < 0 || !visible[selected]) {
    linkLayer.classList.remove("sel");
    return;
  }
  const sx = projected[selected * 2], sy = projected[selected * 2 + 1];
  const pts = hexPoints(sx, sy, RING_R);
  elRing.setAttribute("points", pts);
  elRingGlow.setAttribute("points", pts);

  // 引线从信息框朝向恒星的那条边引出，止于六边形边缘。
  // 用射线与矩形求交，桌面端的左侧卡片和移动端的底部抽屉都能自然出线。
  const box = panelLeft.getBoundingClientRect();
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
  return {
    theta: cam.goalTheta, phi: cam.goalPhi, radius: cam.goalRadius,
    target: cam.goalTarget.clone(),
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
function aimAt(point) { return aimFrom(camera.position, point, cam.goalTheta); }

// 由 (target, theta, phi, radius) 还原机位，给后续段的瞄准反解用
function stateCamPos(s) {
  const sp = Math.sin(s.phi);
  return new THREE.Vector3(
    s.target.x + s.radius * sp * Math.sin(s.theta),
    s.target.y + s.radius * Math.cos(s.phi),
    s.target.z + s.radius * sp * Math.cos(s.theta));
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

// 主燃+反推时序：对行程 D 取 v = min(方向上限, sqrt(2D·a·b/(a+b)))，
// 反推行程 v²/2b 反出主燃占比 split；恒加/减速下 easeIn/easeOut 即精确位形
function burnPlan(rFrom, rTo) {
  const m = ENGINE.main;
  const D = Math.abs(rTo - rFrom);
  if (D < 1e-6) return { split: 0.5, tMain: 0.3, tRetro: 0.3 };
  const cap = rTo < rFrom ? m.vFwd : m.vRev;
  const v = Math.min(cap, Math.sqrt((2 * D * m.accel * m.brake) / (m.accel + m.brake)));
  const dRetro = (v * v) / (2 * m.brake);
  const split = (D - dRetro) / D;
  // 触到速度上限才有匀速巡航项，否则为零
  const tMain = v / m.accel
    + Math.max(0, D - (v * v) / (2 * m.accel) - dRetro) / Math.max(v, 1e-3);
  return { split, tMain, tRetro: v / m.brake };
}

// 一次机动拆成四段，对应真实的推进时序：
// 矢量喷口转向 -> 主引擎点火加速 -> 反推减速 -> 入轨环绕
function flyTo(point, finalRadius, holdSec, arcTheta = 0) {
  const from = snapshotCam();
  const aim = aimAt(point);
  aim.radius *= rnd(0.95, 1.0);            // 转向时喷口带来的少许位移
  aim.theta += arcTheta * 0.25 + rnd(-0.05, 0.05);   // 先把机头摆进弧线
  aim.phi = THREE.MathUtils.clamp(aim.phi + rnd(-0.03, 0.03), 0.3, Math.PI - 0.3);

  // arcTheta 让推进段同时转向，走一条弧线而不是直着往后退；
  // 恒加速模型在 r 空间是二次曲线×线性插值，切分点直接落在线性 r 上
  const plan = burnPlan(aim.radius, finalRadius);
  const cruise = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta * plan.split,
                   radius: aim.radius + (finalRadius - aim.radius) * plan.split };
  const arrive = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta, radius: finalRadius };
  // 入轨漂移量受停留时长与 RCS 角速度上限约束，停留短就少转一点
  const orbit = { ...arrive, target: arrive.target.clone(),
                  theta: arrive.theta
                    + Math.min(rnd(0.15, 0.35), holdSec * ENGINE.rcs.angMax * 0.6) };

  const segs = [
    { to: aim,    dur: angTime(from, aim), ease: easeSoft, engine: "rcs" },
    { to: cruise, dur: plan.tMain,         ease: easeIn,   engine: "main" },
    { to: arrive, dur: plan.tRetro,        ease: easeOut,  engine: "retro" },
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
  const out = camera.position.clone();
  if (out.length() < 1) out.set(rnd(-1, 1), 0.5, rnd(-1, 1));
  out.normalize();
  if (arcTheta) {
    out.applyAxisAngle(FLIP_UP, (Math.random() < 0.5 ? -1 : 1) * rnd(0.5, 0.9));
  }
  const aim = aimAt(out.multiplyScalar(rnd(150, 260)));
  const nearR = rnd(5, 9);
  const plan = burnPlan(aim.radius, nearR);
  const cruise = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta * plan.split,
                   radius: aim.radius + (nearR - aim.radius) * plan.split };
  const arrive = { ...aim, target: aim.target.clone(),
                   theta: aim.theta + arcTheta, radius: nearR };
  // 掉头仍是机位反解：注视点回到银心附近，半径自然放大成全景
  const back = aimFrom(stateCamPos(arrive),
    new THREE.Vector3(rnd(-8, 8), rnd(-5, 5), rnd(-8, 8)), arrive.theta);
  back.phi = THREE.MathUtils.clamp(back.phi, 0.15, Math.PI - 0.15);
  const orbit = { ...back, target: back.target.clone(),
                  theta: back.theta
                    + Math.min(rnd(0.1, 0.25), holdSec * ENGINE.rcs.angMax * 0.6) };
  return [
    { to: aim,    dur: angTime(from, aim),    ease: easeSoft, engine: "rcs" },
    { to: cruise, dur: plan.tMain,            ease: easeIn,   engine: "main" },
    { to: arrive, dur: plan.tRetro,           ease: easeOut,  engine: "retro" },
    { to: back,   dur: angTime(arrive, back), ease: easeSoft, engine: "rcs" },
    { to: orbit,  dur: holdSec,               ease: (u) => u, engine: "orbit" },
  ];
}

// 手动点选后的辅助驾驶：同一套分段送达，无 orbit 段，任何主动操作打断
function startAssist(i) {
  const finalR = Math.max(cam.minRadius, Math.min(cam.goalRadius, 26));
  auto.assist = true;
  startSegs(flyTo(starVec(i), finalR, 0));
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

// 纯喷口翻转：机位保持，把视线方向甩向另一边。
// 只改 theta 会变成绕注视点的轨道横扫，必须用 aimFrom 反解换注视点。
const FLIP_UP = new THREE.Vector3(0, 1, 0);
function wanderFlip() {
  const from = snapshotCam();
  const pos = stateCamPos(from);
  const dir = from.target.clone().sub(pos).normalize();
  dir.applyAxisAngle(FLIP_UP, (Math.random() < 0.5 ? -1 : 1) * rnd(0.6, 1.6));
  dir.y = THREE.MathUtils.clamp(dir.y + rnd(-0.35, 0.35), -0.85, 0.85);
  const to = aimFrom(pos,
    pos.clone().addScaledVector(dir.normalize(), rnd(20, 60)), from.theta);
  to.phi = THREE.MathUtils.clamp(to.phi, 0.3, Math.PI - 0.3);
  return [{ to, dur: angTime(from, to), ease: easeSoft, engine: "rcs" }];
}

// 就近展示：转头看向那颗星并短暂驻留
function wanderShow(i) {
  const from = snapshotCam();
  const aim = aimAt(starVec(i));
  const hold = rnd(4, 7);
  const orbit = { ...aim, target: aim.target.clone(),
                  theta: aim.theta
                    + Math.min(rnd(0.08, 0.2), hold * ENGINE.rcs.angMax * 0.6) };
  return [
    { to: aim,   dur: angTime(from, aim), ease: easeSoft, engine: "rcs" },
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
  if (Math.random() < 0.2) { startSegs(wanderFlip()); return; }
  const far = Math.random() < 0.25;
  const R = FIELD_R * (far ? rnd(1.6, 3.0) : rnd(0.35, 1.0));
  const point = new THREE.Vector3(
    rnd(-R, R), rnd(-R * 0.4, R * 0.4), rnd(-R, R));
  const arc = (Math.random() < 0.5 ? -1 : 1) * rnd(0.15, 0.6);
  startSegs(flyTo(point, rnd(14, 60), rnd(0.3, 1.0), arc));
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
  cam.goalTheta = f.theta + (t.theta - f.theta) * u;
  cam.goalPhi = f.phi + (t.phi - f.phi) * u;
  // 恒加速模型下 r 随时间是缓动×线性，半径走线性插值
  cam.goalRadius = f.radius + (t.radius - f.radius) * u;
  cam.goalTarget.lerpVectors(f.target, t.target, u);

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
  if (PAN_KEYS[e.code]) setAuto(false);
});

/* ── 搜索 ───────────────────────────────────────────── */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 预折叠成小写检索串，避免每次按键都重新拼
const haystack = tracks.map((t) =>
  `${t.t}${t.a}${t.s}${t.u}`.toLowerCase());

const searchBtn = document.getElementById("search-btn");
const searchBox = document.getElementById("search-box");
searchBtn.addEventListener("click", () => {
  const on = !searchBox.classList.contains("on");
  searchBox.classList.toggle("on", on);
  searchBtn.classList.toggle("on", on);
  if (on) document.getElementById("search").focus();
});

const elSearch = document.getElementById("search");
const elResults = document.getElementById("results");
let hits = [], cursor = -1;

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
    elSearch.value = ""; elResults.classList.remove("on"); elSearch.blur();
    searchBox.classList.remove("on"); searchBtn.classList.remove("on");
  }
});
elResults.addEventListener("click", (e) => {
  const row = e.target.closest(".hit");
  if (row) chooseHit(Number(row.dataset.i));
});
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== elSearch) {
    e.preventDefault();
    searchBox.classList.add("on"); searchBtn.classList.add("on");
    elSearch.focus();
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
// 零点放在弧长 1/4 处：倒车用得少，正向该占四分之三
const A_ZERO = A0 + (A1 - A0) / 4;
const SPEED_FULL = 1000;         // 量程上限 ly/s，即主引擎前进上限

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
  const w = innerWidth, h = innerHeight;
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
  arcTgtL.setAttribute("d", arcPath(cx, innerHeight / 2, rt, 180 - half, 180 + half));
  arcTgtR.setAttribute("d", arcPath(cx, innerHeight / 2, rt, -half, half));
}

let shownSpeed = 0;
function updateHud(signedSpeed, dt, angRate, radRateSmooth) {
  if (!hudGeom) return;
  const { cx, cy, rSpeed } = hudGeom;

  // 阻尼：时间常数固定，指针跟得慢一点、有配重感
  shownSpeed += (signedSpeed - shownSpeed) * (1 - Math.pow(0.05, dt));
  // 开方压缩量程，低速段才有分辨率；符号决定落在中点的哪一侧
  const mag = THREE.MathUtils.clamp(Math.sqrt(Math.abs(shownSpeed) / SPEED_FULL), 0, 1);
  const f = Math.sign(shownSpeed) * mag;
  const d = f >= 0 ? A_ZERO + (A1 - A_ZERO) * f : A_ZERO + (A_ZERO - A0) * f;

  // 游标嵌在两条弧之间的缝里。尺寸按像素给，否则半径一缩角度宽度就失真
  const rad = (d * Math.PI) / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);      // 径向
  const tanx = -uy, tany = ux;                        // 切向
  const mid = rSpeed - 3;        // 略微内移，免得顶到外环
  const tri = (ar, at) =>
    `${(cx + ux * ar + tanx * at).toFixed(1)},${(cy + uy * ar + tany * at).toFixed(1)}`;
  speedMark.setAttribute("points",
    `${tri(mid + 5, 0)} ${tri(mid, -4.5)} ${tri(mid, 4.5)}`);

  const rev = shownSpeed < -1;
  hudSvg.classList.toggle("rev", rev);
  document.body.classList.toggle("rev", rev);

  // 矢量喷口看视角是否在动；主引擎看是否在明显靠近目标
  const turning = angRate > 0.12;
  const closing = radRateSmooth < -Math.max(3, Math.abs(shownSpeed) * 0.15);
  // 自动/辅助驾驶亮推进程序对应的灯，orbit 段全灭；手动亮实测判据
  const eng = auto.on || auto.assist ? auto.engine : "";
  ICONS.rcs.classList.toggle("on", eng ? eng === "rcs" : turning);
  ICONS.main.classList.toggle("on", eng ? eng === "main" : closing);
  ICONS.auto.classList.toggle("on", auto.on);
  ICONS.lock.classList.toggle("on", selected >= 0);
  ICONS.rev.classList.toggle("on", eng ? eng === "retro" : rev);
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
  const w = innerWidth, h = innerHeight;
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
resize();

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
  stepZoom(dt);
  pan(dt);
  joyStep(dt);
  applyCamera(dt);
  project();
  updateMarker();

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
  // 退而不转才算倒车；一边外推一边转向是主引擎在画弧（比如退到全景）
  const backing = radRate > totalSpeed * 0.25 && angRate < 0.10;
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
