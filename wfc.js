// Wave-function-collapse terrain solver. Pure logic, no DOM: main.js drives it.
//
// Every cell holds a bitmask of the types it can still become (bit t set = type t possible).
// A cell is "in superposition" while more than one bit is set. Collapsing a cell locks it to one
// type, then propagation strips incompatible types from neighbours, their neighbours, and so on.
//
// If propagation ever empties a cell (a contradiction), we first undo the last choice and forbid
// it. If that still contradicts, the area around the conflict is put back into superposition and
// refilled, widening the area each time it fails again.
(function (global) {
  'use strict';

  const MAX_TYPES = 32; // one bit per type in a Uint32
  const DIRS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIRS_8 = DIRS_4.concat([[1, 1], [1, -1], [-1, 1], [-1, -1]]);

  function popcount(m) {
    m = m - ((m >>> 1) & 0x55555555);
    m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
    return Math.imul((m + (m >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  function bit(t) {
    return (1 << t) >>> 0;
  }

  // mulberry32: small, fast, seedable
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Numeric strings are used as-is, anything else is hashed (FNV-1a) so "hello" is a valid seed.
  function seedFromString(str) {
    const s = String(str).trim();
    if (/^\d+$/.test(s)) return Number(s) >>> 0;
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Turns the JSON config into lookup tables. Throws with a readable message on bad input.
  function compileRules(config) {
    if (!config || !Array.isArray(config.types) || config.types.length === 0) {
      throw new Error('The config needs a non-empty "types" array.');
    }
    const defs = config.types;
    const T = defs.length;
    if (T > MAX_TYPES) throw new Error(`At most ${MAX_TYPES} types are supported (found ${T}).`);

    const ids = defs.map((d, i) => {
      if (!d || typeof d !== 'object') throw new Error(`types[${i}] must be an object.`);
      return d.id !== undefined ? String(d.id) : String(i);
    });
    const index = new Map();
    ids.forEach((id, i) => {
      if (index.has(id)) throw new Error(`Duplicate type id "${id}".`);
      index.set(id, i);
    });
    // A reference can be a type id ("sand") or a position in the list (2).
    const resolve = (ref, where) => {
      if (index.has(String(ref))) return index.get(String(ref));
      if (Number.isInteger(ref) && ref >= 0 && ref < T) return ref;
      throw new Error(`${where}: unknown type "${ref}".`);
    };

    const allowed = new Uint32Array(T); // allowed[t] = mask of types that may sit next to t
    const weight = new Float64Array(T);
    const near = new Float64Array(T * T).fill(NaN); // near[t*T + n] = weight of t when next to n

    const types = defs.map((d, i) => {
      const id = ids[i];
      const w = d.weight === undefined ? 1 : Number(d.weight);
      if (!(w >= 0)) throw new Error(`"${id}".weight must be a number >= 0.`);
      weight[i] = w;

      if (!Array.isArray(d.neighbors)) throw new Error(`"${id}" needs a "neighbors" array.`);
      for (const ref of d.neighbors) {
        const j = resolve(ref, `"${id}".neighbors`);
        // One side listing the pair is enough: it's allowed in both directions.
        allowed[i] |= bit(j);
        allowed[j] |= bit(i);
      }

      if (d.weightNear !== undefined) {
        if (!d.weightNear || typeof d.weightNear !== 'object' || Array.isArray(d.weightNear)) {
          throw new Error(`"${id}".weightNear must be an object like { "village": 0.7 }.`);
        }
        for (const [ref, v] of Object.entries(d.weightNear)) {
          const j = resolve(ref, `"${id}".weightNear`);
          const nv = Number(v);
          if (!(nv >= 0)) throw new Error(`"${id}".weightNear["${ref}"] must be a number >= 0.`);
          near[i * T + j] = nv;
        }
      }

      return {
        id,
        name: d.name !== undefined ? String(d.name) : id,
        color: d.color !== undefined ? String(d.color) : '#ff00ff',
        weight: w,
      };
    });

    return { types, allowed, weight, near };
  }

  class Solver {
    // opts: { width, height, neighborhood: 4|8, selection: 'random'|'entropy', seed }
    constructor(rules, opts) {
      this.rules = rules;
      this.T = rules.types.length;
      this.W = opts.width;
      this.H = opts.height;
      this.N = this.W * this.H;
      this.selection = opts.selection === 'entropy' ? 'entropy' : 'random';
      this.rng = makeRng(opts.seed);
      this.full = this.T === 32 ? 0xffffffff : 2 ** this.T - 1;

      const dirs = opts.neighborhood === 4 ? DIRS_4 : DIRS_8;
      this.D = dirs.length;
      this.nbr = new Int32Array(this.N * this.D); // -1 = off the map
      for (let y = 0; y < this.H; y++) {
        for (let x = 0; x < this.W; x++) {
          const base = (y * this.W + x) * this.D;
          dirs.forEach(([dx, dy], k) => {
            const nx = x + dx;
            const ny = y + dy;
            this.nbr[base + k] = nx >= 0 && ny >= 0 && nx < this.W && ny < this.H ? ny * this.W + nx : -1;
          });
        }
      }

      this.dom = new Uint32Array(this.N);
      this.locked = new Uint8Array(this.N); // 1 = type was picked at random (not forced by neighbours)
      this.pos = new Int32Array(this.N);
      this.queue = new Int32Array(this.N);
      this.inQueue = new Uint8Array(this.N);
      this.dirty = new Uint8Array(this.N);
      this.dirtyList = [];
      this.compatCache = new Map();
      this.trailCell = []; // changes made by the current pick, so it can be undone
      this.trailMask = [];
      this.recording = false;
      this.conflict = -1; // cell that ran out of options in the last failed propagation
      this.qLen = 0;
      this.open = 0; // cells still in superposition
      this.buckets = [];
      for (let k = 0; k <= this.T; k++) this.buckets.push([]);

      this.steps = 0; // random picks (cells settled by their neighbours don't count)
      this.backtracks = 0;
      this.repairs = 0;
      this.maxRepairs = Math.max(2000, this.N);
      this.lastRepair = -1;
      this.lastRadius = 2;
      this.seen = new Uint32Array(this.N);
      this.stack = new Int32Array(this.N);
      this.stamp = 0;
      this.message = '';

      this._reset();
      if (this.status === 'failed') {
        this.message = 'These rules can’t fill the grid at all: some cell ends up with no possible type.';
      }
    }

    // ---- public API -------------------------------------------------------

    // Locks one random cell that's still in superposition. Returns 'running', 'done' or 'failed'.
    step() {
      if (this.status !== 'running') return this.status;
      const c = this._selectCell();
      if (c < 0) return (this.status = 'done');

      const t = this._chooseType(c);
      this.steps++;
      this.trailCell.length = 0;
      this.trailMask.length = 0;
      this.recording = true;
      this._set(c, bit(t));
      this.locked[c] = 1;
      this._enqueue(c);
      const ok = this._propagate();
      this.recording = false;

      if (!ok) {
        // Undo this pick and forbid it here. Usually that's enough.
        this.backtracks++;
        this._undoTrail();
        this.locked[c] = 0;
        this._set(c, (this.dom[c] & ~bit(t)) >>> 0);
        this._enqueue(c);
        if (!this._propagate()) this._repair(this.conflict);
      }

      if (this.status === 'running' && this.open === 0) this.status = 'done';
      return this.status;
    }

    // Type index if the cell is settled, otherwise -1.
    typeAt(c) {
      const m = this.dom[c];
      return m !== 0 && (m & (m - 1)) === 0 ? 31 - Math.clz32(m) : -1;
    }

    // The types a cell can still become, with the weights it would roll with right now.
    optionsFor(c) {
      const { T, dom, nbr, D } = this;
      const { weight, near } = this.rules;

      let nearMask = 0; // types of the settled neighbours
      for (let k = 0; k < D; k++) {
        const n = nbr[c * D + k];
        if (n < 0) continue;
        const nm = dom[n];
        if (nm !== 0 && (nm & (nm - 1)) === 0) nearMask |= nm;
      }

      const m = dom[c];
      const out = [];
      for (let t = 0; t < T; t++) {
        if (!((m >>> t) & 1)) continue;
        // A weightNear entry overrides the base weight when a matching neighbour exists.
        // If several match, the highest one wins.
        let boosted = -1;
        if (nearMask !== 0) {
          for (let j = 0; j < T; j++) {
            if ((nearMask >>> j) & 1) {
              const v = near[t * T + j];
              if (v > boosted) boosted = v;
            }
          }
        }
        out.push({ type: t, weight: boosted >= 0 ? boosted : weight[t] });
      }
      return out;
    }

    // Calls fn(cell, mask) for every cell that changed since the last call.
    consumeDirty(fn) {
      const list = this.dirtyList;
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        this.dirty[c] = 0;
        fn(c, this.dom[c]);
      }
      list.length = 0;
    }

    // Forces a full redraw on the next consumeDirty (e.g. after a colour change).
    markAllDirty() {
      this.dirtyList.length = 0;
      for (let c = 0; c < this.N; c++) {
        this.dirty[c] = 1;
        this.dirtyList.push(c);
      }
    }

    get settled() {
      return this.N - this.open;
    }

    // ---- internals --------------------------------------------------------

    // Everything back into full superposition.
    _reset() {
      this.locked.fill(0);
      this._relaxBox(0, 0, this.W - 1, this.H - 1);
      this.status = this._propagate() ? 'running' : 'failed';
      if (this.status === 'running' && this.open === 0) this.status = 'done';
    }

    // Puts every cell in the box that isn't locked back into full superposition and queues the
    // box plus a one-cell ring around it, so constraints from outside flow back in.
    _relaxBox(x0, y0, x1, y1) {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = y * this.W + x;
          if (!this.locked[c] && this.dom[c] !== this.full) this._write(c, this.full);
        }
      }
      const ex0 = Math.max(0, x0 - 1);
      const ey0 = Math.max(0, y0 - 1);
      const ex1 = Math.min(this.W - 1, x1 + 1);
      const ey1 = Math.min(this.H - 1, y1 + 1);
      for (let y = ey0; y <= ey1; y++) {
        for (let x = ex0; x <= ex1; x++) this._enqueue(y * this.W + x);
      }
    }

    // Unlocks the cells within radius r of the conflict, then rebuilds every unlocked cell's
    // options from the locked cells that remain. If that still contradicts, the radius doubles;
    // past the map size everything is wiped. Repeated failures in the same spot start bigger.
    _repair(center) {
      const cx0 = center % this.W;
      const cy0 = (center / this.W) | 0;
      const nearLast =
        this.lastRepair >= 0 &&
        Math.max(Math.abs(cx0 - (this.lastRepair % this.W)), Math.abs(cy0 - ((this.lastRepair / this.W) | 0))) <=
          2 * this.lastRadius;
      let r = nearLast ? this.lastRadius * 2 : 2;

      for (; ; r *= 2) {
        if (++this.repairs > this.maxRepairs) {
          this.status = 'failed';
          this.message =
            `Gave up after ${this.maxRepairs.toLocaleString('en-US')} repairs: the rules contradict each ` +
            'other too often. "Fewest options first" copes better with strict rules than random order.';
          return;
        }
        if (center < 0 || r >= Math.max(this.W, this.H)) {
          this.lastRepair = -1;
          this._reset();
          if (this.status === 'failed') {
            this.message = 'These rules can’t fill the grid at all: some cell ends up with no possible type.';
          }
          return;
        }
        const cx = center % this.W;
        const cy = (center / this.W) | 0;
        const x0 = Math.max(0, cx - r);
        const y0 = Math.max(0, cy - r);
        const x1 = Math.min(this.W - 1, cx + r);
        const y1 = Math.min(this.H - 1, cy + r);
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) this.locked[y * this.W + x] = 0;
        }
        this.lastRepair = center;
        this.lastRadius = r;
        this._relaxConnected(x0, y0, x1, y1);
        if (this._propagate()) return;
        center = this.conflict;
      }
    }

    // Puts the box back into superposition, along with every unlocked cell connected to it.
    // A removed lock can only have restricted cells through chains of unlocked cells (locked
    // cells never change), so nothing beyond that region needs recomputing. Locked cells on its
    // border are queued so their constraints flow back in.
    _relaxConnected(x0, y0, x1, y1) {
      const { seen, stack, nbr, D, locked, dom, full } = this;
      const stamp = ++this.stamp;
      let sp = 0;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const c = y * this.W + x;
          seen[c] = stamp;
          stack[sp++] = c;
        }
      }
      while (sp > 0) {
        const c = stack[--sp];
        this._enqueue(c);
        if (locked[c]) continue;
        if (dom[c] !== full) this._write(c, full);
        const base = c * D;
        for (let k = 0; k < D; k++) {
          const n = nbr[base + k];
          if (n >= 0 && seen[n] !== stamp) {
            seen[n] = stamp;
            stack[sp++] = n;
          }
        }
      }
    }

    _set(c, m) {
      if (this.recording) {
        this.trailCell.push(c);
        this.trailMask.push(this.dom[c]);
      }
      this._write(c, m);
    }

    _undoTrail() {
      const { trailCell, trailMask } = this;
      while (trailCell.length) this._write(trailCell.pop(), trailMask.pop());
    }

    _write(c, m) {
      const k0 = popcount(this.dom[c]);
      const k1 = popcount(m);
      this.dom[c] = m;
      if (k0 !== k1) {
        if (k0 >= 2) this._bucketRemove(k0, c);
        if (k1 >= 2) this._bucketAdd(k1, c);
      }
      if (!this.dirty[c]) {
        this.dirty[c] = 1;
        this.dirtyList.push(c);
      }
    }

    // buckets[k] holds the cells with exactly k options left (k >= 2), for O(1) random picks.
    _bucketAdd(k, c) {
      const b = this.buckets[k];
      this.pos[c] = b.length;
      b.push(c);
      this.open++;
    }

    _bucketRemove(k, c) {
      const b = this.buckets[k];
      const i = this.pos[c];
      const last = b.pop();
      if (last !== c) {
        b[i] = last;
        this.pos[last] = i;
      }
      this.open--;
    }

    _enqueue(c) {
      if (!this.inQueue[c]) {
        this.inQueue[c] = 1;
        this.queue[this.qLen++] = c;
      }
    }

    // Union of everything the types in `mask` are allowed to touch.
    _compat(mask) {
      let v = this.compatCache.get(mask);
      if (v === undefined) {
        v = 0;
        for (let t = 0; t < this.T; t++) if ((mask >>> t) & 1) v |= this.rules.allowed[t];
        v >>>= 0;
        this.compatCache.set(mask, v);
      }
      return v;
    }

    // Spreads restrictions outward until nothing changes. Returns false on contradiction.
    _propagate() {
      const { dom, nbr, D, queue, inQueue } = this;
      while (this.qLen > 0) {
        const c = queue[--this.qLen];
        inQueue[c] = 0;
        const compat = this._compat(dom[c]);
        const base = c * D;
        for (let k = 0; k < D; k++) {
          const n = nbr[base + k];
          if (n < 0) continue;
          const m = dom[n];
          const m2 = (m & compat) >>> 0;
          if (m2 === m) continue;
          this._set(n, m2);
          if (m2 === 0) {
            this.conflict = n;
            while (this.qLen > 0) inQueue[queue[--this.qLen]] = 0;
            return false;
          }
          this._enqueue(n);
        }
      }
      return true;
    }

    _selectCell() {
      if (this.open === 0) return -1;
      const { buckets, T, rng } = this;
      if (this.selection === 'entropy') {
        // Fewest options first; this grows the map outward from what's already settled.
        for (let k = 2; k <= T; k++) {
          const b = buckets[k];
          if (b.length) return b[(rng() * b.length) | 0];
        }
        return -1;
      }
      // Uniformly random among every cell still in superposition.
      let r = (rng() * this.open) | 0;
      for (let k = 2; k <= T; k++) {
        const b = buckets[k];
        if (r < b.length) return b[r];
        r -= b.length;
      }
      return -1;
    }

    _chooseType(c) {
      const opts = this.optionsFor(c);
      let total = 0;
      for (const o of opts) total += o.weight;
      if (total <= 0) return opts[(this.rng() * opts.length) | 0].type;
      let r = this.rng() * total;
      for (const o of opts) {
        r -= o.weight;
        if (r < 0) return o.type;
      }
      return opts[opts.length - 1].type;
    }
  }

  global.TerrainWFC = { compileRules, Solver, seedFromString, makeRng, MAX_TYPES };
})(typeof window !== 'undefined' ? window : globalThis);
