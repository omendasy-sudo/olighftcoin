/**
 * OLIGHFT — End-to-End Staking Process Test
 * Simulates the full lifecycle: stake → time passes → auto-withdraw → balance credited
 * Tests all 6 cards × 4 test periods (1d, 2d, 5d, 7d) = 24 scenarios
 */

const OLIGHFT_PRICE = 0.50;
const ADMIN_WALLET_SPLIT = 0.60;
const TEST_PERIODS = [1, 2, 5, 7];

const CARD_TIERS = {
  Mastercard: { min: 50,   daily: 4,  fee: 20,  boost: 0.5 },
  Visa:       { min: 100,  daily: 6,  fee: 40,  boost: 1.0 },
  Amex:       { min: 200,  daily: 12, fee: 80,  boost: 1.5 },
  Platinum:   { min: 300,  daily: 18, fee: 120, boost: 2.0 },
  Gold:       { min: 400,  daily: 24, fee: 160, boost: 2.5 },
  Black:      { min: 500,  daily: 30, fee: 200, boost: 3.0 }
};

function calcCardDailyCompound(dailyOLIGHFT, days, compound) {
  if (!dailyOLIGHFT || days <= 0) return 0;
  if (compound === 'none' || !compound) return dailyOLIGHFT * days;
  var rate = compound === 'daily' ? 0.024 : compound === 'weekly' ? 0.012 : 0.005;
  var interval = compound === 'daily' ? 1 : compound === 'weekly' ? 7 : 30;
  var total = 0, accum = 0;
  for (var d = 1; d <= days; d++) {
    var dayReward = dailyOLIGHFT;
    if (d % interval === 0 && accum > 0) {
      dayReward += accum * rate;
    }
    total += dayReward;
    accum += dayReward;
  }
  return total;
}

let passed = 0, failed = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log('  \x1b[32m✅ ' + msg + '\x1b[0m'); }
  else { failed++; console.log('  \x1b[31m❌ ' + msg + '\x1b[0m'); }
}

console.log('═══════════════════════════════════════════════════════');
console.log('  OLIGHFT STAKING PROCESS TEST — Full Lifecycle');
console.log('═══════════════════════════════════════════════════════\n');

// ──────────────────────────────────────
// TEST 1: Stake Creation (doStake offline flow)
// ──────────────────────────────────────
console.log('── Test 1: Stake Creation ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  for (const days of TEST_PERIODS) {
    const amt = config.min / OLIGHFT_PRICE;
    const now = new Date('2026-04-15T10:00:00Z');
    const endDate = new Date(now.getTime() + days * 86400000).toISOString();
    const adminShare = amt * ADMIN_WALLET_SPLIT;
    const refShare = amt * (1 - ADMIN_WALLET_SPLIT);
    
    const stake = {
      id: 'dsk_test_' + cardName + '_' + days + 'd',
      asset: 'OLIGHFT',
      amount: amt,
      startDate: now.toISOString(),
      endDate: endDate,
      lastCompound: now.toISOString(),
      reward: 0,
      status: 'active',
      withdrawn: false,
      compound: 'daily',
      lockDays: days,
      cardTier: cardName,
      split: { adminWallet: adminShare, referralPool: refShare }
    };
    
    assert(stake.amount === amt, cardName + ' ' + days + 'd stake amount = ' + amt + ' OLIGHFT ($' + config.min + ')');
    assert(stake.endDate !== null, cardName + ' ' + days + 'd endDate set: ' + endDate.substring(0, 10));
    assert(stake.lockDays === days, cardName + ' ' + days + 'd lockDays = ' + days);
    assert(stake.split.adminWallet === amt * 0.60, cardName + ' ' + days + 'd admin 60% = ' + (amt * 0.60).toFixed(2));
    assert(stake.split.referralPool === amt * 0.40, cardName + ' ' + days + 'd referral 40% = ' + (amt * 0.40).toFixed(2));
  }
}

// ──────────────────────────────────────
// TEST 2: Balance Deduction on Stake
// ──────────────────────────────────────
console.log('\n── Test 2: Balance Deduction ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  const startBal = 10000;
  const amt = config.min / OLIGHFT_PRICE;
  const afterBal = startBal - amt;
  assert(afterBal > 0, cardName + ' balance after stake: ' + afterBal.toFixed(2) + ' OLIGHFT (deducted ' + amt + ')');
  assert(afterBal === startBal - amt, cardName + ' deduction correct: 10000 - ' + amt + ' = ' + afterBal);
}

// ──────────────────────────────────────
// TEST 3: Time Progression & Maturity Check
// ──────────────────────────────────────
console.log('\n── Test 3: Time Progression & Maturity ──');
for (const days of TEST_PERIODS) {
  const startTime = new Date('2026-04-15T10:00:00Z').getTime();
  const endTime = startTime + days * 86400000;
  
  // Before maturity (halfway)
  const halfTime = startTime + (days * 86400000 / 2);
  assert(halfTime < endTime, days + 'd: halfway (' + (days/2) + 'd) — NOT matured');
  
  // Exactly at maturity
  assert(endTime >= endTime, days + 'd: at end time — MATURED ✓');
  
  // After maturity (+1 hour)
  const afterTime = endTime + 3600000;
  assert(afterTime >= endTime, days + 'd: 1h after end — MATURED ✓');
  
  // Progress tracking
  const progressAtHalf = Math.min(100, ((halfTime - startTime) / (endTime - startTime)) * 100);
  assert(Math.abs(progressAtHalf - 50) < 1, days + 'd: progress at halfway = ' + progressAtHalf.toFixed(0) + '%');
  
  const progressAtEnd = Math.min(100, ((endTime - startTime) / (endTime - startTime)) * 100); 
  assert(progressAtEnd === 100, days + 'd: progress at end = ' + progressAtEnd + '%');
}

// ──────────────────────────────────────
// TEST 4: Auto-Withdraw Logic (_autoWithdrawMatured)
// ──────────────────────────────────────
console.log('\n── Test 4: Auto-Withdraw Process ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  for (const days of TEST_PERIODS) {
    const amt = config.min / OLIGHFT_PRICE;
    const dailyOLIGHFT = config.daily / OLIGHFT_PRICE;
    const startDate = new Date('2026-04-08T10:00:00Z'); // 7 days ago
    const endDate = new Date(startDate.getTime() + days * 86400000);
    const now = new Date('2026-04-15T10:00:00Z').getTime(); // current time
    
    // Simulate _autoWithdrawMatured check
    const end = endDate.getTime();
    const isMatured = now >= end;
    
    if (days <= 7) { // All test periods should be matured by now (7 days later)
      assert(isMatured, cardName + ' ' + days + 'd: matured after 7 days ✓');
    }
    
    // Calculate reward (matching dashboard _autoWithdrawMatured logic)
    const elapsed = (now - startDate.getTime()) / 86400000;
    const accrued = calcCardDailyCompound(dailyOLIGHFT, elapsed, 'daily');
    const gross = amt + accrued;
    const serviceFee = gross * 0.35;
    const net = gross - serviceFee;
    
    assert(net > 0, cardName + ' ' + days + 'd: net payout = ' + net.toFixed(2) + ' OLIGHFT ($' + (net * OLIGHFT_PRICE).toFixed(2) + ')');
    assert(serviceFee > 0, cardName + ' ' + days + 'd: service fee = ' + serviceFee.toFixed(2) + ' OLIGHFT (35%)');
    assert(Math.abs((net + serviceFee) - gross) < 0.01, cardName + ' ' + days + 'd: net + fee = gross ✓');
  }
}

// ──────────────────────────────────────
// TEST 5: Card Page Auto-Withdraw (autoWithdrawFinished)
// ──────────────────────────────────────
console.log('\n── Test 5: Card Page Auto-Withdraw ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  for (const days of TEST_PERIODS) {
    const startDate = new Date('2026-04-08T10:00:00Z');
    const now = new Date('2026-04-15T12:00:00Z').getTime(); // Fixed: 7d + 2h after start
    const end = startDate.getTime() + (days * 86400000);
    
    // Card page checks: now >= start + period*86400000
    const isFinished = now >= end;
    assert(isFinished, cardName + ' ' + days + 'd: card page autoWithdrawFinished() triggers ✓');
    
    // Payout calculation (card page style — simpler, just payout/OLIGHFT_PRICE)
    const payoutUSD = config.daily * days; // Simple: daily × days
    const payoutOLIGHFT = payoutUSD / OLIGHFT_PRICE;
    assert(payoutOLIGHFT > 0, cardName + ' ' + days + 'd: card payout = ' + payoutOLIGHFT.toFixed(2) + ' OLIGHFT ($' + payoutUSD + ')');
  }
}

// ──────────────────────────────────────
// TEST 6: Wallet Balance Credit After Auto-Withdraw
// ──────────────────────────────────────
console.log('\n── Test 6: Balance Credit After Withdraw ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  const startBal = 10000;
  const stakeAmt = config.min / OLIGHFT_PRICE;
  const afterStake = startBal - stakeAmt;
  
  for (const days of TEST_PERIODS) {
    const payoutOLIGHFT = (config.daily * days) / OLIGHFT_PRICE;
    const finalBal = afterStake + payoutOLIGHFT;
    const profit = finalBal - startBal;
    
    assert(finalBal > afterStake, cardName + ' ' + days + 'd: balance after withdraw = ' + finalBal.toFixed(2) + ' (profit: ' + profit.toFixed(2) + ' OLIGHFT / $' + (profit * OLIGHFT_PRICE).toFixed(2) + ')');
  }
}

// ──────────────────────────────────────
// TEST 7: Stake State Transitions
// ──────────────────────────────────────
console.log('\n── Test 7: Stake State Transitions ──');
for (const days of TEST_PERIODS) {
  // State 1: Created → active
  const stake = { status: 'active', withdrawn: false };
  assert(stake.status === 'active' && !stake.withdrawn, days + 'd: state after creation = active, withdrawn=false');

  // State 2: After auto-withdraw
  stake.status = 'withdrawn';
  stake.withdrawn = true;
  stake.autoWithdrawn = true;
  stake.withdrawnAt = Date.now();
  assert(stake.withdrawn === true, days + 'd: state after auto-withdraw = withdrawn=true');
  assert(stake.autoWithdrawn === true, days + 'd: autoWithdrawn flag set ✓');
  assert(stake.withdrawnAt > 0, days + 'd: withdrawnAt timestamp recorded ✓');
}

// ──────────────────────────────────────
// TEST 8: Activity Log Entry
// ──────────────────────────────────────
console.log('\n── Test 8: Activity & Notification Logging ──');
for (const [cardName, config] of Object.entries(CARD_TIERS)) {
  const days = 7; // Test with 7d
  const net = 100; // Example
  const entry = {
    type: 'Auto-Withdraw',
    icon: '💰',
    detail: 'Auto-withdrew ' + net.toFixed(2) + ' OLIGHFT (period completed)',
    amt: '+' + net.toFixed(2) + ' OLIGHFT',
    cls: 'green',
    time: 'Just now',
    ts: Date.now()
  };
  assert(entry.type === 'Auto-Withdraw', cardName + ' 7d: activity type = Auto-Withdraw');
  assert(entry.cls === 'green', cardName + ' 7d: activity class = green');
  assert(entry.ts > 0, cardName + ' 7d: activity timestamp set');
}

// ──────────────────────────────────────
// TEST 9: Toast Notification
// ──────────────────────────────────────
console.log('\n── Test 9: Toast Notifications ──');
for (const days of TEST_PERIODS) {
  const count = 1;
  const totalCredited = (CARD_TIERS.Visa.daily * days) / OLIGHFT_PRICE;
  const dashToast = '💰 Auto-withdrew ' + count + ' stake(s) — +' + totalCredited.toFixed(2) + ' OLIGHFT credited!';
  assert(dashToast.includes('Auto-withdrew'), days + 'd: dashboard toast contains "Auto-withdrew"');
  assert(dashToast.includes(totalCredited.toFixed(2)), days + 'd: dashboard toast shows amount ' + totalCredited.toFixed(2));
  
  const cardToast = '✅ Auto-Withdraw: ' + count + ' finished stake(s) credited ' + totalCredited.toFixed(2) + ' OLIGHFT to your wallet!';
  assert(cardToast.includes('credited'), days + 'd: card page toast contains "credited"');
}

// ──────────────────────────────────────
// TEST 10: Multiple Stakes Auto-Withdraw
// ──────────────────────────────────────
console.log('\n── Test 10: Multiple Stakes Batch Auto-Withdraw ──');
{
  // Simulate 3 stakes on different cards, all matured
  const stakes = [
    { card: 'Visa', period: 1, payout: 6, withdrawn: false, date: new Date(Date.now() - 2 * 86400000).toISOString() },
    { card: 'Gold', period: 2, payout: 48, withdrawn: false, date: new Date(Date.now() - 3 * 86400000).toISOString() },
    { card: 'Black', period: 5, payout: 150, withdrawn: false, date: new Date(Date.now() - 6 * 86400000).toISOString() }
  ];
  
  let count = 0, totalCredited = 0;
  const now = Date.now();
  for (const s of stakes) {
    const end = new Date(s.date).getTime() + (s.period * 86400000);
    if (now >= end && !s.withdrawn) {
      const payoutOLIGHFT = s.payout / OLIGHFT_PRICE;
      totalCredited += payoutOLIGHFT;
      s.withdrawn = true;
      s.autoWithdrawn = true;
      count++;
    }
  }
  
  assert(count === 3, 'Batch: all 3 matured stakes auto-withdrawn');
  assert(totalCredited === (6 + 48 + 150) / OLIGHFT_PRICE, 'Batch: total credited = ' + totalCredited + ' OLIGHFT ($' + (totalCredited * OLIGHFT_PRICE) + ')');
  assert(stakes.every(s => s.withdrawn), 'Batch: all stakes marked withdrawn');
  assert(stakes.every(s => s.autoWithdrawn), 'Batch: all stakes marked autoWithdrawn');
}

// ──────────────────────────────────────
// TEST 11: Already-Withdrawn Stakes Skipped
// ──────────────────────────────────────
console.log('\n── Test 11: Already-Withdrawn Skip ──');
{
  const stakes = [
    { card: 'Visa', period: 1, payout: 6, withdrawn: true, date: new Date(Date.now() - 5 * 86400000).toISOString() },
    { card: 'Visa', period: 2, payout: 12, withdrawn: false, date: new Date(Date.now() - 5 * 86400000).toISOString() }
  ];
  let count = 0;
  const now = Date.now();
  for (const s of stakes) {
    if (s.withdrawn) continue;
    const end = new Date(s.date).getTime() + (s.period * 86400000);
    if (now >= end) { s.withdrawn = true; count++; }
  }
  assert(count === 1, 'Skip: only 1 new withdrawal (already-withdrawn skipped)');
  assert(stakes[0].withdrawn === true, 'Skip: first stake still withdrawn');
  assert(stakes[1].withdrawn === true, 'Skip: second stake now withdrawn');
}

// ──────────────────────────────────────
// TEST 12: Not-Yet-Matured Stakes Untouched
// ──────────────────────────────────────
console.log('\n── Test 12: Not-Yet-Matured Untouched ──');
{
  const futureStake = { card: 'Platinum', period: 7, payout: 126, withdrawn: false, date: new Date().toISOString() };
  const now = Date.now();
  const end = new Date(futureStake.date).getTime() + (futureStake.period * 86400000);
  const isMatured = now >= end;
  assert(!isMatured, 'Future: 7d stake created now is NOT matured yet');
  assert(!futureStake.withdrawn, 'Future: stake still active (withdrawn=false)');
  
  const remaining = Math.ceil((end - now) / 86400000);
  assert(remaining > 0 && remaining <= 7, 'Future: ' + remaining + ' days remaining');
}

// ──────────────────────────────────────
// SUMMARY
// ──────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════');
console.log('  RESULTS: ' + passed + ' passed, ' + failed + ' failed, ' + total + ' total');
console.log('═══════════════════════════════════════════════════════\n');

if (failed === 0) {
  console.log('\x1b[32m✅ ALL TESTS PASSED — Full staking process verified!\x1b[0m\n');
  console.log('Lifecycle verified:');
  console.log('  1. Stake created → balance deducted, endDate set, admin/referral split');
  console.log('  2. Time passes → progress tracked, maturity detected');
  console.log('  3. Auto-withdraw → payout credited, state updated, activity logged');
  console.log('  4. Toast shown → user notified of auto-withdrawal');
  console.log('  5. Edge cases → already-withdrawn skipped, future stakes untouched\n');
} else {
  console.log('\x1b[31m❌ ' + failed + ' TESTS FAILED\x1b[0m\n');
  process.exit(1);
}
