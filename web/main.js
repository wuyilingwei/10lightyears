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
function spectralColor(axis, out) {
  let i = 0;
  while (i < SPECTRAL_RAMP.length - 2 && axis > SPECTRAL_RAMP[i + 1][0]) i++;
  const a = SPECTRAL_RAMP[i], b = SPECTRAL_RAMP[i + 1];
  const t = THREE.MathUtils.clamp((axis - a[0]) / (b[0] - a[0]), 0, 1);
  out[0] = a[1] + (b[1] - a[1]) * t;
  out[1] = a[2] + (b[2] - a[2]) * t;
  out[2] = a[3] + (b[3] - a[3]) * t;
}

// 光度级 I..III 是巨星/超巨星，半径大得多，给更宽更软的光晕；IV/V 是矮星
const SPECTRAL_LETTER = "OBAFGKM";
function giantness(lumCode) {
  return lumCode >= 1 && lumCode <= 3 ? (4 - lumCode) / 3 : 0;
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
  uniforms: { uScale: { value: 1 }, uTime: { value: 0 } },
  vertexShader: `
    attribute float size;
    attribute float flare;
    attribute float giant;
    varying vec3 vColor;
    varying float vFlare;
    varying float vGiant;
    uniform float uScale;
    void main() {
      vColor = color;
      vFlare = flare;
      vGiant = giant;
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
    void main() {
      vec2 p = gl_PointCoord - 0.5;
      float r = length(p) * 2.0;
      if (r > 1.0) discard;
      // 窄核 + 收敛的晕：晕过宽会让密集区糊成一片白。
      // 巨星/超巨星半径大得多，给更宽更软的晕以示区别。
      float core = pow(1.0 - r, mix(2.8, 2.1, vGiant));
      float halo = pow(1.0 - r, mix(1.6, 1.0, vGiant)) * (0.18 + vGiant * 0.20);
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
const elAuthor = document.getElementById("author");
const elMeta = document.getElementById("meta");
const elStar = document.getElementById("star-line");
const elOpen = document.getElementById("open");
const elCover = document.getElementById("cover");
const elCoverImg = document.querySelector("#cover img");
const elPlay = document.getElementById("play");

const fmt = new Intl.NumberFormat("zh-CN");
const CDN = meta.cdn || "https://i0.hdslb.com/";
// 缩略图变体只有原图的 1/20 大小，够面板用
const COVER_VARIANT = "@480w_300h_1c.webp";

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

  elCoverImg.classList.remove("on");
  if (t.c) {
    elCoverImg.onload = () => elCoverImg.classList.add("on");
    elCoverImg.src = CDN + t.c + COVER_VARIANT;
  } else {
    elCoverImg.removeAttribute("src");
  }

  elAuthor.innerHTML = t.a
    ? `<em>UP 主</em>${escapeHtml(t.a)}`
    : `<em>UP 主</em>UID ${t.u}`;
  elMeta.innerHTML =
    `投稿 <b>${t.d}</b> · 播放 <b>${fmt.format(t.v)}</b><br>` +
    `相近曲目 <b>${neighbours[i].length}</b> 首`;
  const sp = t.y ? ` · ${t.y}` : "";
  elStar.textContent =
    `${t.s}${sp} · ${fmt.format(Math.round(t.l))} 光年 · 视星等 ${t.m}`;
  elOpen.href = `https://www.bilibili.com/video/${t.b}${t.p > 1 ? `?p=${t.p}` : ""}`;

  cam.goalTarget.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  cam.goalRadius = Math.max(cam.minRadius, Math.min(cam.goalRadius, 26));
}

function pick(x, y, focus) {
  const i = nearest(x, y, 16);
  if (i >= 0) select(i);
  else if (focus) { select(-1); cam.goalTarget.set(0, 0, 0); }
}

/* ── 内嵌播放器 ─────────────────────────────────────── */
function stopPlayer() {
  elCover.classList.remove("playing");
  elCover.querySelector("iframe")?.remove();
}

function startPlayer(i) {
  const t = tracks[i];
  if (!t) return;
  stopPlayer();
  const frame = document.createElement("iframe");
  const q = new URLSearchParams({
    isOutside: "true", bvid: t.b, cid: String(t.i), p: String(t.p),
    autoplay: "1", danmaku: "0", high_quality: "1",
  });
  frame.src = `https://player.bilibili.com/player.html?${q}`;
  frame.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture";
  frame.allowFullscreen = true;
  frame.scrolling = "no";
  frame.referrerPolicy = "no-referrer";
  elCover.appendChild(frame);
  elCover.classList.add("playing");
}

elPlay.addEventListener("click", () => { if (selected >= 0) startPlayer(selected); });

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
canvas.addEventListener("pointerdown", () => elResults.classList.remove("on"));

/* ── 主循环 ─────────────────────────────────────────── */
const stat = document.getElementById("stat");
stat.textContent = `${fmt.format(N)} 曲目 · ${fmt.format(E)} 连线 · 银道坐标 · `
  + `按光谱型着色 · 最远 ${fmt.format(Math.round(meta.dist_range[1]))} 光年`;

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
