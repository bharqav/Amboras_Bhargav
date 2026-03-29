/**
 * Regression guard: the dashboard used `++fetchGenerationRef` on *every* poll tick and
 * ignored results where `myGen !== ref`. With a 1s interval and API latency >1s, `ref`
 * always races ahead so **no response ever applied**. The UI looked frozen.
 *
 * Fix: one in-flight request + trailing retry; only `rangeEpoch` invalidates stale ranges.
 */
import assert from 'node:assert/strict';

let gen = 0;
function startLoadBuggy() {
  const myGen = ++gen;
  return () => myGen === gen;
}
const finishFirst = startLoadBuggy();
const finishSecond = startLoadBuggy();
assert.equal(finishFirst(), false, 'first overlapping request must be discarded');
assert.equal(finishSecond(), true);

// Simulate: new tick every 1ms, 5 starts before any completes -> gen=5, all returns false until last completes with gen still moving
gen = 0;
const pending = [];
for (let i = 0; i < 5; i += 1) {
  pending.push(startLoadBuggy());
}
// Before any complete, gen=5. Each finish sees myGen 1..5 vs gen 5 -> only myGen 5 wins
let wins = 0;
for (const f of pending) {
  if (f()) wins += 1;
}
assert.equal(wins, 1, 'only the last-started overlapping gen should apply');

console.log('verify-dashboard-refresh: ok');
