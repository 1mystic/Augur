<p align="center"><img src="docs/banner.svg" alt="augur" width="100%"></p>

# augur

paste a screenshot of a chessboard → the position is read locally in under a second → keep playing it move by move for either side → ask stockfish for the top 3 moves whenever you want.

no API keys, no server, works offline. web app (installable PWA) + native desktop app (macOS / Ubuntu / any Linux) from the same code.

```
screenshot ──► board detector ──► 64 tiles ──► tiny CNN (≈400 KB) ──► FEN ──► chess.js ◄──► you
               (grid-line runs)                 pure JS, no deps                  │
                                                                                  ▼
                                                              stockfish 19 lite (wasm, 1.8 MB, MultiPV 3)
```

<p align="center"><img src="docs/flow.svg" alt="pipeline" width="100%"></p>

## what it does

| | |
|---|---|
| **scan** | `Ctrl/⌘+V` a screenshot (chess.com, lichess, apps, video frames), drop a file, or click *paste*. full-window screenshots are fine — it finds the board itself. |
| **or: AI chat** | no screenshot model wanted? *"or read it with any AI chat"* gives a copy-paste prompt for Gemini/ChatGPT/Claude; paste its reply back (JSON, FEN, or the whole message) and it loads. pasting a FEN anywhere also works. |
| **fix** | low-confidence squares get an amber ring. drag the crop box on the preview to re-read, or hit `E` to edit (piece palette, right-click to erase, drag to move). |
| **setup** | *seen from* (auto-guessed), *to move* (defaults to the side at the bottom), castling rights (auto-sanitised from king/rook squares), FEN in/out. |
| **play** | one box, moves alternate: it shows whose turn it is (white/black tag), you type white's move, then black's, etc. — or drag/click on the board. `e4`, `Nf3`, `exd5`, `O-O`, `e7e8q`, `e2e4` all work. `←/→` step back/forward; playing from an earlier move branches. |
| **rebuild old games** | paste a whole move list (`1. e4 e5 2. Nf3 …`) or a full PGN (headers, comments, variations are stripped; `[FEN]` honoured) — it replays all moves and stops at the first illegal one. a bare list without move numbers continues from the current position. |
| **suggest** | `Space` (also inside the empty move box) → top 3 lines with eval, depth, PV, numbered arrows. type `1`/`2`/`3` + Enter in the move box (or click the line) to play it. *auto* re-analyses after every move. think time 0.5–3 s. multi-threaded engine when the page is cross-origin isolated (native app, dev server), single-thread otherwise. |

## run it

```bash
cd app
npm install
npm run dev          # web: http://localhost:5173
npm run build        # static site in app/dist — host anywhere (github pages, netlify, …)
```

the built site is a PWA: open it in chrome/edge → *install app*. after first load everything (engine + model) is cached and it works offline.

### native desktop (Tauri — small installers, system webview)

```bash
# one-time: rust (https://rustup.rs) and, on ubuntu/debian:
sudo apt install libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
cd app
npm run app:dev      # dev window
npm run app:build    # → src-tauri/target/release/bundle/{deb,appimage,dmg,macos}
```

macOS builds need a mac (or use CI). `.github/workflows/desktop.yml` builds `.dmg` (Apple Silicon + Intel), `.deb` and `.AppImage` on every `v*` tag and attaches them to a draft release.

native adds one thing over the web build: clipboard images are read through the OS (`arboard`), because WebKit webviews don't always hand pasted images to JS.

## accuracy / speed (this build)

| test set | squares | perfect boards | board found | orientation | median time |
|---|---|---|---|---|---|
| `firi` piece set — **never seen in training** | 100% | 16/16 | 16/16 | 16/16 | ~0.65 s |
| small boards (240–320 px) in 1080p screenshots | 100% | 12/12 | 12/12 | 12/12 | ~0.6 s |
| tile-level held-out val (hard augmentations) | 95.5% | — | — | — | — |

full-screenshot tests are synthetic (UI bars, highlights, coords, jpeg). real chess.com piece styles aren't open-licence so they're not in training — if a set misreads, amber rings show which squares to fix, and the AI-chat route is always there.

## the vision model

trained from scratch — see `train/`.

- **data**: 160k synthetic 32×32 tiles rendered from 33 open lichess piece sets on ~20 real board themes + random pastel/dark themes. each tile is cut from a 3×3 neighbourhood so crops bleed like real ones, with last-move highlights, check glow, coordinates, move dots, capture rings, arrows, wood/noise textures, blur, JPEG artifacts, brightness jitter, crop jitter.
- **model**: 3× (conv3×3 → relu → maxpool) + dense 96 + dense 13. ~110k params, float32 blob ≈ 400 KB. forward pass is ~60 lines of plain JS (`src/vision/classify.js`).
- **board detection** (`src/vision/detect.js`): every internal grid line of a checkerboard is one unbroken colour edge exactly the board's height. find columns/rows with long edge runs, group by run span, keep the group whose spacing = span/8. no ML needed, ~50 ms.

retrain:

```bash
cd train
pip install jax optax cairosvg pillow numpy chess
python gen.py 80000 11 data/tr1.npz            # tiles (any number of shards)
python gen.py 6000 99 data/val.npz alpha,staunty
python train.py data/tr1.npz data/val.npz 8 data/augur
cp data/augur.bin data/augur.json ../app/public/model/
python make_tests.py ../tests/shots 24 alpha,staunty,leipzig   # full screenshots + truth.json
```

## layout

```
app/
  index.html, src/main.js     UI + state (history, branching, setup)
  src/board.js                board: drag/click, legal dots, arrows, edit mode, promotion
  src/engine.js               stockfish worker wrapper, MultiPV 3, stop/restart queue
  src/vision/                 detector + CNN
  public/engine/              stockfish-19-lite-single.{js,wasm}
  public/model/               augur.{bin,json}
  src-tauri/                  native shell (rust)
train/                        data generator, trainer, test-screenshot maker
tests/                        e2e accuracy/timing script
```

## licences

GPL-3.0-or-later (because it ships Stockfish, GPLv3). piece images: cburnett, CC BY-SA 3.0. training piece sets from lichess (each set has its own licence — they're used only as training data, not shipped).
