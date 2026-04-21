// Step 2: Threads=1, movetime 2s/3s/4s/5s, Hash=64.
// Expect: depth 14 → 15 between 2s and 3s, then depth saturates at 15.
import { runSearch } from './_shared.mjs';

const results = [];
for (const movetime of [2000, 3000, 4000, 5000]) {
  console.log(`\n=== movetime=${movetime}ms ===`);
  try {
    const r = await runSearch({ threads: 1, hashMB: 64, movetime });
    console.log(r);
    results.push(r);
  } catch (e) {
    console.log(`CRASHED movetime=${movetime}:`, e.message);
    results.push({ movetime, crashed: true });
  }
}
console.log('\n=== SUMMARY ===');
console.table(results);
process.exit(0);
