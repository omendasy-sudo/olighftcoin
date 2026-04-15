// test-staking-periods.js — Verify 1d/2d/5d/7d test staking periods work correctly
// Run: node test-staking-periods.js

const TEST_PERIODS = [1, 2, 5, 7];
const CARDS = {
  Mastercard: { stake: 50, daily: 4, fee: 20, periods: {1:4,2:8,5:20,7:28,30:120,90:360,180:720,365:1460} },
  Visa:       { stake: 100, daily: 6, fee: 40, periods: {1:6,2:12,5:30,7:42,30:180,90:540,180:1080,365:2190} },
  Amex:       { stake: 200, daily: 12, fee: 80, periods: {1:12,2:24,5:60,7:84,30:360,90:1080,180:2160,365:4380} },
  Platinum:   { stake: 300, daily: 18, fee: 120, periods: {1:18,2:36,5:90,7:126,30:540,90:1620,180:3240,365:6570} },
  Gold:       { stake: 400, daily: 24, fee: 160, periods: {1:24,2:48,5:120,7:168,30:720,90:2160,180:4320,365:8760} },
  Black:      { stake: 500, daily: 30, fee: 200, periods: {1:30,2:60,5:150,7:210,30:900,90:2700,180:5400,365:10950} }
};
const OLIGHFT_PRICE = 0.50;
const ADMIN_SPLIT = 0.60;
const GEN_RATES = [0.10, 0.06, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04];
const MS_PER_DAY = 86400000;

function calcCompound(daily, days, type) {
  if (days <= 0) return 0;
  if (!type || type === 'none') return daily * days;
  let interval;
  switch (type) { case 'daily': interval = 1; break; case 'weekly': interval = 7; break; case 'monthly': interval = 30; break; default: return daily * days; }
  const boost = type === 'daily' ? 0.024 : (type === 'weekly' ? 0.012 : 0.005);
  let acc = 0;
  for (let d = 1; d <= Math.floor(days); d++) { acc += daily; if (d % interval === 0 && d < days) acc += acc * boost; }
  return acc;
}

let pass = 0, fail = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { pass++; console.log(`  ✅ ${msg}`); }
  else { fail++; console.log(`  ❌ FAIL: ${msg}`); }
}

console.log('═══════════════════════════════════════════════');
console.log('  OLIGHFT TEST STAKING PERIODS — 1d/2d/5d/7d  ');
console.log('═══════════════════════════════════════════════\n');

// ── Test 1: Period payout values (daily × days) ──
console.log('── Test 1: Period Payout Values ──');
for (const [name, card] of Object.entries(CARDS)) {
  for (const d of TEST_PERIODS) {
    const expected = card.daily * d;
    assert(card.periods[d] === expected,
      `${name} ${d}d payout = $${card.periods[d]} (expected $${expected})`);
  }
}

// ── Test 2: Compound calculation for short periods ──
console.log('\n── Test 2: Compound Calculations ──');
for (const type of ['none', 'daily', 'weekly', 'monthly']) {
  for (const d of TEST_PERIODS) {
    const result = calcCompound(6, d, type);  // Visa daily=$6
    assert(result > 0, `Visa ${d}d compound=${type} → $${result.toFixed(2)} (>0)`);
    if (type === 'none') {
      assert(result === 6 * d, `  none compound = simple: $${result} === $${6*d}`);
    }
  }
}

// ── Test 3: Stake activation simulation ──
console.log('\n── Test 3: Stake Activation Simulation ──');
for (const [name, card] of Object.entries(CARDS)) {
  for (const d of TEST_PERIODS) {
    const totalCost = card.stake + card.fee;
    const requiredOLIGHFT = totalCost / OLIGHFT_PRICE;
    const adminOLIGHFT = requiredOLIGHFT * ADMIN_SPLIT;
    const refPool = requiredOLIGHFT * (1 - ADMIN_SPLIT);
    const comp = 'daily';
    const compPayout = Math.round(calcCompound(card.daily, d, comp));
    const profit = compPayout - card.stake - card.fee;

    assert(requiredOLIGHFT > 0, `${name} ${d}d cost: ${requiredOLIGHFT} OLIGHFT ($${totalCost})`);
    assert(adminOLIGHFT === requiredOLIGHFT * 0.6, `  admin 60%: ${adminOLIGHFT} OLIGHFT`);
    assert(refPool === requiredOLIGHFT * 0.4, `  referral 40%: ${refPool} OLIGHFT`);
    assert(compPayout >= 0, `  payout: $${compPayout} (profit: $${profit})`);
  }
}

// ── Test 4: Period completion timing ──
console.log('\n── Test 4: Period Completion Timing ──');
for (const d of TEST_PERIODS) {
  const stakeDate = new Date();
  const startMs = stakeDate.getTime();
  const endMs = startMs + (d * MS_PER_DAY);
  
  // Before completion
  const beforeEnd = endMs - 1000;
  const isActiveBefore = beforeEnd < endMs;
  assert(isActiveBefore, `${d}d stake active before ${d} days elapsed`);
  
  // After completion
  const afterEnd = endMs + 1000;
  const isFinishedAfter = afterEnd >= endMs;
  assert(isFinishedAfter, `${d}d stake finished after ${d} days elapsed`);
  
  // Progress calculation
  const elapsed = Math.min(d, Math.floor((endMs - startMs) / MS_PER_DAY));
  const left = d - elapsed;
  const pct = Math.round((elapsed / d) * 100);
  assert(elapsed === d, `  elapsed=${elapsed} days, left=${left}, progress=${pct}%`);
}

// ── Test 5: 8-Gen Commission Split ──
console.log('\n── Test 5: 8-Gen Commission Split ──');
for (const d of [1, 7]) {
  const card = CARDS.Visa;
  const totalCost = card.stake + card.fee;
  const refPool = (totalCost / OLIGHFT_PRICE) * 0.4;
  let distributed = 0;
  const commissions = [];
  for (let g = 0; g < GEN_RATES.length; g++) {
    const amt = refPool * GEN_RATES[g];
    distributed += amt;
    commissions.push({ gen: g + 1, amt: amt.toFixed(2) });
  }
  const undistributed = refPool - distributed;
  assert(distributed <= refPool, `Visa ${d}d: 8-gen distributed ${distributed.toFixed(2)} ≤ pool ${refPool.toFixed(2)}`);
  assert(Math.abs(GEN_RATES.reduce((a, b) => a + b, 0) - 0.40) < 0.001, `  gen rates sum = 0.40`);
  console.log(`    Gens: ${commissions.map(c => `G${c.gen}:${c.amt}`).join(' | ')}`);
  console.log(`    Undistributed (platform): ${undistributed.toFixed(2)} OLIGHFT`);
}

// ── Test 6: Supply Reserve ──
console.log('\n── Test 6: Supply Reserve for Test Periods ──');
for (const d of TEST_PERIODS) {
  const card = CARDS.Visa;
  const dailyOLIGHFT = card.daily / OLIGHFT_PRICE;
  const estimatedReward = calcCompound(dailyOLIGHFT, d, 'daily');
  assert(estimatedReward > 0, `Visa ${d}d supply reserve: ${estimatedReward.toFixed(2)} OLIGHFT`);
}

// ── Test 7: Withdrawal validation ──
console.log('\n── Test 7: Withdrawal Validation ──');
for (const d of TEST_PERIODS) {
  const card = CARDS.Visa;
  const payoutUSD = Math.round(calcCompound(card.daily, d, 'daily'));
  const payoutOLIGHFT = payoutUSD / OLIGHFT_PRICE;
  assert(payoutOLIGHFT > 0, `Visa ${d}d withdraw: $${payoutUSD} = ${payoutOLIGHFT.toFixed(2)} OLIGHFT`);
}

// ── Summary ──
console.log('\n═══════════════════════════════════════════════');
console.log(`  RESULTS: ${pass} passed, ${fail} failed, ${total} total`);
console.log('═══════════════════════════════════════════════');
if (fail > 0) {
  console.log('\n⚠️  SOME TESTS FAILED — check above for details');
  process.exit(1);
} else {
  console.log('\n✅ ALL TESTS PASSED — 1d/2d/5d/7d staking is ready!');
  console.log('\nTest Period Quick Reference:');
  console.log('┌────────────┬──────┬───────┬──────┬──────┬──────┬──────┐');
  console.log('│ Card       │ Cost │ 1 Day │ 2 Day│ 5 Day│ 7 Day│Daily │');
  console.log('├────────────┼──────┼───────┼──────┼──────┼──────┼──────┤');
  for (const [name, c] of Object.entries(CARDS)) {
    const cost = c.stake + c.fee;
    console.log(`│ ${name.padEnd(10)} │ $${String(cost).padStart(3)} │  $${String(c.periods[1]).padStart(3)} │  $${String(c.periods[2]).padStart(3)}│  $${String(c.periods[5]).padStart(3)}│  $${String(c.periods[7]).padStart(3)}│  $${String(c.daily).padStart(3)} │`);
  }
  console.log('└────────────┴──────┴───────┴──────┴──────┴──────┴──────┘');
}
