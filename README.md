# Terrain Generator

A browser-based map generator built on **wave function collapse**. Every cell of the map starts
out able to be any terrain type. The generator repeatedly picks a cell, locks it to one type
(weighted by biases), and lets that choice ripple outward. A cell next to water, for example, can
then only become water, deep water or beach. The result is a map where every pair of neighbours
follows the rules you define.

On top of that come continents, climate zones, a paint brush, textures, a 3D landscape or globe
view, and PNG/SVG export. There's no build step and nothing to install: it's plain HTML, CSS and
JavaScript.

## Running it

The page has to be served over `http://`. Opening `index.html` by double-clicking it won't
work, because browsers block pages opened from disk from loading `tiles.json` and the 3D and SVG
modules.

**Windows:** double-click **`start.bat`**. It starts a local server and opens
<http://localhost:8123>. Close the window to stop it. It needs [Python](https://www.python.org/downloads/).

**Any system with Python 3:**

```bash
python -m http.server 8123
```

Then open <http://localhost:8123>. Use `python3` instead of `python` on macOS and Linux if needed.

**With Node.js instead of Python:**

```bash
npx serve -l 8123
```

Any other static file server works too, for example VS Code's *Live Server* extension.

**Internet access** is only needed the first time you use the **3D view** or **SVG export**:
they download [three.js](https://threejs.org/) and [Delaunator](https://github.com/mapbox/delaunator)
from cdn.jsdelivr.net, and the browser caches them afterwards. Everything else works offline.

Use a current version of Chrome, Edge, Firefox or Safari.

## Using it

### The basics

- **Generate** (or <kbd>G</kbd>) makes a new map. While it runs you can watch it fill in: faint
  cells are still undecided, and solid ones are settled.
- **Seed:** leave it empty for a random map each time, or type a number or word to get the same
  map again.
- **Preset** (top of the sidebar): ready-made worlds such as *Islands*, *World of lava*, *Simple
  continents*, *Villages and fields*, *Frozen north* and *Endless desert*.
- **Hover** over the map to see what a cell is, which climate zone it's in, or the odds it would
  roll with if it's still undecided.
- Click the status line under the seed for details: cells settled, random picks, backtracks,
  solve time.

### Sidebar tabs

| Tab | What's there |
|---|---|
| **World** | Map size, **shape** (flat or **sphere**), the **continental layer** (random water / land / desert… points that steer each area, with editable kinds and spawn odds), and **climate zones** (five latitude bands from tropical to polar, each with editable multipliers). |
| **Terrain** | The **terrain type editor**: colour, weight, which types it may touch, "weight when next to…" boosts, continental kind, texture and 3D height. You can also add, delete, import and export types here. |
| **Generator** | How cells are picked (random, or fewest-options-first), **neighbour radius** (4, 8, 12, 20… cells), **stability** (cells copy their neighbours), **cleanup passes** (lone cells join their surroundings) and animation **speed**. |
| **View** | **Voronoi** cell shapes and point offset, **textures** (icons per terrain type), continental point markers, the **3D view** (landscape, or a globe for sphere worlds) and **saving** as PNG or SVG. |

### Brush

Tick **Brush** under the map (or press <kbd>B</kbd>), pick a terrain type and a size, and drag
on a finished map. The surroundings adjust to fit the rules. Paint water through a mountain, for
example, and bands of sand, grass and forest appear between the river and the rock, while the
rest of the mountain stays. Right-click a cell to pick up its type. **Undo** or
<kbd>Ctrl</kbd>+<kbd>Z</kbd> takes back the last stroke. The brush works in the 2D view.

### Keyboard shortcuts

| Key | Action |
|---|---|
| <kbd>G</kbd> | Generate a new map |
| <kbd>Space</kbd> | Pause / resume |
| <kbd>S</kbd> | Collapse one cell |
| <kbd>C</kbd> | One cleanup pass |
| <kbd>B</kbd> | Brush on / off |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo the last brush stroke |

### Saving your work

- **Terrain types, continental kinds and climate zones** are saved in your browser automatically.
  **Export** downloads them as a `tiles.json` file; **Import** loads one back.
  **Reset to defaults** goes back to the `tiles.json` in this folder.
- **Maps:** *PNG image* saves exactly what you see, textures included. *SVG vector* saves true
  Voronoi shapes with one path per terrain type and flat colours, ready for Inkscape or
  Illustrator.

## Customising the defaults: `tiles.json`

`tiles.json` holds the default terrain types, continental kinds and climate zones. You can edit
everything in the sidebar instead, but this is the file to change if you want different defaults
for everyone. After editing it, press **Reset to defaults** in the Terrain tab.

```jsonc
{
  "version": 5,                       // raise this when you add types or kinds, so browsers with
                                      // saved edits pick up the new entries automatically

  "continents": [                     // kinds a continental point can be
    { "id": "water", "name": "Water", "color": "#3a7bd5", "odds": 0.3 }
  ],

  "climates": [                       // listed from the equator to the poles
    {
      "id": "arid", "name": "Arid", "color": "#d9b26f",
      "kinds": { "desert": 4 },        // spawn odds × for continental kinds
      "types": { "dunes": 3, "glacier": 0 }   // weight × for terrain types (0 = never)
    }
  ],

  "types": [
    {
      "id": "village",                 // used in references; letters, numbers and _
      "name": "Village",               // shown in the interface
      "color": "#8b5a2b",              // any CSS colour ("brown" works too)
      "continent": "land",             // optional: favoured near points of this kind
      "pattern": "houses",             // optional: texture (see the list below)
      "height": 0.4,                   // optional: 3D height, 0 = sea level, below 0 = underwater
      "weight": 0.05,                  // how likely it is to be picked (relative)
      "neighbors": ["sand", "grass", "village", "forest", "farmland"],
      "weightNear": { "village": 0.7 } // optional: weight to use instead when next to these types
    }
  ]
}
```

Rules worth knowing:

- **Neighbours only need to be listed on one side.** If `village` lists `sand`, the pair is
  allowed both ways. Include a type's own id if it may sit next to itself.
- **`weightNear`** replaces `weight` when a matching neighbour is already settled; if several
  match, the highest wins. This is how villages grow into towns instead of staying single cells.
- **Up to 32 terrain types.**
- **Texture names:** `waves`, `ripples`, `coral`, `stipple`, `tufts`, `flowers`, `hills`, `rows`,
  `houses`, `trees`, `pines`, `palms`, `peaks`, `sparkle`, `dunes`, `strata`, `dashes`, `cracks`,
  `reeds`.
- **Keep rules tree-shaped.** Rules shaped like a chain or tree (deep water → water → sand →
  grass → forest → mountain, with extra types branching off one parent) never contradict
  themselves. Rules with loops (say, swamp touching both water and grass, while sand also sits
  between them) can box a cell in. The generator recovers by undoing and re-filling nearby cells,
  but very loopy rules make generation slow, or make it give up with a message.

## Adding presets

Presets live in `presets.js`. Each one is a name, a description, generation settings, and a few
changes applied on top of `tiles.json`: which types to keep, weights, "next to" boosts, and
continental odds. Copy an existing preset and adjust it. The comment at the top of the file lists
every option.

## Project files

| File | What it does |
|---|---|
| `index.html` | The page and its controls |
| `style.css` | Look and layout |
| `main.js` | Ties everything together: settings, drawing, brush, presets, saving |
| `wfc.js` | The generator itself: rules, propagation, backtracking and repair, continents, climate, cleanup, brush painting |
| `editor.js` | Sidebar editors for terrain types, continental kinds and climate zones |
| `patterns.js` | Texture icons |
| `presets.js` | Ready-made worlds |
| `view3d.js` | 3D landscape and globe (three.js, loaded on first use) |
| `svgexport.js` | SVG export (Delaunator, loaded on first use) |
| `tiles.json` | Default terrain types, continental kinds and climate zones |
| `start.bat` | Windows launcher |

## Troubleshooting

- **"Couldn't load tiles.json"**: the page was opened from disk. Start a server as described in
  [Running it](#running-it).
- **The 3D view or SVG export shows a download error**: you're offline, or something is blocking
  cdn.jsdelivr.net. Connect once; the browser caches the files afterwards.
- **"Address already in use" when starting the server**: port 8123 is taken (maybe by a server
  that's still running). Close that, or use another port such as
  `python -m http.server 8124` and open <http://localhost:8124>.
- **Your edits seem to be gone, or you want a clean start**: edits are saved per browser and per
  address (localhost:8123 and localhost:8124 count as separate sites). **Reset to defaults** in
  the Terrain tab, or picking a preset, starts fresh.
- **Generation gives up with a message about contradictions**: your neighbour rules contain
  loops. Switch to *Fewest options first* in the Generator tab, which copes better with strict
  rules, or simplify the rules (see *Keep rules tree-shaped* above).
