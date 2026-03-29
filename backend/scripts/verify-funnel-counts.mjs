import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sampleFunnelCounts, multisetFromCounts } = require('./funnel-counts.js');

for (let i = 0; i < 500; i += 1) {
  const t = 200 + Math.floor(Math.random() * 50_000);
  const c = sampleFunnelCounts(t);
  const sum = c.page_view + c.add_to_cart + c.checkout_started + c.remove_from_cart + c.purchase;
  assert.equal(sum, t, 'counts must sum to total');
  assert.ok(c.page_view > c.add_to_cart * 1.35, 'page views should dominate add-to-cart');
  assert.ok(c.add_to_cart >= c.checkout_started, 'add_to_cart >= checkout_started');
  assert.ok(c.checkout_started >= c.remove_from_cart, 'checkout_started >= remove_from_cart');
  assert.ok(c.remove_from_cart > c.purchase, 'removals should exceed purchases');
}

const bag = multisetFromCounts(sampleFunnelCounts(5000));
assert.equal(bag.length, 5000);
const freq = bag.reduce((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
assert.equal(
  freq.page_view + freq.add_to_cart + freq.checkout_started + freq.remove_from_cart + freq.purchase,
  5000,
);

console.log('verify-funnel-counts: ok');
