/*
  Live wave tank.
  Scalar wave equation with a spatially varying refractive index n(x, y):
      u_tt = (c0 / n)^2 ∇²u
  Explicit leapfrog on a square grid:
      u[n+1] = (2u[n] − u[n−1] + C²(x,y) Δu[n]) · damp(x,y)
  C² = (c0·dt/dx)² / n² ≤ 0.25, under the 2D stability limit of 0.5.

  Edges: a sponge layer (damping that ramps up toward the walls) absorbs outgoing
  waves, so they leave the tank instead of bouncing around.

  Optical fiber (button): core n = 1.5, cladding n = 1.499, surrounded by air (n = 1).
  A laser at the left end drives a continuous wave into the core. With a core this
  narrow (about one wavelength) a 0.001 index step barely confines the light, so it
  spreads into the cladding and the cladding/air boundary does most of the guiding.
  This is the 2D scalar (slab-waveguide) picture: qualitatively right, not a full
  vector Maxwell solve.

  Inputs: drag/tap on the water, swipe/scroll/arrow keys (plane wave), hovering or
  clicking a box (wave from the tank's bottom edge), phone tilt (rolling ball).
*/
(() => {
  const canvas = document.getElementById("field");
  const tank = canvas.parentElement;
  const ctx = canvas.getContext("2d");
  const tiltBtn = document.getElementById("tilt");
  const fiberBtn = document.getElementById("fiber");
  const note = document.getElementById("tank-note");
  const NOTE_PLAIN = note.innerHTML;
  const NOTE_FIBER = "Core n = 1.5, cladding n = 1.499, air n = 1. Total internal reflection keeps the light in the glass.";

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CELL = 3;            // CSS px per grid cell
  const C2_0 = 0.25;         // Courant number squared at n = 1
  const N_CORE = 1.5;
  const N_CLAD = 1.499;
  const N_ENV = 1.0;         // the surrounding "air"
  const LOSS = 0.999;        // gentle loss in open water, the γ term (the core is lossless)
  const SPONGE = 12;         // absorbing layer thickness, cells
  const STEPS = 2;           // solver steps per frame
  const OMEGA = 0.26;        // laser angular frequency, rad/step → ~8 cell wavelength in the core

  const TANK = [0xF3, 0xF6, 0xF7], WAVE = [0x2B, 0x5D, 0x9B], LIGHT = [0xFF, 0xFF, 0xFF];

  let gw, gh, u, uPrev, c2, damp, core, img, off, offCtx, dpr, W, H, sx, sy;
  let running = false, woken = !reduceMotion, t = 0;

  // ---------- color ----------
  const LUT = new Uint32Array(512);
  (() => {
    const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
    const le = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
    for (let i = 0; i < 512; i++) {
      const v = i / 255.5 - 1;
      const [r, g, b] = v >= 0 ? mix(TANK, WAVE, Math.pow(v, 0.8)) : mix(TANK, LIGHT, Math.pow(-v, 0.8));
      LUT[i] = le ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255;
    }
  })();

  // ---------- fiber geometry ----------
  const fiber = { on: false, x0: 0, half: 4, clad: 13, A: 0, L: 1, mid: 0 };
  // Centre line of the core, in grid cells: a straight lead-in where the laser couples in,
  // then a smooth dip and rise (zero slope at both ends of each bend).
  const LEAD = 30;
  function fiberY(x) {
    const s = x - fiber.x0 - LEAD;
    if (s <= 0) return fiber.mid - fiber.A;
    return fiber.mid - fiber.A + fiber.A * (1 - Math.cos(2 * Math.PI * s / fiber.L));
  }
  function layoutFiber() {
    fiber.x0 = SPONGE + 6;
    fiber.mid = gh / 2;
    fiber.half = 4;                                                   // core half-width, cells
    fiber.clad = 13;                                                  // cladding half-width, cells
    fiber.A = Math.max(0, Math.min(gh * 0.2, (gh - 2 * SPONGE) / 2 - fiber.clad - 2));
    fiber.L = Math.max(120, (gw - fiber.x0 - LEAD) * 0.85);           // gentle enough to stay guided
  }

  // ---------- medium: speed and damping per cell ----------
  function buildMedium() {
    c2.fill(C2_0 / (N_ENV * N_ENV));
    core.fill(0);
    if (fiber.on) {
      const cCore = C2_0 / (N_CORE * N_CORE), cClad = C2_0 / (N_CLAD * N_CLAD);
      for (let x = fiber.x0; x < gw - 1; x++) {
        const yc = fiberY(x);
        for (let y = Math.max(1, Math.floor(yc - fiber.clad)); y <= Math.min(gh - 2, Math.ceil(yc + fiber.clad)); y++) {
          const d = Math.abs(y - yc);
          if (d <= fiber.half) { c2[y * gw + x] = cCore; core[y * gw + x] = 1; }       // glass: lossless
          else if (d <= fiber.clad) { c2[y * gw + x] = cClad; core[y * gw + x] = 1; }
        }
      }
    }
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const d = Math.min(x, y, gw - 1 - x, gh - 1 - y);          // distance to the wall
        const k = d < SPONGE ? (SPONGE - d) / SPONGE : 0;
        damp[y * gw + x] = (core[y * gw + x] ? 1 : LOSS) * (1 - 0.09 * k * k);
      }
    }
  }

  function resize() {
    const r = tank.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    gw = Math.max(8, Math.round(W / CELL)) + 2;
    gh = Math.max(8, Math.round(H / CELL)) + 2;
    sx = W / (gw - 2); sy = H / (gh - 2);     // CSS px per cell (≈ CELL)
    u = new Float32Array(gw * gh);
    uPrev = new Float32Array(gw * gh);
    c2 = new Float32Array(gw * gh);
    damp = new Float32Array(gw * gh);
    core = new Uint8Array(gw * gh);
    off = document.createElement("canvas");
    off.width = gw; off.height = gh;
    offCtx = off.getContext("2d");
    img = offCtx.createImageData(gw, gh);
    layoutFiber();
    buildMedium();
    ball.x = W / 2; ball.y = H / 2;
  }

  const toGX = px => px / sx + 1, toGY = py => py / sy + 1;
  const toPX = gx => (gx - 1) * sx, toPY = gy => (gy - 1) * sy;

  // Gaussian bump at grid coords
  function drop(gx, gy, a, s) {
    const R = Math.ceil(s * 2.5);
    const x0 = Math.round(gx), y0 = Math.round(gy);
    for (let y = Math.max(1, y0 - R); y <= Math.min(gh - 2, y0 + R); y++) {
      for (let x = Math.max(1, x0 - R); x <= Math.min(gw - 2, x0 + R); x++) {
        u[y * gw + x] += a * Math.exp(-((x - gx) ** 2 + (y - gy) ** 2) / (s * s));
      }
    }
  }

  // One-way horizontal wavefront between grid columns xa..xb at row y0.
  // dir = -1 travels up, +1 travels down. The copy half a cell behind in uPrev gives it its velocity.
  function lineWave(y0, dir, a, xa = 1, xb = gw - 2) {
    const s = 2.5, phase = Math.random() * 6.28, taper = Math.max(3, (xb - xa) * 0.12);
    for (let y = Math.max(1, Math.floor(y0 - 8)); y <= Math.min(gh - 2, Math.ceil(y0 + 8)); y++) {
      const now = Math.exp(-((y - y0) ** 2) / (s * s));
      const before = Math.exp(-((y - (y0 - dir * 0.5)) ** 2) / (s * s));
      for (let x = Math.max(1, Math.floor(xa)); x <= Math.min(gw - 2, Math.ceil(xb)); x++) {
        const edge = Math.min(1, (x - xa) / taper, (xb - x) / taper);
        if (edge <= 0) continue;
        const k = a * edge * (1 + 0.2 * Math.sin(x * 0.11 + phase));
        u[y * gw + x] += k * now;
        uPrev[y * gw + x] += k * before;
      }
    }
  }

  // The laser: a source spread over K cells along the core, with its phase advancing at the
  // guided wave's propagation constant β = n·ω/c0. Phase matching launches the light forward,
  // into the core, instead of spraying it in all directions like a point source would.
  const K = 16;
  // β for a mode with effective index between core and cladding, from the grid's own dispersion relation
  const N_EFF = (N_CORE + N_CLAD) / 2;
  const BETA = 2 * Math.asin(Math.sin(OMEGA / 2) * N_EFF / Math.sqrt(C2_0));   // rad per cell
  let tOn = 0;
  function laser() {
    const ramp = Math.min(1, (t - tOn) / 240);   // switch on smoothly: an abrupt start sprays light everywhere
    for (let k = 0; k < K; k++) {
      const x = fiber.x0 + 1 + k, yc = fiberY(x);
      const w = Math.sin(Math.PI * (k + 0.5) / K) ** 2;            // smooth on/off along the source
      const s = 0.022 * ramp * w * Math.sin(OMEGA * t - BETA * k);
      for (let y = Math.max(1, Math.floor(yc - fiber.half)); y <= Math.min(gh - 2, Math.ceil(yc + fiber.half)); y++) {
        u[y * gw + x] += s * Math.cos(Math.PI * (y - yc) / (2 * fiber.half + 2));   // ≈ fundamental mode shape
      }
    }
  }

  function step() {
    const next = uPrev;
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
        const lap = u[i - 1] + u[i + 1] + u[i - gw] + u[i + gw] - 4 * u[i];
        next[i] = (2 * u[i] - uPrev[i] + c2[i] * lap) * damp[i];
      }
    }
    uPrev = u; u = next;
  }

  function render() {
    const px = new Uint32Array(img.data.buffer);
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
        const slope = (u[i + 1] - u[i - 1]) + (u[i + gw] - u[i - gw]);
        let v = u[i] * 0.9 - slope * 1.4;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        px[i] = LUT[((v + 1) * 255.5) | 0];
      }
    }
    offCtx.putImageData(img, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(off, 1, 1, gw - 2, gh - 2, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (fiber.on) drawFiber();
    if (tilt.on) {
      ctx.fillStyle = "#E8A317"; ctx.strokeStyle = "#0E2A47"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ball.x, ball.y, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }

  function drawFiber() {
    // cladding (glass) tint, then the core/cladding and cladding/air boundaries
    ctx.beginPath();
    for (let x = fiber.x0; x <= gw - 1; x++) { const X = toPX(x), Y = toPY(fiberY(x) - fiber.clad); x === fiber.x0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); }
    for (let x = gw - 1; x >= fiber.x0; x--) ctx.lineTo(toPX(x), toPY(fiberY(x) + fiber.clad));
    ctx.closePath();
    ctx.fillStyle = "rgba(232, 163, 23, 0.06)";
    ctx.fill();
    const edge = (off, style, width) => {
      ctx.lineWidth = width; ctx.strokeStyle = style;
      ctx.beginPath();
      for (let x = fiber.x0; x <= gw - 1; x++) {
        const X = toPX(x), Y = toPY(fiberY(x) + off);
        x === fiber.x0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
      }
      ctx.stroke();
    };
    edge(-fiber.clad, "rgba(14, 42, 71, 0.45)", 1.25);
    edge(fiber.clad, "rgba(14, 42, 71, 0.45)", 1.25);
    edge(-fiber.half, "rgba(138, 95, 0, 0.55)", 1);
    edge(fiber.half, "rgba(138, 95, 0, 0.55)", 1);
    // the laser at the input face
    const X = toPX(fiber.x0 + 1), Y = toPY(fiberY(fiber.x0 + 1));
    const h = fiber.half * 2 * sy + 8;
    ctx.fillStyle = "#0E2A47";
    ctx.fillRect(X - 26, Y - h / 2, 22, h);
    ctx.fillStyle = "#E8A317";
    ctx.fillRect(X - 5, Y - fiber.half * sy, 4, fiber.half * 2 * sy);
  }

  // ---------- tilt ball ----------
  const ball = { x: 0, y: 0, vx: 0, vy: 0 };
  const tilt = { on: false, ax: 0, ay: 0, got: false, beta0: null };
  function moveBall() {
    const R = 8;
    ball.vx = (ball.vx + tilt.ax * 0.7) * 0.95;
    ball.vy = (ball.vy + tilt.ay * 0.7) * 0.95;
    ball.x += ball.vx; ball.y += ball.vy;
    if (ball.x < R) { ball.x = R; ball.vx *= -0.5; }
    if (ball.x > W - R) { ball.x = W - R; ball.vx *= -0.5; }
    if (ball.y < R) { ball.y = R; ball.vy *= -0.5; }
    if (ball.y > H - R) { ball.y = H - R; ball.vy *= -0.5; }
    const speed = Math.hypot(ball.vx, ball.vy);
    drop(toGX(ball.x), toGY(ball.y), 0.05 + Math.min(0.45, speed * 0.05), 2.2);
  }

  // ---------- loop ----------
  function frame() {
    if (!running) return;
    if (tilt.on) moveBall();
    for (let s = 0; s < STEPS; s++) { if (fiber.on) laser(); step(); t++; }
    render();
    requestAnimationFrame(frame);
  }
  function start() {
    if (running || !woken || document.hidden) return;
    running = true;
    requestAnimationFrame(frame);
  }
  function wake() { woken = true; start(); }

  // ---------- pointer on the water ----------
  let down = false;
  const local = e => { const r = canvas.getBoundingClientRect(); return [toGX(e.clientX - r.left), toGY(e.clientY - r.top)]; };
  canvas.addEventListener("pointerdown", e => {
    down = true;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = local(e);
    drop(x, y, 1.5, 3);
    wake();
  });
  canvas.addEventListener("pointermove", e => {
    const [x, y] = local(e);
    if (down) drop(x, y, 0.3, 2.2);
    else if (e.pointerType === "mouse" && !reduceMotion) drop(x, y, 0.035, 2);
  });
  const up = () => { down = false; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // ---------- swipe / scroll: a wave sweeps the tank ----------
  const dialogOpen = () => !!document.querySelector("dialog[open]");
  let lastWave = 0;
  function sweep(dir, strength) {
    if (dialogOpen()) return;
    const now = performance.now();
    if (now - lastWave < 160) return;
    lastWave = now;
    // start just inside the sponge so the front isn't eaten immediately
    lineWave(dir < 0 ? gh - SPONGE - 3 : SPONGE + 2, dir, Math.min(1.4, 0.5 + strength));
    wake();
  }
  window.addEventListener("wheel", e => {
    if (Math.abs(e.deltaY) < 4) return;
    sweep(e.deltaY > 0 ? -1 : 1, Math.abs(e.deltaY) / 120);
  }, { passive: true });
  let ts = null;
  window.addEventListener("touchstart", e => {
    const p = e.touches[0]; ts = { x: p.clientX, y: p.clientY, time: performance.now() };
  }, { passive: true });
  window.addEventListener("touchend", e => {
    if (!ts) return;
    const p = e.changedTouches[0];
    const dy = p.clientY - ts.y, dx = p.clientX - ts.x, dt = performance.now() - ts.time;
    ts = null;
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.3 && dt < 700) sweep(dy < 0 ? -1 : 1, Math.abs(dy) / dt);
  }, { passive: true });
  window.addEventListener("keydown", e => {
    if (e.target !== document.body) return;
    if (["ArrowDown", "PageDown", " "].includes(e.key)) sweep(-1, 0.6);
    if (["ArrowUp", "PageUp"].includes(e.key)) sweep(1, 0.6);
  });

  // ---------- boxes send a wave in from the tank's bottom edge, above themselves ----------
  function fromBox(el, a) {
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const xa = toGX(Math.max(0, r.left - c.left)), xb = toGX(Math.min(W, r.right - c.left));
    if (xb - xa < 4) return;
    lineWave(gh - SPONGE - 3, -1, a, xa, xb);
    wake();
  }
  document.querySelectorAll(".tile").forEach(el => {
    el.addEventListener("pointerenter", e => { if (e.pointerType === "mouse") fromBox(el, 0.7); });
    el.addEventListener("click", () => fromBox(el, 1.2));
  });

  // ---------- optical fiber ----------
  fiberBtn.addEventListener("click", () => {
    fiber.on = !fiber.on;
    fiberBtn.setAttribute("aria-pressed", String(fiber.on));
    fiberBtn.textContent = fiber.on ? "Remove the fiber" : "Add an optical fiber";
    note.innerHTML = fiber.on ? NOTE_FIBER : NOTE_PLAIN;
    u.fill(0); uPrev.fill(0);   // start from still water so the guided light is easy to see
    tOn = t;
    buildMedium();
    wake();
  });

  // ---------- phone tilt ----------
  function screenAngle() { return (screen.orientation && screen.orientation.angle) || window.orientation || 0; }
  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    tilt.got = true;
    if (tilt.beta0 === null) tilt.beta0 = e.beta;
    const rad = Math.PI / 180;
    const gx = Math.sin(e.gamma * rad), gy = Math.sin((e.beta - tilt.beta0) * rad);
    const a = screenAngle() * rad;
    tilt.ax = gx * Math.cos(a) + gy * Math.sin(a);
    tilt.ay = -gx * Math.sin(a) + gy * Math.cos(a);
  }
  function setTilt(on) {
    tilt.on = on;
    tiltBtn.setAttribute("aria-pressed", String(on));
    tiltBtn.textContent = on ? "Stop steering" : "Steer with your phone";
    if (on) {
      tilt.beta0 = null; tilt.got = false;
      ball.x = W / 2; ball.y = H / 2; ball.vx = ball.vy = 0;
      window.addEventListener("deviceorientation", onOrient);
      wake();
    } else window.removeEventListener("deviceorientation", onOrient);
  }
  function startTilt() {
    setTilt(true);
    setTimeout(() => {
      if (tilt.on && !tilt.got) { setTilt(false); tiltBtn.textContent = "No tilt sensor found"; tiltBtn.disabled = true; }
    }, 2000);
  }
  if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) {
    tiltBtn.hidden = false;
    tiltBtn.addEventListener("click", () => {
      if (tilt.on) return setTilt(false);
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        // iOS: must run straight from the tap
        DeviceOrientationEvent.requestPermission()
          .then(state => state === "granted" ? startTilt() : (tiltBtn.textContent = "Motion access denied"))
          .catch(() => { tiltBtn.textContent = "Open in Safari to use tilt"; });
      } else startTilt();
    });
  }

  // ---------- ambient drops ----------
  setInterval(() => {
    if (!running || reduceMotion || dialogOpen() || fiber.on) return;
    drop(SPONGE + Math.random() * (gw - 2 * SPONGE), SPONGE + Math.random() * (gh - 2 * SPONGE), 0.8, 2.6);
  }, 3500);

  // ---------- lifecycle ----------
  resize();
  for (let k = 0; k < 3; k++) drop(SPONGE + Math.random() * (gw - 2 * SPONGE), SPONGE + Math.random() * (gh - 2 * SPONGE), 1.1, 3);
  for (let k = 0; k < 30; k++) step();
  render();
  start();

  document.addEventListener("visibilitychange", () => { if (document.hidden) running = false; else start(); });
  let rt, lastW = W, lastH = H;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const r = tank.getBoundingClientRect();
      if (Math.abs(r.width - lastW) < 2 && Math.abs(r.height - lastH) < 2) return;
      lastW = r.width; lastH = r.height;
      resize(); render();
    }, 120);
  }).observe(tank);
})();
