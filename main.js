// UI, rendering and config handling. The algorithm lives in wfc.js, the type editor in editor.js.
(function () {
  'use strict';

  const { compileRules, Solver, seedFromString, makeRng } = window.TerrainWFC;

  const $ = (id) => document.getElementById(id);
  const ui = {
    canvas: $('map'),
    hover: $('hover'),
    generate: $('generate'),
    pause: $('pause'),
    step: $('step'),
    stats: $('stats'),
    width: $('width'),
    height: $('height'),
    cellSize: $('cellSize'),
    selection: $('selection'),
    neighborhood: $('neighborhood'),
    seed: $('seed'),
    speed: $('speed'),
    speedOut: $('speedOut'),
    instant: $('instant'),
    voronoi: $('voronoi'),
    jitter: $('jitter'),
    jitterOut: $('jitterOut'),
    types: $('types'),
    addType: $('addType'),
    exportJson: $('exportJson'),
    importJson: $('importJson'),
    resetTypes: $('resetTypes'),
    error: $('error'),
    savePng: $('savePng'),
  };
  const ctx = ui.canvas.getContext('2d');
  const HOVER_HINT = 'Hover over a cell to see what it can still become.';
  const STORAGE_KEY = 'terrain-generator.types.v1';
  const BG = [17, 20, 24]; // cells still in superposition fade toward the page background
  const MAX_VORONOI_PIXELS = 8e6; // above this the Voronoi buffer uses fewer pixels per cell

  // Editable model: { types: [{ id, name, color: '#rrggbb', weight, neighbors: [id], weightNear: { id: w } }] }
  let config = null;
  let rules = null; // compiled from config by wfc.js
  let typeRgb = [];
  let maskColors = new Map();
  let solver = null;
  let paused = false;
  let rafId = 0;
  let regenTimer = 0;
  let solveMs = 0;
  let seedUsed = 0;
  let hoverCell = -1;
  let off = null;
  let offCtx = null;
  let image = null;
  let pixels = null;
  let solverError = false;
  let offsets = null; // per cell: random direction in [-1, 1]², scaled by the offset slider
  let vor = null; // Voronoi pixel map, or null when drawing plain squares
  let vorRebuild = 0;

  // ---- colours --------------------------------------------------------------

  const probe = document.createElement('canvas').getContext('2d');

  // Accepts any CSS colour ("brown", "#8b5a2b", "rgb(139 90 43)") and returns [r, g, b].
  function parseColor(str, typeId) {
    probe.fillStyle = '#010203';
    probe.fillStyle = str;
    const v = probe.fillStyle;
    if (v === '#010203' && !/^#?010203$/i.test(String(str).trim())) {
      throw new Error(`"${typeId}".color: "${str}" isn't a CSS colour.`);
    }
    if (v[0] === '#') return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
    return v.match(/[\d.]+/g).slice(0, 3).map(Number);
  }

  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  function pack(r, g, b) {
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0; // ImageData is RGBA bytes = ABGR little-endian
  }

  function maskColor(mask) {
    let c = maskColors.get(mask);
    if (c !== undefined) return c;
    let r = 0, g = 0, b = 0, n = 0;
    for (let t = 0; t < typeRgb.length; t++) {
      if ((mask >>> t) & 1) {
        r += typeRgb[t][0];
        g += typeRgb[t][1];
        b += typeRgb[t][2];
        n++;
      }
    }
    if (n === 0) {
      c = pack(255, 0, 80); // contradiction; only visible mid-repair
    } else {
      r /= n; g /= n; b /= n;
      if (n > 1) {
        // Average of the possible colours, fainter the more options remain.
        const T = typeRgb.length;
        const f = 0.22 + 0.4 * (1 - (n - 2) / Math.max(1, T - 2));
        r = BG[0] + (r - BG[0]) * f;
        g = BG[1] + (g - BG[1]) * f;
        b = BG[2] + (b - BG[2]) * f;
      }
      c = pack(Math.round(r), Math.round(g), Math.round(b));
    }
    maskColors.set(mask, c);
    return c;
  }

  // ---- config -------------------------------------------------------------------

  function showError(msg, fromSolver = false) {
    ui.error.textContent = msg;
    ui.error.hidden = !msg;
    solverError = fromSolver && !!msg;
  }

  // Validates any loaded JSON and turns it into the editable model: ids everywhere,
  // hex colours, symmetric neighbour lists.
  function normalize(raw) {
    const compiled = compileRules(raw);
    const T = compiled.types.length;
    return {
      types: compiled.types.map((t, i) => ({
        id: t.id,
        name: t.name,
        color: toHex(parseColor(t.color, t.id)),
        weight: t.weight,
        neighbors: compiled.types.filter((_, j) => (compiled.allowed[i] >>> j) & 1).map((o) => o.id),
        weightNear: Object.fromEntries(
          compiled.types.map((o, j) => [o.id, compiled.near[i * T + j]]).filter(([, v]) => !Number.isNaN(v))
        ),
      })),
    };
  }

  function exportable() {
    return {
      types: config.types.map(({ id, name, color, weight, neighbors, weightNear }) => ({
        id,
        name,
        color,
        weight,
        neighbors,
        ...(Object.keys(weightNear).length ? { weightNear } : {}),
      })),
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(exportable()));
    } catch (_) {
      // storage unavailable (private window etc.): edits just won't survive a reload
    }
  }

  function useConfig(raw) {
    try {
      config = normalize(raw);
    } catch (err) {
      showError(err.message);
      return false;
    }
    showError('');
    editor.render();
    updateAddButton();
    compileAndGenerate();
    return true;
  }

  function compileAndGenerate() {
    clearTimeout(regenTimer);
    try {
      rules = compileRules(config);
      typeRgb = config.types.map((t) => parseColor(t.color, t.id));
      maskColors = new Map();
    } catch (err) {
      showError(err.message);
      return;
    }
    generate();
  }

  async function loadDefaults() {
    try {
      const res = await fetch('tiles.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (useConfig(await res.json())) save();
    } catch (err) {
      showError(
        `Couldn't load tiles.json (${err.message}).\n` +
        'Browsers block reading files when index.html is opened straight from disk. ' +
        'Run "python -m http.server 8123" in this folder and open http://localhost:8123, ' +
        'or use "Import" to pick tiles.json.'
      );
    }
  }

  function updateAddButton() {
    ui.addType.disabled = !editor.canAdd();
    ui.addType.title = editor.canAdd() ? 'Add a new terrain type' : `At most ${window.TerrainWFC.MAX_TYPES} types`;
  }

  const editor = window.TerrainEditor.createTypeEditor(ui.types, {
    getConfig: () => config,
    onChange(kind) {
      save();
      if (kind === 'structure') updateAddButton();
      if (kind === 'label') {
        if (rules && rules.types.length === config.types.length) {
          config.types.forEach((t, i) => (rules.types[i].name = t.name));
        }
        updateHover();
        return;
      }
      if (kind === 'color' && !regenTimer && rules && rules.types.length === config.types.length) {
        typeRgb = config.types.map((t) => parseColor(t.color, t.id));
        maskColors = new Map();
        if (solver) {
          solver.markAllDirty();
          draw();
        }
        return;
      }
      // Rule changes: regenerate once the user pauses for a moment.
      clearTimeout(regenTimer);
      regenTimer = setTimeout(() => {
        regenTimer = 0;
        compileAndGenerate();
      }, 250);
    },
  });

  // ---- generation loop --------------------------------------------------------------

  function readInt(input, min, max, fallback) {
    let v = parseInt(input.value, 10);
    if (!Number.isFinite(v)) v = fallback;
    v = Math.min(max, Math.max(min, v));
    input.value = v;
    return v;
  }

  function stepsPerFrame() {
    return Math.max(1, Math.round(10 ** (Number(ui.speed.value) / 25))); // 1 … 10 000
  }

  function generate() {
    if (!rules) return;
    stop();
    if (solverError) showError('');
    const width = readInt(ui.width, 5, 1000, 160);
    const height = readInt(ui.height, 5, 1000, 100);
    const seedText = ui.seed.value.trim();
    seedUsed = seedText ? seedFromString(seedText) : (Math.random() * 2 ** 32) >>> 0;

    const t0 = performance.now();
    solver = new Solver(rules, {
      width,
      height,
      neighborhood: Number(ui.neighborhood.value),
      selection: ui.selection.value,
      seed: seedUsed,
    });
    solveMs = performance.now() - t0;
    paused = false;

    // Point offsets come from the seed too, so the same seed gives the same picture.
    const rng = makeRng(seedUsed ^ 0x9e3779b9);
    offsets = new Float32Array(solver.N * 2);
    for (let i = 0; i < offsets.length; i++) offsets[i] = rng() * 2 - 1;

    setupSurface();
    schedule();
  }

  // (Re)creates the offscreen image the map is painted into: one pixel per cell for plain
  // squares, or a finer Voronoi image. Called on new maps and when drawing settings change.
  function setupSurface() {
    if (!solver) return;
    const cs = readInt(ui.cellSize, 1, 40, 6);
    ui.canvas.width = solver.W * cs;
    ui.canvas.height = solver.H * cs;

    let w = solver.W;
    let h = solver.H;
    vor = null;
    if (ui.voronoi.checked) {
      const scale = Math.max(1, Math.min(cs, Math.floor(Math.sqrt(MAX_VORONOI_PIXELS / solver.N))));
      vor = buildVoronoi(solver.W, solver.H, scale, Number(ui.jitter.value));
      w = vor.w;
      h = vor.h;
    }
    if (!off || off.width !== w || off.height !== h) {
      off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      offCtx = off.getContext('2d');
      image = offCtx.createImageData(w, h);
      pixels = new Uint32Array(image.data.buffer);
    }
    solver.markAllDirty();
    draw();
  }

  // Each cell is a point at its centre, moved by up to `jitter` cells in x and y. Every pixel of
  // the scale×scale-per-cell image belongs to the nearest point. Returns that ownership both ways:
  // owner[pixel] -> cell, and list[start[cell] .. start[cell + 1]) -> the cell's pixels.
  function buildVoronoi(W, H, scale, jitter) {
    const N = W * H;
    const vw = W * scale;
    const vh = H * scale;
    const ptX = new Float32Array(N);
    const ptY = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      ptX[c] = (c % W) + 0.5 + jitter * offsets[2 * c];
      ptY[c] = ((c / W) | 0) + 0.5 + jitter * offsets[2 * c + 1];
    }

    // How many cells out to look. The pixel's own point is at most √2·(0.5 + jitter) away, and a
    // point k cells over is at least k − 1 − jitter away, so anything beyond R can't be nearer.
    const R = Math.floor(1 + Math.SQRT1_2 + (1 + Math.SQRT2) * jitter);
    const cand = new Int32Array((2 * R + 1) ** 2);
    const owner = new Int32Array(vw * vh);
    for (let cy = 0; cy < H; cy++) {
      for (let cx = 0; cx < W; cx++) {
        let n = 0;
        for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
          for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) cand[n++] = y * W + x;
        }
        for (let sy = 0; sy < scale; sy++) {
          const v = cy + (sy + 0.5) / scale;
          const row = (cy * scale + sy) * vw + cx * scale;
          for (let sx = 0; sx < scale; sx++) {
            const u = cx + (sx + 0.5) / scale;
            let best = cand[0];
            let bestD = Infinity;
            for (let k = 0; k < n; k++) {
              const c = cand[k];
              const dx = ptX[c] - u;
              const dy = ptY[c] - v;
              const d = dx * dx + dy * dy;
              if (d < bestD) {
                bestD = d;
                best = c;
              }
            }
            owner[row + sx] = best;
          }
        }
      }
    }

    const start = new Int32Array(N + 1);
    for (let p = 0; p < owner.length; p++) start[owner[p] + 1]++;
    for (let c = 0; c < N; c++) start[c + 1] += start[c];
    const fill = start.slice(0, N);
    const list = new Int32Array(owner.length);
    for (let p = 0; p < owner.length; p++) list[fill[owner[p]]++] = p;

    return { w: vw, h: vh, owner, start, list };
  }

  function schedule() {
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function frame() {
    rafId = 0;
    if (!solver) return;
    if (!paused && solver.status === 'running') {
      const t0 = performance.now();
      const instant = ui.instant.checked;
      const limit = instant ? Infinity : stepsPerFrame();
      const deadline = t0 + (instant ? 30 : 12); // keep the page responsive on big grids
      for (let i = 1; i <= limit && solver.step() === 'running'; i++) {
        if ((i & 31) === 0 && performance.now() > deadline) break;
      }
      solveMs += performance.now() - t0;
    }
    draw();
    if (!paused && solver.status === 'running') schedule();
  }

  function stepOnce() {
    if (!solver || solver.status !== 'running') return;
    paused = true;
    stop();
    const t0 = performance.now();
    solver.step();
    solveMs += performance.now() - t0;
    draw();
  }

  function togglePause() {
    if (!solver || solver.status !== 'running') return;
    paused = !paused;
    if (paused) stop();
    else schedule();
    updatePanel();
  }

  // ---- drawing & panel -----------------------------------------------------------------

  function draw() {
    if (!solver) return;
    if (vor) {
      const { start, list } = vor;
      solver.consumeDirty((c, m) => {
        const col = maskColor(m);
        for (let i = start[c], end = start[c + 1]; i < end; i++) pixels[list[i]] = col;
      });
    } else {
      solver.consumeDirty((c, m) => {
        pixels[c] = maskColor(m);
      });
    }
    offCtx.putImageData(image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, ui.canvas.width, ui.canvas.height);
    updatePanel();
    updateHover();
  }

  const fmt = (n) => n.toLocaleString('en-US');

  function updatePanel() {
    const s = solver;
    const running = s.status === 'running';
    ui.pause.disabled = !running;
    ui.step.disabled = !running;
    ui.pause.textContent = paused && running ? 'Resume' : 'Pause';

    const counts = new Uint32Array(rules.types.length);
    for (let c = 0; c < s.N; c++) {
      const t = s.typeAt(c);
      if (t >= 0) counts[t]++;
    }
    editor.setShares(new Map(rules.types.map((t, i) => [t.id, counts[i] / s.N])));

    const statusText = {
      running: paused ? 'Paused' : 'Generating…',
      done: 'Done',
      failed: 'Failed',
    }[s.status];
    const rows = [
      ['Status', statusText, `status-${s.status}`],
      ['Settled', `${fmt(s.settled)} / ${fmt(s.N)} (${Math.floor((s.settled / s.N) * 100)}%)`],
      ['Random picks', fmt(s.steps)],
      ['Backtracks', s.repairs ? `${fmt(s.backtracks)} (${fmt(s.repairs)} repairs)` : fmt(s.backtracks)],
      ['Seed', String(seedUsed)],
      ['Solve time', `${(solveMs / 1000).toFixed(2)} s`],
    ];
    ui.stats.textContent = '';
    for (const [k, v, cls] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (cls) dd.className = cls;
      ui.stats.append(dt, dd);
    }
    if (s.status === 'failed') showError(s.message, true);
  }

  function updateHover() {
    const el = ui.hover;
    if (!solver || hoverCell < 0 || hoverCell >= solver.N) {
      el.textContent = HOVER_HINT;
      return;
    }
    const x = hoverCell % solver.W;
    const y = (hoverCell / solver.W) | 0;
    el.textContent = `(${x}, ${y})  `;
    const t = solver.typeAt(hoverCell);
    if (t >= 0) {
      const b = document.createElement('strong');
      b.textContent = rules.types[t].name;
      el.append(b);
      return;
    }
    const opts = solver.optionsFor(hoverCell);
    if (!opts.length) {
      el.append('contradiction');
      return;
    }
    const total = opts.reduce((a, o) => a + o.weight, 0);
    opts.sort((a, b) => b.weight - a.weight);
    el.append(
      'could be: ' +
      opts
        .map((o) => {
          const p = total > 0 ? (o.weight / total) * 100 : 100 / opts.length;
          return `${rules.types[o.type].name} ${p.toFixed(0)}%`;
        })
        .join(' · ')
    );
  }

  ui.canvas.addEventListener('mousemove', (e) => {
    if (!solver) return;
    const r = ui.canvas.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    if (fx < 0 || fy < 0 || fx >= 1 || fy >= 1) {
      hoverCell = -1;
    } else if (vor) {
      hoverCell = vor.owner[Math.floor(fy * vor.h) * vor.w + Math.floor(fx * vor.w)]; // the cell whose region is under the mouse
    } else {
      hoverCell = Math.floor(fy * solver.H) * solver.W + Math.floor(fx * solver.W);
    }
    updateHover();
  });
  ui.canvas.addEventListener('mouseleave', () => {
    hoverCell = -1;
    updateHover();
  });

  // ---- controls ------------------------------------------------------------------

  function updateSpeedLabel() {
    ui.speed.disabled = ui.instant.checked;
    ui.speedOut.textContent = ui.instant.checked ? 'instant' : `${fmt(stepsPerFrame())} cells / frame`;
  }

  ui.generate.addEventListener('click', generate);
  ui.pause.addEventListener('click', togglePause);
  ui.step.addEventListener('click', stepOnce);
  ui.speed.addEventListener('input', updateSpeedLabel);
  ui.instant.addEventListener('change', () => {
    updateSpeedLabel();
    if (solver && !paused && solver.status === 'running') schedule();
  });
  ui.cellSize.addEventListener('change', setupSurface);

  function updateJitterLabel() {
    ui.jitter.disabled = !ui.voronoi.checked;
    ui.jitterOut.textContent = `${Number(ui.jitter.value).toFixed(2)} cells`;
  }
  ui.voronoi.addEventListener('change', () => {
    updateJitterLabel();
    setupSurface();
  });
  ui.jitter.addEventListener('input', () => {
    updateJitterLabel();
    // Rebuilding the pixel map can take tens of ms; do it at most once per frame while dragging.
    if (!vorRebuild) {
      vorRebuild = requestAnimationFrame(() => {
        vorRebuild = 0;
        setupSurface();
      });
    }
  });
  for (const el of [ui.width, ui.height, ui.selection, ui.neighborhood, ui.seed]) {
    el.addEventListener('change', generate);
  }

  ui.addType.addEventListener('click', () => editor.addType());

  ui.exportJson.addEventListener('click', () => {
    if (!config) return;
    const blob = new Blob([JSON.stringify(exportable(), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tiles.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  ui.importJson.addEventListener('change', async () => {
    const file = ui.importJson.files[0];
    ui.importJson.value = '';
    if (!file) return;
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch (err) {
      showError(`${file.name} isn't valid JSON: ${err.message}`);
      return;
    }
    if (useConfig(raw)) save();
  });

  ui.resetTypes.addEventListener('click', () => {
    if (!confirm('Throw away your type edits and load the defaults from tiles.json?')) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      // nothing saved to remove
    }
    loadDefaults();
  });

  ui.savePng.addEventListener('click', () => {
    if (!solver) return;
    ui.canvas.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `terrain-${seedUsed}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest('input, textarea, select')) return;
    if (e.key === 'g' || e.key === 'G') generate();
    else if (e.key === 's' || e.key === 'S') stepOnce();
    else if (e.key === ' ' && !(t.closest && t.closest('button, summary, label'))) {
      e.preventDefault();
      togglePause();
    }
  });

  // ---- start ------------------------------------------------------------------

  updateSpeedLabel();
  updateJitterLabel();
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch (_) {
    // no saved edits
  }
  if (!saved || !useConfig(saved)) loadDefaults();
})();
