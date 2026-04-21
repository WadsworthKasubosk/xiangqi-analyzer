// Shared helpers for the pikafish Node smoke tests.
// Load the UPSTREAM pikafish.js from ./upstream/ (engine/pikafish.js is
// patched for the browser and is not Node-compatible).
import Pikafish from './upstream/pikafish.js';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NNUE = resolve(HERE, 'upstream/pikafish.nnue');

if (!existsSync(NNUE)) {
  console.error(`Missing ${NNUE}. See README.md for setup.`);
  process.exit(2);
}

// Mid-game FEN used as the canonical benchmark position across all smoke tests.
export const BENCH_FEN =
  'r1bakab1r/9/1cn4cn/p3p3p/2p3p2/9/P1P1P1P1P/1CN1C1N2/9/R1BAKABR1 w - - 8 5';

// Some tests trigger an "Aborted()" during teardown after bestmove is emitted.
// That's a Node-side shutdown quirk in this WASM build — bestmove is valid,
// the module just refuses to die cleanly. Swallow it so the loop continues.
process.on('uncaughtException', (e) => {
  if (!/Aborted/.test(e.message || '')) throw e;
});

export async function newEngine() {
  const module = await Pikafish({ locateFile: (p) => resolve(HERE, 'upstream', p) });
  module.FS.writeFile('pikafish.nnue', readFileSync(NNUE));
  const lines = [];
  module.addMessageListener((l) => lines.push(l));
  const wait = (pred, label, ms) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout ${label}`)), ms);
      const iv = setInterval(() => {
        const hit = lines.find(pred);
        if (hit) { clearTimeout(t); clearInterval(iv); res(hit); }
      }, 20);
    });
  return { module, lines, wait };
}

export async function runSearch({ threads, hashMB, movetime, fen = BENCH_FEN }) {
  const { module, lines, wait } = await newEngine();
  module.postMessage('uci');
  await wait((l) => l === 'uciok', 'uciok', 10_000);
  module.postMessage('setoption name EvalFile value pikafish.nnue');
  module.postMessage(`setoption name Threads value ${threads}`);
  module.postMessage(`setoption name Hash value ${hashMB}`);
  module.postMessage('isready');
  await wait((l) => l === 'readyok', 'readyok', 60_000);

  module.postMessage(`position fen ${fen}`);
  const t0 = Date.now();
  module.postMessage(`go movetime ${movetime}`);
  const bestmove = await wait((l) => l.startsWith('bestmove'), 'bestmove', movetime + 10_000);
  const elapsed = Date.now() - t0;

  const infos = lines.filter((l) => l.startsWith('info depth'));
  const last = infos[infos.length - 1] || '';
  const pick = (re) => (last.match(re) || [])[1];
  const score = last.match(/score (cp|mate) (-?\d+)/);

  return {
    threads,
    hashMB,
    movetime,
    elapsed_ms: elapsed,
    depth: +(pick(/depth (\d+)/) || 0),
    seldepth: +(pick(/seldepth (\d+)/) || 0),
    nodes: +(pick(/nodes (\d+)/) || 0),
    nps: +(pick(/nps (\d+)/) || 0),
    hashfull_permille: +(pick(/hashfull (\d+)/) || 0),
    score: score ? `${score[1]} ${score[2]}` : '?',
    bestmove,
  };
}
