// Step 1: Threads 1 / 2 / 4 at movetime=3s, Hash=64.
// Expect: Threads > 1 crashes (Aborted in wasm-function[533]).
import { runSearch } from './_shared.mjs';

const results = [];
for (const threads of [1, 2, 4]) {
  console.log(`\n=== Threads=${threads} ===`);
  try {
    const r = await runSearch({ threads, hashMB: 64, movetime: 3000 });
    console.log(r);
    results.push(r);
  } catch (e) {
    console.log(`CRASHED Threads=${threads}:`, e.message);
    results.push({ threads, crashed: true });
  }
}
console.log('\n=== SUMMARY ===');
console.table(results);
process.exit(0);
