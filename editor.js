// Type editor: the list of terrain types in the sidebar. Click a type to edit its name, colour,
// weight, what it can touch, and how its weight changes next to other types.
//
// It edits the shared config object in place and reports what changed through onChange(kind):
//   'rules'     neighbours / weights changed: regenerate
//   'structure' a type was added or removed: regenerate
//   'color'     only colours changed: redraw
//   'label'     only names changed: nothing to recompute
(function (global) {
  'use strict';

  const MAX_TYPES = global.TerrainWFC.MAX_TYPES;

  function h(tag, props, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e) e[k] = v;
      else e.setAttribute(k, v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }

  function swatch(color) {
    const s = h('span', { class: 'swatch' });
    s.style.background = color;
    return s;
  }

  function slug(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'type';
  }

  function randomColor() {
    const hue = Math.random() * 360;
    const s = 0.45;
    const l = 0.55;
    const f = (n) => {
      const k = (n + hue / 30) % 12;
      const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(c * 255).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function createTypeEditor(root, { getConfig, onChange }) {
    let openId = null;
    let shares = new Map(); // id -> fraction of the map, shown next to each type
    const shareEls = new Map();

    const types = () => getConfig().types;
    const touches = (a, b) => a.neighbors.includes(b.id) || b.neighbors.includes(a.id);

    // The GUI keeps neighbour lists symmetric, so the JSON export reads the same from both sides.
    function setTouch(a, b, on) {
      if (on) {
        if (!a.neighbors.includes(b.id)) a.neighbors.push(b.id);
        if (!b.neighbors.includes(a.id)) b.neighbors.push(a.id);
      } else {
        a.neighbors = a.neighbors.filter((id) => id !== b.id);
        b.neighbors = b.neighbors.filter((id) => id !== a.id);
      }
    }

    function uniqueId(base, except) {
      let id = base;
      for (let n = 2; types().some((t) => t.id === id && t !== except); n++) id = `${base}_${n}`;
      return id;
    }

    // Ids are hidden in the GUI; they follow the name so exported JSON stays readable.
    function syncId(type) {
      const old = type.id;
      const id = uniqueId(slug(type.name), type);
      if (id === old) return;
      for (const t of types()) {
        t.neighbors = t.neighbors.map((n) => (n === old ? id : n));
        if (old in t.weightNear) {
          t.weightNear[id] = t.weightNear[old];
          delete t.weightNear[old];
        }
      }
      shares.set(id, shares.get(old));
      const pctEl = shareEls.get(old);
      shareEls.delete(old);
      if (pctEl) shareEls.set(id, pctEl);
      type.id = id;
      if (openId === old) openId = id;
    }

    function addType() {
      if (types().length >= MAX_TYPES) return;
      const t = { id: '', name: 'New type', color: randomColor(), weight: 0.1, continent: '', neighbors: [], weightNear: {} };
      t.id = uniqueId(slug(t.name));
      t.neighbors.push(t.id);
      types().push(t);
      // Start it off touching grassland (or the first type) so it doesn't take over the map.
      const anchor = types().find((o) => o.id === 'grass') || types()[0];
      if (anchor !== t) setTouch(t, anchor, true);
      openId = t.id;
      render();
      onChange('structure');
      const input = root.querySelector('.type.open input[type="text"]');
      if (input) {
        input.focus();
        input.select();
      }
    }

    function deleteType(t) {
      if (types().length <= 1) return;
      if (!confirm(`Delete "${t.name}"?`)) return;
      const cfg = getConfig();
      cfg.types = types().filter((o) => o !== t);
      for (const o of cfg.types) {
        o.neighbors = o.neighbors.filter((id) => id !== t.id);
        delete o.weightNear[t.id];
      }
      openId = null;
      render();
      onChange('structure');
    }

    function render() {
      root.textContent = '';
      shareEls.clear();
      for (const t of types()) root.append(renderItem(t));
      setShares(shares);
    }

    function renderItem(t) {
      const open = t.id === openId;
      const row = {
        swatch: swatch(t.color),
        name: h('span', { class: 'name' }, t.name),
        weight: h('span', { class: 'w' }, `w ${t.weight}`),
        pct: h('span', { class: 'pct' }),
      };
      shareEls.set(t.id, row.pct);
      const head = h(
        'button',
        {
          type: 'button',
          class: 'type-row',
          title: open ? 'Close' : 'Edit this type',
          onclick: () => {
            openId = open ? null : t.id;
            render();
          },
        },
        row.swatch, row.name, row.weight, row.pct, h('span', { class: 'chev' }, '›')
      );
      head.setAttribute('aria-expanded', String(open));
      const li = h('li', { class: open ? 'type open' : 'type' }, head);
      if (open) li.append(renderPanel(t, row));
      return li;
    }

    function renderPanel(t, row) {
      const chips = h('div', { class: 'chips' });
      const boosts = h('div', { class: 'boosts' });
      const warn = h('p', { class: 'warn' });

      const nameIn = h('input', {
        type: 'text',
        value: t.name,
        spellcheck: false,
        oninput: () => {
          t.name = nameIn.value;
          row.name.textContent = t.name;
          renderChips();
          renderBoosts();
          onChange('label');
        },
        onchange: () => {
          if (!t.name.trim()) {
            t.name = 'Unnamed';
            nameIn.value = t.name;
            row.name.textContent = t.name;
          }
          syncId(t);
          onChange('label');
        },
      });
      const colorIn = h('input', {
        type: 'color',
        value: t.color,
        oninput: () => {
          t.color = colorIn.value;
          row.swatch.style.background = t.color;
          renderChips();
          onChange('color');
        },
      });
      const weightIn = h('input', {
        type: 'number',
        min: 0,
        step: 0.05,
        value: t.weight,
        oninput: () => {
          const v = parseFloat(weightIn.value);
          t.weight = v >= 0 ? v : 0;
          row.weight.textContent = `w ${t.weight}`;
          onChange('rules');
        },
      });

      const continentSel = h('select', {
        onchange: () => {
          t.continent = continentSel.value;
          onChange('rules');
        },
      });
      for (const [value, label] of [
        ['', 'None (same everywhere)'],
        ['water', 'Water'],
        ['land', 'Land'],
        ['mountain', 'Mountain'],
      ]) {
        continentSel.append(h('option', { value, selected: (t.continent || '') === value }, label));
      }

      function renderChips() {
        chips.textContent = '';
        for (const o of types()) {
          const cb = h('input', {
            type: 'checkbox',
            checked: touches(t, o),
            onchange: () => {
              setTouch(t, o, cb.checked);
              renderWarn();
              onChange('rules');
            },
          });
          chips.append(h('label', { class: 'chip' }, cb, swatch(o.color), o === t ? `${o.name} (itself)` : o.name));
        }
      }

      function renderBoosts() {
        boosts.textContent = '';
        const near = t.weightNear;
        for (const id of Object.keys(near)) {
          const sel = h('select', {
            'aria-label': 'Neighbour type',
            onchange: () => {
              const v = near[id];
              delete near[id];
              near[sel.value] = v;
              renderBoosts();
              onChange('rules');
            },
          });
          for (const o of types()) {
            if (o.id === id || !(o.id in near)) sel.append(h('option', { value: o.id, selected: o.id === id }, o.name));
          }
          const num = h('input', {
            type: 'number',
            min: 0,
            step: 0.05,
            value: near[id],
            'aria-label': 'Weight next to it',
            oninput: () => {
              const v = parseFloat(num.value);
              near[id] = v >= 0 ? v : 0;
              onChange('rules');
            },
          });
          const remove = h('button', {
            type: 'button',
            class: 'icon',
            title: 'Remove',
            onclick: () => {
              delete near[id];
              renderBoosts();
              onChange('rules');
            },
          }, '×');
          boosts.append(h('div', { class: 'boost' }, h('span', {}, 'next to'), sel, h('span', {}, 'weight'), num, remove));
        }
        // Offer itself first: "more likely next to its own kind" is the usual way to grow patches.
        const free = !(t.id in near) ? t : types().find((o) => !(o.id in near));
        if (free) {
          boosts.append(h('button', {
            type: 'button',
            class: 'link',
            onclick: () => {
              near[free.id] = Math.max(0.5, Math.round(t.weight * 30) / 10);
              renderBoosts();
              onChange('rules');
            },
          }, '+ Add boost'));
        }
      }

      function renderWarn() {
        const others = types().some((o) => o !== t && touches(t, o));
        warn.hidden = others;
        warn.textContent = others ? '' : 'It can’t touch any other type, so a single cell of it would force the whole map to become it.';
      }

      renderChips();
      renderBoosts();
      renderWarn();

      return h(
        'div',
        { class: 'type-edit' },
        h('div', { class: 'type-fields' },
          h('label', { class: 'f-name' }, 'Name', nameIn),
          h('label', {}, 'Colour', colorIn),
          h('label', {}, 'Weight', weightIn)
        ),
        h('label', { class: 'f-continent' }, 'Continental layer: favoured near', continentSel),
        h('div', { class: 'sub' }, 'Can be next to'),
        chips,
        warn,
        h('div', { class: 'sub' }, 'Weight when next to…', h('span', { class: 'sub-hint' }, ' replaces the base weight; highest wins')),
        boosts,
        h('div', { class: 'type-foot' },
          h('button', { type: 'button', class: 'danger', disabled: types().length <= 1, onclick: () => deleteType(t) }, 'Delete type')
        )
      );
    }

    function setShares(map) {
      shares = map;
      for (const [id, el] of shareEls) {
        const v = shares.get(id);
        el.textContent = v === undefined ? '' : `${(v * 100).toFixed(1)}%`;
      }
    }

    return { render, addType, setShares, canAdd: () => types().length < MAX_TYPES };
  }

  global.TerrainEditor = { createTypeEditor };
})(window);
