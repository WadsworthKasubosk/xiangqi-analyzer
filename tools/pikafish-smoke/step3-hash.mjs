// Step 3: Threads=1, movetime=3s, Hash 64 / 128 / 256 / 512 MB.
// Expect: 64/128/256 identical; 512 regresses (allocation overhead).
import { runSearch } from './_shared.mjs';

const results = [];
for (const hashMB of [64, 128, 256, 512]) {
  console.log(`\n=== Hash=${hashMB}MB ===`);
  try {
    const r = await runSearch({ threads: 1, hashMB, movetime: 3000 });
    console.log(r);
    results.push(r);
  } catch (e) {
    console.log(`CRASHED Hash=${hashMB}:`, e.message);
    results.push({ hashMB, crashed: true });
  }
}
console.log('\n=== SUMMARY ===');
console.table(results);
process.exit(0);
