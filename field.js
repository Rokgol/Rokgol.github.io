/*
  Live 2D wave field, full screen.
  Solves  u_tt = c^2 ∇²u − γ u_t  with an explicit leapfrog scheme:
    u[n+1] = (2u[n] − u[n−1] + C² Δu[n]) · damp
  C² = (c·dt/dx)² = 0.25, under the 2D stability limit of 0.5.

  Inputs:
    - drag / tap on the water: local disturbance
    - swipe up/down, mouse wheel, arrow / page keys: a plane wave sweeps the screen
    - phone tilt (after permission): a ball rolls on the water and leaves a wake
    - an occasional ambient drop so the surface is never dead still
*/
(() => {
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d");
  const tiltBtn = document.getElementById("tilt");

  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CELL = 4;          // CSS px per grid cell
  const C2 = 0.25;         // Courant number squared → wave speed 0.5 cell/step
  const DAMP = 0.992;      // per-step loss, the γ term
  const STEPS = 2;         // solver steps per frame

  const PAPER = [0xE9, 0xEE, 0xF0], WAVE = [0x2B, 0x5D, 0x9B], LIGHT = [0xFF, 0xFF, 0xFF];

  let gw, gh, u, uPrev, img, off, offCtx, dpr, W, H;
  let running = false, woken = !reduceMotion;

  // Field value in [-1, 1] → RGBA
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
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    gw = Math.ceil(W / CELL) + 2;
    gh = Math.ceil(H / CELL) + 2;
    u = new Float32Array(gw * gh);
    uPrev = new Float32Array(gw * gh);
    off = document.createElement("canvas");
    off.width = gw; off.height = gh;
    offCtx = off.getContext("2d");
    img = offCtx.createImageData(gw, gh);
    ball.x = W / 2; ball.y = H / 2;
  }

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
  const dropPx = (x, y, a, s) => drop(x / CELL + 1, y / CELL + 1, a, s);

  // Plane wave launched from an edge, moving in one direction.
  // dir = -1: starts at the bottom and travels up. dir = +1: starts at the top and travels down.
  // Putting the same ridge in uPrev half a cell behind gives it a velocity (one-way wave).
  function planeWave(dir, a) {
    const y0 = dir < 0 ? gh - 10 : 9;
    const s = 3;
    const phase = Math.random() * 6.28;
    for (let y = Math.max(1, y0 - 8); y <= Math.min(gh - 2, y0 + 8); y++) {
      const now = Math.exp(-((y - y0) ** 2) / (s * s));
      const before = Math.exp(-((y - (y0 - dir * 0.5)) ** 2) / (s * s));
      for (let x = 1; x < gw - 1; x++) {
        const k = a * (1 + 0.25 * Math.sin(x * 0.09 + phase)); // a little unevenness looks more like water
        u[y * gw + x] += k * now;
        uPrev[y * gw + x] += k * before;
      }
    }
  }

  function step() {
    const next = uPrev;
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
        const lap = u[i - 1] + u[i + 1] + u[i - gw] + u[i + gw] - 4 * u[i];
        next[i] = (2 * u[i] - uPrev[i] + C2 * lap) * DAMP;
      }
    }
    uPrev = u; u = next;   // edges stay 0: reflecting boundary
  }

  function render() {
    const px = new Uint32Array(img.data.buffer);
    for (let y = 1; y < gh - 1; y++) {
      let i = y * gw + 1;
      for (let x = 1; x < gw - 1; x++, i++) {
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

    if (tilt.on) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#E8A317";
      ctx.strokeStyle = "#0E2A47";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // ---------- tilt ball ----------
  const ball = { x: 0, y: 0, vx: 0, vy: 0 };
  const tilt = { on: false, ax: 0, ay: 0, got: false, beta0: null };

  function moveBall() {
    const R = 9;
    ball.vx = (ball.vx + tilt.ax * 0.9) * 0.96;
    ball.vy = (ball.vy + tilt.ay * 0.9) * 0.96;
    ball.x += ball.vx; ball.y += ball.vy;
    if (ball.x < R) { ball.x = R; ball.vx *= -0.5; }
    if (ball.x > W - R) { ball.x = W - R; ball.vx *= -0.5; }
    if (ball.y < R) { ball.y = R; ball.vy *= -0.5; }
    if (ball.y > H - R) { ball.y = H - R; ball.vy *= -0.5; }
    const speed = Math.hypot(ball.vx, ball.vy);
    dropPx(ball.x, ball.y, 0.06 + Math.min(0.5, speed * 0.04), 2.2);  // the wake
  }

  function frame() {
    if (!running) return;
    if (tilt.on) moveBall();
    for (let s = 0; s < STEPS; s++) step();
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
  canvas.addEventListener("pointerdown", e => {
    down = true;
    canvas.setPointerCapture(e.pointerId);
    dropPx(e.clientX, e.clientY, 1.6, 3);
    wake();
  });
  canvas.addEventListener("pointermove", e => {
    if (down) dropPx(e.clientX, e.clientY, 0.35, 2.2);
    else if (e.pointerType === "mouse" && !reduceMotion) dropPx(e.clientX, e.clientY, 0.04, 2);
  });
  const up = () => { down = false; };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  // ---------- "scrolling" makes plane waves ----------
  const dialogOpen = () => !!document.querySelector("dialog[open]");
  let lastWave = 0;
  function scrollWave(dir, strength) {
    if (dialogOpen()) return;
    const now = performance.now();
    if (now - lastWave < 140) return;   // don't stack dozens from one wheel flick
    lastWave = now;
    planeWave(dir, Math.min(1.6, 0.5 + strength));
    wake();
  }
  // Wheel / trackpad: scrolling down pushes a wave up the screen, like content moving up
  window.addEventListener("wheel", e => {
    if (Math.abs(e.deltaY) < 4) return;
    scrollWave(e.deltaY > 0 ? -1 : 1, Math.abs(e.deltaY) / 120);
  }, { passive: true });
  // Touch swipes anywhere on the page
  let ts = null;
  window.addEventListener("touchstart", e => {
    const t = e.touches[0];
    ts = { x: t.clientX, y: t.clientY, time: performance.now() };
  }, { passive: true });
  window.addEventListener("touchend", e => {
    if (!ts) return;
    const t = e.changedTouches[0];
    const dy = t.clientY - ts.y, dx = t.clientX - ts.x, dt = performance.now() - ts.time;
    ts = null;
    if (Math.abs(dy) > 50 && Math.abs(dy) > Math.abs(dx) * 1.3 && dt < 700) {
      scrollWave(dy < 0 ? -1 : 1, Math.abs(dy) / dt);  // swipe up → wave travels up
    }
  }, { passive: true });
  window.addEventListener("keydown", e => {
    if (["ArrowDown", "PageDown", " "].includes(e.key) && e.target === document.body) scrollWave(-1, 0.6);
    if (["ArrowUp", "PageUp"].includes(e.key) && e.target === document.body) scrollWave(1, 0.6);
  });

  // ---------- phone tilt ----------
  // deviceorientation gives beta (front/back, degrees) and gamma (left/right, degrees).
  // The first reading is taken as "level", so it works however the phone is held.
  function screenAngle() {
    return (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  }
  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    tilt.got = true;
    if (tilt.beta0 === null) tilt.beta0 = e.beta;
    const rad = Math.PI / 180;
    let gx = Math.sin(e.gamma * rad);                       // + = right edge down
    let gy = Math.sin((e.beta - tilt.beta0) * rad);         // + = top edge raised → roll toward bottom
    // rotate into screen coordinates when the phone is in landscape
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
    } else {
      window.removeEventListener("deviceorientation", onOrient);
    }
  }

  if ("DeviceOrientationEvent" in window && matchMedia("(pointer: coarse)").matches) {
    tiltBtn.hidden = false;
    tiltBtn.addEventListener("click", () => {
      if (tilt.on) return setTilt(false);
      if (typeof DeviceOrientationEvent.requestPermission === "function") {
        // iOS: must be called straight from the tap, before any other await
        DeviceOrientationEvent.requestPermission()
          .then(state => {
            if (state === "granted") return startTilt();
            tiltBtn.textContent = "Motion access denied";
          })
          .catch(() => { tiltBtn.textContent = "Open in Safari to use tilt"; });
      } else {
        startTilt();
      }
    });
  }
  function startTilt() {
    setTilt(true);
    setTimeout(() => {
      if (tilt.on && !tilt.got) {
        setTilt(false);
        tiltBtn.textContent = "No tilt sensor found";
        tiltBtn.disabled = true;
      }
    }, 2000);
  }

  // ---------- boxes on the page make ripples ----------
  // A ridge around a rectangle's outline: an expanding rectangular wavefront from its edges.
  function rectRipple(r, a) {
    const s = 1.6, band = 5;
    const x0 = r.left / CELL + 1, x1 = r.right / CELL + 1, y0 = r.top / CELL + 1, y1 = r.bottom / CELL + 1;
    for (let y = Math.max(1, Math.floor(y0 - band)); y <= Math.min(gh - 2, Math.ceil(y1 + band)); y++) {
      for (let x = Math.max(1, Math.floor(x0 - band)); x <= Math.min(gw - 2, Math.ceil(x1 + band)); x++) {
        const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
        const d = Math.hypot(dx, dy);
        if (d === 0) continue;            // inside the box: leave it
        u[y * gw + x] += a * Math.exp(-((d - 1.5) ** 2) / (s * s));
      }
    }
  }
  document.querySelectorAll(".tile").forEach(el => {
    el.addEventListener("pointerenter", e => {
      if (e.pointerType !== "mouse") return;
      rectRipple(el.getBoundingClientRect(), 0.75); wake();
    });
    el.addEventListener("click", () => { rectRipple(el.getBoundingClientRect(), 1.4); wake(); });
  });

  // ---------- ambient drops ----------
  setInterval(() => {
    if (!running || reduceMotion || dialogOpen()) return;
    drop(4 + Math.random() * (gw - 8), 4 + Math.random() * (gh - 8), 0.9, 2.6);
  }, 3200);

  // ---------- lifecycle ----------
  resize();
  for (let k = 0; k < 3; k++) drop(4 + Math.random() * (gw - 8), 4 + Math.random() * (gh - 8), 1.2, 3);
  for (let k = 0; k < 40; k++) step();
  render();
  start();   // under reduced motion this waits until the visitor touches the water

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) running = false; else start();
  });
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (Math.abs(window.innerWidth - W) < 2 && Math.abs(window.innerHeight - H) < 80) return; // mobile URL-bar jitter
      resize(); render();
    }, 150);
  });
})();
