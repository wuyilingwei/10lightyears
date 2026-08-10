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

function applyCamera(dt) {
  const k = 1 - Math.pow(0.0022, dt);
  cam.theta += (cam.goalTheta - cam.theta) * k;
  cam.phi += (cam.goalPhi - cam.phi) * k;
  cam.radius += (cam.goalRadius - cam.radius) * k;
  cam.target.lerp(cam.goalTarget, k);

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
  if (e.pointerType === "mouse" && e.button !== 0) return;   // 只有左键参与
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: 0, type: e.pointerType });
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
  if (tap && p.moved < (TAP_SLOP[p.type] ?? 8)) pick(e.clientX, e.clientY, true);
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

// 沿屏幕平面平移视点。步长随轨道半径缩放，远近手感一致。
function panScreen(dx, dy) {
  if (dx === 0 && dy === 0) return;
  camera.matrixWorld.extractBasis(panRight, panUp, panScratch);
  cam.goalTarget.addScaledVector(panRight, dx);
  cam.goalTarget.addScaledVector(panUp, dy);
}

function pan(dt) {
  if (held.size === 0) return;
  const step = cam.radius * 0.9 * dt;
  panScreen(
    (held.has("right") ? step : 0) - (held.has("left") ? step : 0),
    (held.has("up") ? step : 0) - (held.has("down") ? step : 0));
}

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  cam.goalRadius = THREE.MathUtils.clamp(
    cam.goalRadius * Math.exp(e.deltaY * 0.0014), cam.minRadius, cam.maxRadius);
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

const infobox = document.getElementById("infobox");
const elTitle = document.getElementById("title");
const elAuthor = document.getElementById("author");
const elMeta = document.getElementById("meta");
const elStar = document.getElementById("star-line");
const elLinks = document.getElementById("links");
const elLinkCount = document.getElementById("link-count");
const elLinkList = document.getElementById("link-list");
const elCover = document.getElementById("cover");
const elPoster = document.getElementById("poster");
const CDN = meta.cdn || "https://i0.hdslb.com/";
const COVER_VARIANT = "@640w_400h_1c.webp";

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
    infobox.classList.remove("on");
    linkLayer.classList.remove("sel");
    flare.needsUpdate = true; edgeGeom.getAttribute("alpha").needsUpdate = true;
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
  infobox.classList.add("on");
  elTitle.textContent = t.t;

  // 巡游时用静态封面：挂 iframe 会和背景音乐抢声道，也白白拉一堆请求
  if (auto.on) {
    stopPlayer();
    elPoster.classList.remove("on");
    if (t.c) {
      elPoster.onload = () => elPoster.classList.add("on");
      elPoster.src = CDN + t.c + COVER_VARIANT;
    } else {
      elPoster.removeAttribute("src");
    }
  } else {
    elPoster.classList.remove("on");
    elPoster.removeAttribute("src");
    mountPlayer(i);
  }

  elAuthor.innerHTML = t.a
    ? `<em>UP 主</em>${escapeHtml(t.a)}`
    : `<em>UP 主</em>UID ${t.u}`;
  elMeta.innerHTML = `投稿 <b>${t.d}</b> · 播放 <b>${fmt.format(t.v)}</b>`;
  const sp = t.y ? ` · ${t.y}` : "";
  elStar.textContent =
    `${t.s}${sp} · ${fmt.format(Math.round(t.l))} 光年 · 视星等 ${t.m}`;
  fillLinks(i);

  cam.goalTarget.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  cam.goalRadius = Math.max(cam.minRadius, Math.min(cam.goalRadius, 26));
}

function fillLinks(i) {
  const rows = neighbours[i]
    .map((e) => ({
      other: edgeIdx[e * 2] === i ? edgeIdx[e * 2 + 1] : edgeIdx[e * 2],
      w: edgeW[e],
    }))
    .sort((a, b) => b.w - a.w);
  elLinkCount.textContent = rows.length;
  elLinkList.innerHTML = rows.map((r) =>
    `<div class="link" data-i="${r.other}">`
    + `<span class="t">${escapeHtml(tracks[r.other].t)}</span>`
    + `<span class="w">${r.w.toFixed(2)}</span></div>`).join("");
  elLinks.open = false;
}

elLinkList.addEventListener("click", (e) => {
  const row = e.target.closest(".link");
  if (row) select(Number(row.dataset.i));
});

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
  const box = infobox.getBoundingClientRect();
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

/* ── 自动巡游 ───────────────────────────────────────
   两类动作轮换：聚焦某颗星（10s）、或在一定范围内随机移动/旋转（5-10s）。
   连续聚焦时有 25% 概率跳到相近曲目，让巡游沿着曲风网络走一段。 */
const autoBtn = document.getElementById("auto-btn");
const bgm = document.getElementById("bgm");

const auto = {
  on: false, t0: 0, t1: 0, lastWasSelect: false,
  from: null, to: null,
};
const FIELD_R = 26;   // 随机目标点的活动半径，场景单位

const rnd = (a, b) => a + Math.random() * (b - a);
const easeInOut = (u) => u * u * (3 - 2 * u);

function snapshotCam() {
  return {
    theta: cam.goalTheta, phi: cam.goalPhi, radius: cam.goalRadius,
    target: cam.goalTarget.clone(),
  };
}

function focusStar(i, seconds) {
  select(i);
  const to = snapshotCam();
  to.target.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  to.radius = rnd(14, 34);
  to.theta = cam.goalTheta + rnd(-0.9, 0.9);
  to.phi = THREE.MathUtils.clamp(cam.goalPhi + rnd(-0.3, 0.3), 0.35, Math.PI - 0.35);
  return { to, seconds };
}

function nextAction() {
  const now = performance.now();
  auto.from = snapshotCam();

  // 上一步是聚焦时，有 25% 概率沿相近曲目走
  let plan;
  if (auto.lastWasSelect && selected >= 0 && Math.random() < 0.25
      && neighbours[selected].length) {
    const e = neighbours[selected][(Math.random() * neighbours[selected].length) | 0];
    const other = edgeIdx[e * 2] === selected ? edgeIdx[e * 2 + 1] : edgeIdx[e * 2];
    plan = focusStar(other, 10);
    auto.lastWasSelect = true;
  } else if (Math.random() < 0.55) {
    plan = focusStar((Math.random() * N) | 0, 10);
    auto.lastWasSelect = true;
  } else {
    // 移动 / 旋转 / 两者兼有，外加偶尔一次退到远景
    const to = snapshotCam();
    const mode = Math.random();
    const wide = Math.random() < 0.18;
    if (mode < 0.66) {                       // 含移动
      to.target.set(rnd(-FIELD_R, FIELD_R), rnd(-FIELD_R * 0.4, FIELD_R * 0.4),
                    rnd(-FIELD_R, FIELD_R));
    }
    if (mode > 0.33) {                       // 含旋转
      to.theta = cam.goalTheta + rnd(-1.6, 1.6);
      to.phi = THREE.MathUtils.clamp(cam.goalPhi + rnd(-0.5, 0.5), 0.3, Math.PI - 0.3);
    }
    to.radius = wide ? rnd(150, 260) : rnd(20, 90);
    plan = { to, seconds: rnd(5, 10) };
    auto.lastWasSelect = false;
  }

  auto.to = plan.to;
  auto.t0 = now;
  auto.t1 = now + plan.seconds * 1000;
}

function stepAuto() {
  if (!auto.on) return;
  const now = performance.now();
  if (!auto.to || now >= auto.t1) { nextAction(); return; }
  const u = easeInOut(THREE.MathUtils.clamp((now - auto.t0) / (auto.t1 - auto.t0), 0, 1));
  const f = auto.from, t = auto.to;
  cam.goalTheta = f.theta + (t.theta - f.theta) * u;
  cam.goalPhi = f.phi + (t.phi - f.phi) * u;
  cam.goalRadius = f.radius + (t.radius - f.radius) * u;
  cam.goalTarget.lerpVectors(f.target, t.target, u);
}

function setAuto(on) {
  if (auto.on === on) return;
  auto.on = on;
  document.body.classList.toggle("auto", on);
  autoBtn.textContent = on ? "退出巡游" : "自动巡游";
  if (on) {
    auto.to = null;
    auto.lastWasSelect = false;
    bgm.volume = 0.55;
    bgm.play().catch(() => {});    // 自动播放被拦就静默跳过
    if (selected >= 0) select(selected);   // 换成静态封面
  } else {
    bgm.pause();
    if (selected >= 0) select(selected);   // 换回播放器
  }
}

autoBtn.addEventListener("click", () => setAuto(!auto.on));
// 任何主动操作都退出巡游
for (const ev of ["pointerdown", "wheel"]) {
  canvas.addEventListener(ev, () => setAuto(false), { passive: true });
}
addEventListener("keydown", (e) => { if (PAN_KEYS[e.code]) setAuto(false); });

/* ── 搜索 ───────────────────────────────────────────── */
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// 预折叠成小写检索串，避免每次按键都重新拼
const haystack = tracks.map((t) =>
  `${t.t}${t.a}${t.s}${t.u}`.toLowerCase());

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
  }
});
elResults.addEventListener("click", (e) => {
  const row = e.target.closest(".hit");
  if (row) chooseHit(Number(row.dataset.i));
});
addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== elSearch) {
    e.preventDefault(); elSearch.focus();
  }
});

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
}
addEventListener("resize", resize);
resize();

let prev = performance.now();
let decay = 0;
const lastCamPos = new THREE.Vector3();
const camVel = new THREE.Vector3();

function frame(now) {
  // 下界不能省：dt 为负会让下面的 pow 指数翻转，平滑系数变成负数，decay 发散
  const dt = THREE.MathUtils.clamp((now - prev) / 1000, 1 / 240, 0.1);
  prev = now;
  stepAuto();
  if (!dragging && held.size === 0 && !auto.on) cam.goalTheta += dt * 0.012;  // 缓慢自转
  pan(dt);
  applyCamera(dt);
  project();
  updateMarker();

  // 位移除以轨道半径 -> 角速度，与场景尺度无关，推拉和旋转都能算进去。
  // 同一个位移量再作为速度矢量喂给着色器，用于逐星的视向多普勒偏移。
  camVel.subVectors(camera.position, lastCamPos)
        .divideScalar(Math.max(dt, 1e-3) * Math.max(cam.radius, 1));
  const speed = camVel.length();
  lastCamPos.copy(camera.position);
  starMat.uniforms.uCamVel.value.copy(camVel);

  const excess = Math.max(speed - TRAIL_DEADZONE, 0);
  const want = THREE.MathUtils.clamp(
    TRAIL_K * Math.pow(excess, TRAIL_EXP), 0, TRAIL_MAX);
  decay = THREE.MathUtils.clamp(
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
