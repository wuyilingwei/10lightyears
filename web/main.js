import * as THREE from "three";

const SCENE_SCALE = 1 / 12;      // ly -> scene units
const STAR_STRIDE = 6;           // gx, gy, gz, vt_mag, bv_color, label
const EDGE_BASE = 0.006;         // resting opacity of the similarity graph
const EDGE_LIT = 0.9;

const canvas = document.getElementById("stage");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 20000);

/* ── 相机控制：轨道 + 推拉 + 平滑聚焦 ───────────────────── */
const cam = {
  target: new THREE.Vector3(),
  goalTarget: new THREE.Vector3(),
  theta: 0.7, phi: 1.22, radius: 54,
  goalTheta: 0.7, goalPhi: 1.22, goalRadius: 54,
  minRadius: 2, maxRadius: 420,
};
const ORIGIN = new THREE.Vector3();

function applyCamera(dt) {
  // pulling back past the bulk of the field re-centres it, otherwise the disc
  // drifts off-frame around whichever star was last selected
  if (cam.radius > 130) cam.goalTarget.lerp(ORIGIN, 1 - Math.pow(0.06, dt));
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

let dragging = false, lastX = 0, lastY = 0, moved = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true; moved = 0; lastX = e.clientX; lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.releasePointerCapture(e.pointerId);
  if (moved < 5) pick(e.clientX, e.clientY, true);
});
canvas.addEventListener("pointermove", (e) => {
  if (dragging) {
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = e.clientX; lastY = e.clientY;
    cam.goalTheta -= dx * 0.0042;
    cam.goalPhi = THREE.MathUtils.clamp(cam.goalPhi - dy * 0.0042, 0.04, Math.PI - 0.04);
  } else {
    hover(e.clientX, e.clientY);
  }
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  cam.goalRadius = THREE.MathUtils.clamp(
    cam.goalRadius * Math.exp(e.deltaY * 0.0014), cam.minRadius, cam.maxRadius);
}, { passive: false });

/* ── B-V 色指数 -> 恒星颜色 ──────────────────────────── */
const COLOR_RAMP = [
  [-0.35, 0.61, 0.73, 1.00], [0.00, 0.82, 0.88, 1.00], [0.30, 0.96, 0.96, 1.00],
  [0.58, 1.00, 0.97, 0.90], [0.81, 1.00, 0.89, 0.75], [1.15, 1.00, 0.79, 0.59],
  [1.50, 1.00, 0.69, 0.47], [2.20, 1.00, 0.60, 0.40],
];
function bvColor(bv, out) {
  let i = 0;
  while (i < COLOR_RAMP.length - 2 && bv > COLOR_RAMP[i + 1][0]) i++;
  const a = COLOR_RAMP[i], b = COLOR_RAMP[i + 1];
  const t = THREE.MathUtils.clamp((bv - a[0]) / (b[0] - a[0]), 0, 1);
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

/* ── 载入 ───────────────────────────────────────────── */
const base = new URL(".", import.meta.url);
const [starBuf, edgeBuf, weightBuf, meta] = await Promise.all([
  fetch(new URL("data/stars.bin", base)).then((r) => r.arrayBuffer()),
  fetch(new URL("data/edges.bin", base)).then((r) => r.arrayBuffer()),
  fetch(new URL("data/edge_weights.bin", base)).then((r) => r.arrayBuffer()),
  fetch(new URL("data/tracks.json", base)).then((r) => r.json()),
]);

const raw = new Float32Array(starBuf);
const N = meta.count;
const edgeIdx = new Uint16Array(edgeBuf);
const edgeW = new Float32Array(weightBuf);
const tracks = meta.tracks;

/* ── 恒星点云 ───────────────────────────────────────── */
const positions = new Float32Array(N * 3);
const colors = new Float32Array(N * 3);
const sizes = new Float32Array(N);
const rgb = [0, 0, 0];

for (let i = 0; i < N; i++) {
  const o = i * STAR_STRIDE;
  positions[i * 3] = raw[o] * SCENE_SCALE;
  positions[i * 3 + 1] = raw[o + 2] * SCENE_SCALE;   // 银道面法向 -> 场景 Y
  positions[i * 3 + 2] = -raw[o + 1] * SCENE_SCALE;
  bvColor(raw[o + 4], rgb);
  colors[i * 3] = rgb[0]; colors[i * 3 + 1] = rgb[1]; colors[i * 3 + 2] = rgb[2];
  // 视星等 -> 相对光通量，开方后作为半径，避免亮星过分压倒暗星
  sizes[i] = Math.sqrt(Math.pow(10, -0.4 * (raw[o + 3] - 6.4))) * 1.5 + 0.7;
}

const starGeom = new THREE.BufferGeometry();
starGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
starGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
starGeom.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
starGeom.setAttribute("flare", new THREE.BufferAttribute(new Float32Array(N), 1));

const starMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { uScale: { value: 1 }, uTime: { value: 0 } },
  vertexShader: `
    attribute float size;
    attribute float flare;
    varying vec3 vColor;
    varying float vFlare;
    uniform float uScale;
    void main() {
      vColor = color;
      vFlare = flare;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float d = max(-mv.z, 0.6);
      gl_PointSize = clamp(size * uScale / d * 26.0, 1.3, 34.0) * (1.0 + flare * 2.0);
    }`,
  fragmentShader: `
    varying vec3 vColor;
    varying float vFlare;
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float r = length(p) * 2.0;
      if (r > 1.0) discard;
      // 窄核 + 收敛的晕：晕过宽会让密集区糊成一片白
      float core = pow(1.0 - r, 2.8);
      float halo = pow(1.0 - r, 1.6) * 0.18;
      vec3 c = mix(vColor, vec3(1.0), core * 0.5 + vFlare * 0.4);
      gl_FragColor = vec4(c, (core + halo) * (0.88 + vFlare * 1.0));
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
  vertexShader: `
    attribute float alpha;
    varying vec3 vColor; varying float vAlpha;
    void main() {
      vColor = color; vAlpha = alpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec3 vColor; varying float vAlpha;
    void main() { gl_FragColor = vec4(vColor, vAlpha); }`,
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
scene.add(new THREE.Points(dustGeom, new THREE.PointsMaterial({
  size: 0.9, sizeAttenuation: false, color: 0x93b6d4,
  transparent: true, opacity: 0.16, depthWrite: false,
})));

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

const panelEmpty = document.getElementById("empty");
const panelDetail = document.getElementById("detail");
const elTitle = document.getElementById("title");
const elMeta = document.getElementById("meta");
const elStar = document.getElementById("star-line");
const elOpen = document.getElementById("open");

const fmt = new Intl.NumberFormat("zh-CN");

function select(i) {
  if (selected >= 0) {
    flare.array[selected] = 0;
    for (const e of neighbours[selected]) {
      edgeAlpha[e * 2] = edgeAlpha[e * 2 + 1] = EDGE_BASE;
    }
  }
  selected = i;
  if (i < 0) {
    panelEmpty.hidden = false; panelDetail.hidden = true;
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
  panelEmpty.hidden = true; panelDetail.hidden = false;
  elTitle.textContent = t.t;
  elMeta.innerHTML =
    `UP 主 <b>UID ${t.u}</b><br>` +
    `投稿 <b>${t.d}</b> · 播放 <b>${fmt.format(t.v)}</b><br>` +
    `相近曲目 <b>${neighbours[i].length}</b> 首`;
  elStar.textContent = `${t.s} · ${fmt.format(Math.round(t.l))} 光年 · 视星等 ${t.m}`;
  elOpen.href = `https://www.bilibili.com/video/${t.b}${t.p > 1 ? `?p=${t.p}` : ""}`;

  cam.goalTarget.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  cam.goalRadius = Math.max(cam.minRadius, Math.min(cam.goalRadius, 26));
}

function pick(x, y, focus) {
  const i = nearest(x, y, 16);
  if (i >= 0) select(i);
  else if (focus) { select(-1); cam.goalTarget.set(0, 0, 0); }
}

/* ── 主循环 ─────────────────────────────────────────── */
const stat = document.getElementById("stat");
stat.textContent = `${fmt.format(N)} 曲目 · ${fmt.format(E)} 连线 · 银道坐标 · 最远 ${fmt.format(Math.round(meta.dist_range[1]))} 光年`;

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  starMat.uniforms.uScale.value = h / 900;
}
addEventListener("resize", resize);
resize();

let prev = performance.now();
function frame(now) {
  const dt = Math.min((now - prev) / 1000, 0.1);
  prev = now;
  if (!dragging) cam.goalTheta += dt * 0.012;   // 缓慢自转
  applyCamera(dt);
  project();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

document.getElementById("loading").classList.add("done");
requestAnimationFrame(frame);
