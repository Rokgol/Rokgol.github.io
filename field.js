/*
  Live 2D wave field.
  Solves  u_tt = c^2 ∇²u − γ u_t  on a grid with an explicit leapfrog scheme:
    u[n+1] = (2u[n] − u[n−1] + C² Δu[n]) · damp
  with C² = (c·dt/dx)² = 0.25, under the 2D stability limit of 0.5.

  Sources:
    - earthquakes from the last 24 h (USGS GeoJSON feed), replayed in time order,
      placed by longitude/latitude, strength from magnitude
    - pointer: click or drag
    - phone tilt: an oscillating source you steer (after permission is granted)
*/
(() => {
  const canvas = document.getElementById("field");
  const panel = canvas.parentElement;
  const ctx = canvas.getContext("2d");
  const quakeEl = document.getElementById("quake");
  const noteEl = document.getElementById("field-note");
  const tiltBtn = document.getElementById("tilt");

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CELL = 4;          // CSS px per grid cell
  const C2 = 0.25;         // Courant number squared
  const DAMP = 0.991;      // per-step loss, the γ term
  const STEPS = 2;         // solver steps per frame

  // Palette, matched to style.css
  const PAPER = [0xE9, 0xEE, 0xF0], WAVE = [0x2B, 0x5D, 0x9B], LIGHT = [0xFF, 0xFF, 0xFF];

  let gw, gh, u, uPrev, img, off, offCtx, dpr, cssW, cssH;
  let running = false, visible = true, t = 0;
  let woken = !reduceMotion; // with reduced motion, wait for the visitor to act
  const markers = [];      // quake rings drawn on top, in CSS px

  // Lookup table: field value in [-1, 1] -> RGBA
  const LUT = new Uint32Array(512);
  (() => {
    const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    for (let i = 0; i < 512; i++) {
      const v = i / 255.5 - 1;
      const [r, g, b] = v >= 0 ? mix(PAPER, WAVE, Math.pow(v, 0.8)) : mix(PAPER, LIGHT, Math.pow(-v, 0.8));
      LUT[i] = le ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255;
    }
  })();

  function resize() {
    const r = panel.getBoundingClientRect();
    cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    gw = Math.ceil(cssW / CELL) + 2;
    gh = Math.ceil(cssH / CELL) + 2;
    u = new Float32Array(gw * gh);
    uPrev = new Float32Array(gw * gh);
    off = document.createElement("canvas");
    off.width = gw; off.height = gh;
    offCtx = off.getContext("2d");
    img = offCtx.createImageData(gw, gh);
  }

  // Gaussian bump: amplitude a, width s (in cells)
  function drop(gx, gy, a, s) {
    const R = Math.ceil(s * 2.5);
    const x0 = Math.round(gx), y0 = Math.round(gy);
    for (let y = Math.max(1, y0 - R); y <= Math.min(gh - 2, y0 + R); y++) {
      for (let x = Math.max(1, x0 - R); x <= Math.min(gw - 2, x0 + R); x++) {
        const d2 = (x - gx) ** 2 + (y - gy) ** 2;
        u[y * gw + x] += a * Math.exp(-d2 / (s * s));
      }
    }
  }

  function step() {
    const next = uPrev; // reuse the old buffer
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
        const lap = u[i - 1] + u[i + 1] + u[i - gw] + u[i + gw] - 4 * u[i];
        next[i] = (2 * u[i] - uPrev[i] + C2 * lap) * DAMP;
      }
    }
    uPrev = u; u = next;  // edges stay 0: a fixed (reflecting) boundary
  }

  function render() {
    const px = new Uint32Array(img.data.buffer);
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
        // height plus a little slope shading, lit from the top left
        const slope = (u[i + 1] - u[i - 1]) + (u[i + gw] - u[i - gw]);
        let v = u[i] * 0.9 - slope * 1.6;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        px[i] = LUT[((v + 1) * 255.5) | 0];
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 1, 1, gw - 2, gh - 2, 0, 0, canvas.width, canvas.height);

    // quake rings
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const now = performance.now();
    for (let k = markers.length - 1; k >= 0; k--) {
      const m = markers[k], age = (now - m.t0) / 2600;
      if (age >= 1) { markers.splice(k, 1); continue; }
      ctx.globalAlpha = 1 - age;
      ctx.strokeStyle = "#E8A317";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(m.x, m.y, 4 + age * m.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#E8A317";
      ctx.beginPath();
      ctx.arc(m.x, m.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    if (!running) return;
    t++;
    if (tilt.on) {
      const gx = 1 + tilt.x * (gw - 3), gy = 1 + tilt.y * (gh - 3);
      drop(gx, gy, 0.12 * Math.sin(t * 0.32), 2);
    }
    for (let s = 0; s < STEPS; s++) step();
    render();
    requestAnimationFrame(frame);
  }

  function start() {
    if (running || !visible || !woken) return;
    running = true;
    requestAnimationFrame(frame);
  }
  function stop() { running = false; }

  // ---------- pointer ----------
  function toGrid(e) {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / CELL + 1, (e.clientY - r.top) / CELL + 1];
  }
  let down = false;
  canvas.addEventListener("pointerdown", e => {
    down = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toGrid(e);
    drop(x, y, 1.6, 3);
    woken = true;
    start();
  });
  canvas.addEventListener("pointermove", e => {
    const [x, y] = toGrid(e);
    if (down) drop(x, y, 0.35, 2.2);
    else if (e.pointerType === "mouse" && !reduceMotion) drop(x, y, 0.04, 2);
  });
  const up = () => { down = false; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // ---------- earthquakes ----------
  const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson";
  const INSET = 0.07; // keep quakes off the very edge

  function place(lon, lat) {
    const fx = INSET + (1 - 2 * INSET) * (lon + 180) / 360;
    const fy = INSET + (1 - 2 * INSET) * (90 - lat) / 180;
    return [fx * cssW, fy * cssH];
  }

  function ago(ms) {
    const h = Math.round((Date.now() - ms) / 3.6e6);
    if (h < 1) return "under an hour ago";
    return h === 1 ? "1 hour ago" : `${h} hours ago`;
  }

  let quakes = [], qi = 0, labelTimer;
  function fireQuake() {
    const q = quakes[qi++ % quakes.length];
    const [x, y] = place(q.lon, q.lat);
    const m = Math.max(2.5, q.mag);
    drop(x / CELL + 1, y / CELL + 1, 0.9 + 0.55 * (m - 2.5), 2.2 + 0.7 * (m - 2.5));
    markers.push({ x, y, r: 30 + 14 * (m - 2.5), t0: performance.now() });
    quakeEl.innerHTML = "";
    const b = document.createElement("b");
    b.textContent = `M ${m.toFixed(1)}`;
    quakeEl.append(b, ` ${q.place || "Unnamed location"}, ${ago(q.time)}`);
    quakeEl.classList.add("on");
    clearTimeout(labelTimer);
    labelTimer = setTimeout(() => quakeEl.classList.remove("on"), 2200);
  }

  function randomDrop() {
    drop(2 + Math.random() * (gw - 4), 2 + Math.random() * (gh - 4), 1.2, 3);
  }

  let autoTimer;
  function startAuto(fn) {
    clearInterval(autoTimer);
    fn();
    autoTimer = setInterval(() => { if (running) fn(); }, 2600);
  }

  async function loadQuakes() {
    try {
      const res = await fetch(FEED, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      quakes = data.features
        .filter(f => f.geometry && f.properties.mag != null)
        .map(f => ({
          lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
          mag: f.properties.mag, place: f.properties.place, time: f.properties.time,
        }))
        .sort((a, b) => a.time - b.time);
      if (!quakes.length) throw new Error("empty feed");
      if (!reduceMotion) startAuto(fireQuake);
    } catch {
      noteEl.textContent = "The 2D wave equation, solved on a grid in your browser. The earthquake feed (USGS) isn't reachable right now, so these ripples land at random. Click or drag to make your own.";
      if (!reduceMotion) startAuto(randomDrop);
    }
  }

  // ---------- phone tilt (needs permission on iOS, user tap required) ----------
  const tilt = { on: false, x: 0.5, y: 0.5, got: false };
  function onOrient(e) {
    if (e.gamma == null || e.beta == null) return;
    tilt.got = true;
    tilt.x = Math.min(1, Math.max(0, 0.5 + e.gamma / 70));
    tilt.y = Math.min(1, Math.max(0, 0.5 + (e.beta - 40) / 70));
  }
  function setTilt(on) {
    tilt.on = on;
    tiltBtn.setAttribute("aria-pressed", String(on));
    tiltBtn.textContent = on ? "Stop steering" : "Steer with your phone";
    if (on) { window.addEventListener("deviceorientation", onOrient); woken = true; start(); }
    else window.removeEventListener("deviceorientation", onOrient);
  }

  if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) {
    tiltBtn.hidden = false;
    tiltBtn.addEventListener("click", async () => {
      if (tilt.on) return setTilt(false);
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        let state = "denied";
        try { state = await DeviceOrientationEvent.requestPermission(); } catch {}
        if (state !== "granted") {
          tiltBtn.textContent = "Motion access was denied. Allow it in Safari settings to try again.";
          return;
        }
      }
      setTilt(true);
      setTimeout(() => {
        if (tilt.on && !tilt.got) {
          setTilt(false);
          tiltBtn.textContent = "No motion sensor found on this device";
          tiltBtn.disabled = true;
        }
      }, 1500);
    });
  }

  // ---------- lifecycle ----------
  resize();
  // Seed a few ripples so the first frame isn't blank
  for (let k = 0; k < 4; k++) randomDrop();
  for (let k = 0; k < 40; k++) step();
  render();

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    visible ? start() : stop();
  }).observe(panel);

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const r = panel.getBoundingClientRect();
      if (Math.abs(r.width - cssW) < 2 && Math.abs(r.height - cssH) < 60) return; // ignore mobile URL-bar jitter
      resize(); render();
    }, 150);
  });

  start();       // no-op under reduced motion until the visitor touches the field
  loadQuakes();
})();
