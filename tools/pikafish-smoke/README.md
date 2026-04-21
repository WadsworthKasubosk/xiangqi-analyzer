# pikafish smoke tests

Node-side harnesses that exercise the pikafish WASM engine directly (without
loading the extension in Chrome). Use these to measure engine behavior before
changing `offscreen.js` `ENGINES[pikafish]` params.

## Setup

These tests need the **upstream** (unpatched) `pikafish.js`. `engine/pikafish.js`
in this repo is patched for the browser (uses `self.addEventListener`, which
Node worker_threads doesn't have) and will throw on load under Node.

Drop the upstream distribution files into `./upstream/`:

```
tools/pikafish-smoke/upstream/
  pikafish.js          # from the official pikafish-wasm-dist tarball
  pikafish.wasm
  pikafish.worker.js
  pikafish.nnue        # can symlink from ../../engine/pikafish.nnue
```

The `./upstream/` dir is gitignored (WASM/NNUE are large binaries).

## Running

```bash
cd tools/pikafish-smoke
node step1-threads.mjs   # Threads 1/2/4 at movetime=3s
node step2-movetime.mjs  # Threads=1, movetime 2s/3s/4s/5s
node step3-hash.mjs      # Threads=1, movetime=3s, Hash 64/128/256/512 MB
```

Each prints a `console.table` summary at the end. Use the numbers to justify
any change to the pikafish spec in `offscreen.js`.

## Baseline findings (2026-04)

On the mid-game FEN `r1bakab1r/9/1cn4cn/p3p3p/2p3p2/9/P1P1P1P1P/1CN1C1N2/9/R1BAKABR1 w - - 8 5`:

- **Threads > 1 crashes** (`wasm-function[533] Aborted`). This WASM build does
  not support multi-threaded search.
- **depth saturates at 15** past movetime=3s — extra time only adds nodes, not
  plies. Score stabilizes around `cp 100`.
- **Hash 64/128/256 give identical results** (hashfull only reaches 9‰ in 3s).
  Hash=512 regresses to depth 14 due to allocation overhead.

Current spec: `Threads=1 / movetime=3000 / Hash=128 / MultiPV=3`.

The `Aborted()` that sometimes prints after `bestmove` is a **teardown crash**
during engine-module shutdown in Node — the bestmove has already been emitted
and is valid. In the browser the module stays alive across moves, so this path
is never taken.
