/**
 * Funnel totals with exact sum = total and ordering:
 *   page_view >> add_to_cart > checkout_started >= remove_from_cart > purchase
 */

function sampleFunnelCounts(total) {
  const t = Math.max(200, Math.floor(total));

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pvCore = Math.floor(t * (0.48 + Math.random() * 0.06));
    const atc = Math.max(
      40,
      Math.floor(pvCore * (0.14 + Math.random() * 0.1)),
    );
    const co = Math.max(15, Math.floor(atc * (0.22 + Math.random() * 0.22)));
    const rm = Math.max(8, Math.min(Math.floor(co * (0.38 + Math.random() * 0.42)), co));
    const purCap = Math.max(1, rm - 1);
    const pur = Math.max(1, Math.min(Math.floor(rm * (0.12 + Math.random() * 0.22)), purCap));

    const fixed = atc + co + rm + pur;
    const pv = t - fixed;
    if (pv <= atc * 1.35) {
      continue;
    }

    return {
      page_view: pv,
      add_to_cart: atc,
      checkout_started: co,
      remove_from_cart: rm,
      purchase: pur,
    };
  }

  throw new Error('sampleFunnelCounts: could not satisfy funnel constraints; increase total');
}

function multisetFromCounts(counts) {
  const out = [];
  for (let i = 0; i < counts.page_view; i += 1) out.push('page_view');
  for (let i = 0; i < counts.add_to_cart; i += 1) out.push('add_to_cart');
  for (let i = 0; i < counts.checkout_started; i += 1) out.push('checkout_started');
  for (let i = 0; i < counts.remove_from_cart; i += 1) out.push('remove_from_cart');
  for (let i = 0; i < counts.purchase; i += 1) out.push('purchase');
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { sampleFunnelCounts, multisetFromCounts };
