/**
 * OLIGHFT — 8-Gen Commission 5-Min Auto-Withdraw Test Suite
 * Tests the full commission lifecycle: stake → pending → 5min delay → auto-credit
 * Simulates localStorage in Node.js environment
 *
 * Run: node test-8gen-autowithdraw.js
 */

// ── Simulated localStorage ──
const _store = {};
const localStorage = {
  getItem(k) { return _store[k] || null; },
  setItem(k, v) { _store[k] = String(v); },
  removeItem(k) { delete _store[k]; },
  clear() { for (const k in _store) delete _store[k]; },
  _dump() { return Object.assign({}, _store); }
};

// ── Constants (match dashboard.html) ──
const OLIGHFT_PRICE = 0.50;
const ADMIN_WALLET_SPLIT = 0.60;
const GEN_RATES = [0.10, 0.06, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04];
const GEN_WITHDRAW_DELAY = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BALS = { XLM: 10000, USDC: 2500, wETH: 1.85, wBTC: 0.042, EURC: 1200, OLIGHFT: 10000, PI: 500, BNB: 0.5 };
const CARD_TIERS = {
  Mastercard: { min: 50,  daily: 4,  fee: 20,  boost: 0.5 },
  Visa:       { min: 100, daily: 6,  fee: 40,  boost: 1.0 },
  Amex:       { min: 200, daily: 12, fee: 80,  boost: 1.2 },
  Platinum:   { min: 300, daily: 18, fee: 120, boost: 1.5 },
  Gold:       { min: 400, daily: 24, fee: 160, boost: 2.0 },
  Black:      { min: 500, daily: 30, fee: 200, boost: 3.0 }
};

// ── Test Counters ──
let passed = 0, failed = 0, total = 0;

function assert(cond, msg) {
  total++;
  if (cond) { passed++; console.log('  \x1b[32m✅ ' + msg + '\x1b[0m'); }
  else { failed++; console.log('  \x1b[31m❌ FAIL: ' + msg + '\x1b[0m'); }
}

function assertClose(a, b, tol, msg) {
  assert(Math.abs(a - b) < (tol || 0.01), msg + ' (got ' + a.toFixed(4) + ', expected ' + b.toFixed(4) + ')');
}

// ── Minimal stubs for functions used by distribute8GenCommissions ──
let adminDeposits = [];
function depositToAdminWallet(amountOLIGHFT, source, stakeId) {
  adminDeposits.push({ amount: amountOLIGHFT, source, stakeId });
  return { amount: amountOLIGHFT, usd: amountOLIGHFT * OLIGHFT_PRICE };
}

// ── Core Functions (extracted from dashboard.html) ──

function creditSponsorBalance(sponsorName, amountOLIGHFT) {
  var balKey = 'cw_sponsor_bal_' + sponsorName.toLowerCase();
  var bal = parseFloat(localStorage.getItem(balKey) || '0');
  bal += amountOLIGHFT;
  localStorage.setItem(balKey, bal.toString());

  // Also credit sponsor's main balance if they are the current logged-in user
  var currentUser = null;
  try { currentUser = JSON.parse(localStorage.getItem('cw_user')); } catch(e) {}
  if (currentUser && currentUser.name && currentUser.name.toLowerCase() === sponsorName.toLowerCase()) {
    var bals = {};
    try { bals = Object.assign({}, DEFAULT_BALS, JSON.parse(localStorage.getItem('cw_balances'))); } catch(e) { bals = Object.assign({}, DEFAULT_BALS); }
    bals.OLIGHFT = (bals.OLIGHFT || 0) + amountOLIGHFT;
    localStorage.setItem('cw_balances', JSON.stringify(bals));
  }
}

function distribute8GenCommissions(stakerEmail, stakeAmountOLIGHFT, stakeId, cardTier) {
  var invites = [];
  try { invites = JSON.parse(localStorage.getItem('cw_invites') || '[]'); } catch(e) { return []; }
  var currentEmail = stakerEmail.toLowerCase();
  var commissions = [];

  for (var gen = 0; gen < 8; gen++) {
    var invRecord = null;
    for (var j = 0; j < invites.length; j++) {
      if (invites[j].invitee && invites[j].invitee.email &&
          invites[j].invitee.email.toLowerCase() === currentEmail) {
        invRecord = invites[j]; break;
      }
    }
    if (!invRecord || !invRecord.inviterName) break;

    var sponsorName = invRecord.inviterName;
    var rate = GEN_RATES[gen];
    var commissionOLIGHFT = stakeAmountOLIGHFT * rate;
    var commissionUSD = commissionOLIGHFT * OLIGHFT_PRICE;

    // Store as pending commission (5-min auto-withdraw delay)
    var sponsorKey = 'cw_gen_earnings_' + sponsorName.toLowerCase();
    var earnings = [];
    try { earnings = JSON.parse(localStorage.getItem(sponsorKey) || '[]'); } catch(e) { earnings = []; }
    var nowTs = Date.now();
    earnings.push({
      gen: gen + 1,
      from: currentEmail,
      amount: commissionOLIGHFT,
      usd: commissionUSD,
      stakeId: stakeId,
      cardTier: cardTier,
      ts: nowTs,
      readyAt: nowTs + GEN_WITHDRAW_DELAY,
      credited: false
    });
    localStorage.setItem(sponsorKey, JSON.stringify(earnings));

    // Store in global pending queue for auto-withdraw processing
    var pendingQ = [];
    try { pendingQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]'); } catch(e) { pendingQ = []; }
    pendingQ.push({
      sponsor: sponsorName,
      gen: gen + 1,
      amount: commissionOLIGHFT,
      usd: commissionUSD,
      stakeId: stakeId,
      cardTier: cardTier,
      from: currentEmail,
      ts: nowTs,
      readyAt: nowTs + GEN_WITHDRAW_DELAY,
      credited: false
    });
    localStorage.setItem('cw_gen_pending', JSON.stringify(pendingQ));

    commissions.push({
      gen: gen + 1,
      sponsor: sponsorName,
      amount: commissionOLIGHFT,
      usd: commissionUSD,
      rate: rate
    });

    // Walk up: find the invite where the sponsor was the invitee (to get sponsor's own inviter)
    var sponsorInv = null;
    for (var k = 0; k < invites.length; k++) {
      if (invites[k].invitee && invites[k].invitee.email) {
        var invName = (invites[k].invitee.name || '').toLowerCase();
        var invEmail = (invites[k].invitee.email || '').toLowerCase();
        if (invName === sponsorName.toLowerCase() || invEmail === sponsorName.toLowerCase()) {
          sponsorInv = invites[k]; break;
        }
      }
    }
    if (!sponsorInv || !sponsorInv.invitee || !sponsorInv.invitee.email) break;
    currentEmail = sponsorInv.invitee.email.toLowerCase();
  }

  // Undistributed gens go to admin
  if (commissions.length < 8) {
    var undist = 0;
    for (var g = commissions.length; g < 8; g++) undist += stakeAmountOLIGHFT * GEN_RATES[g];
    if (undist > 0) depositToAdminWallet(undist, 'unclaimed_gen_' + (commissions.length + 1) + '_to_8', stakeId);
  }

  // Log
  var allLogs = [];
  try { allLogs = JSON.parse(localStorage.getItem('cw_gen_commission_log') || '[]'); } catch(e) { allLogs = []; }
  allLogs.push({
    stakeId: stakeId,
    stakerEmail: stakerEmail,
    cardTier: cardTier,
    totalStaked: stakeAmountOLIGHFT,
    commissions: commissions,
    undistributed: commissions.length < 8 ? stakeAmountOLIGHFT * GEN_RATES.slice(commissions.length).reduce((a,b) => a+b, 0) : 0,
    ts: Date.now()
  });
  if (allLogs.length > 200) allLogs = allLogs.slice(-200);
  localStorage.setItem('cw_gen_commission_log', JSON.stringify(allLogs));

  return commissions;
}

function _autoWithdrawGenCommissions() {
  var now = Date.now();
  var pendingQ = [];
  try { pendingQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]'); } catch(e) { return { credited: 0, total: 0 }; }
  if (!pendingQ.length) return { credited: 0, total: 0 };

  var readyItems = [];
  var stillPending = [];
  for (var i = 0; i < pendingQ.length; i++) {
    var p = pendingQ[i];
    if (p.credited) continue; // already processed
    if (now >= (p.readyAt || 0)) {
      readyItems.push(p);
    } else {
      stillPending.push(p);
    }
  }
  if (!readyItems.length) return { credited: 0, total: 0 };

  var totalCredited = 0;
  var creditCount = 0;
  for (var j = 0; j < readyItems.length; j++) {
    var item = readyItems[j];
    creditSponsorBalance(item.sponsor, item.amount);
    item.credited = true;
    item.creditedAt = now;
    totalCredited += item.amount;
    creditCount++;

    // Mark as credited in sponsor's earnings log
    try {
      var sKey = 'cw_gen_earnings_' + item.sponsor.toLowerCase();
      var sEarnings = JSON.parse(localStorage.getItem(sKey) || '[]');
      for (var k = sEarnings.length - 1; k >= 0; k--) {
        if (sEarnings[k].stakeId === item.stakeId && sEarnings[k].gen === item.gen && !sEarnings[k].credited) {
          sEarnings[k].credited = true;
          sEarnings[k].creditedAt = now;
          break;
        }
      }
      localStorage.setItem(sKey, JSON.stringify(sEarnings));
    } catch(e) {}

    // Log activity
    try {
      var al = JSON.parse(localStorage.getItem('cw_activity') || '[]');
      al.unshift({
        type: 'Gen ' + item.gen + ' Commission',
        detail: '+' + item.amount.toFixed(2) + ' OLIGHFT',
        ts: now
      });
      if (al.length > 50) al.length = 50;
      localStorage.setItem('cw_activity', JSON.stringify(al));
    } catch(e) {}

    // Transaction notification
    try {
      var notifs = JSON.parse(localStorage.getItem('cw_tx_notifications') || '[]');
      notifs.unshift({
        type: 'Gen ' + item.gen + ' Commission',
        detail: '+' + item.amount.toFixed(2) + ' OLIGHFT',
        ts: now
      });
      if (notifs.length > 50) notifs.length = 50;
      localStorage.setItem('cw_tx_notifications', JSON.stringify(notifs));
    } catch(e) {}
  }

  // Save updated pending queue
  var updated = stillPending.concat(readyItems);
  var oneDayAgo = now - 86400000;
  updated = updated.filter(function(p) { return !p.credited || (p.creditedAt || 0) > oneDayAgo; });
  localStorage.setItem('cw_gen_pending', JSON.stringify(updated));

  return { credited: creditCount, total: totalCredited };
}

// ── Helper: build invite chain ──
function buildInviteChain(chain) {
  // chain = [{email, name, sponsor}]
  // Creates cw_invites array for sponsor chain lookup
  var invites = [];
  for (var i = 0; i < chain.length; i++) {
    if (chain[i].sponsor) {
      invites.push({
        inviterName: chain[i].sponsor,
        invitee: { email: chain[i].email, name: chain[i].name }
      });
    }
  }
  localStorage.setItem('cw_invites', JSON.stringify(invites));
  return invites;
}

// ══════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════');
console.log('  OLIGHFT 8-GEN COMMISSION AUTO-WITHDRAW TEST SUITE');
console.log('  5-Minute Pending → Credit Flow — All Functions');
console.log('═══════════════════════════════════════════════════════════\n');

// ══════════════════════════════════════════════════
// TEST 1: GEN_RATES Sum & Structure
// ══════════════════════════════════════════════════
console.log('── Test 1: GEN_RATES Constants ──');
assert(GEN_RATES.length === 8, 'GEN_RATES has 8 entries');
assertClose(GEN_RATES.reduce((a,b) => a+b, 0), 0.40, 0.001, 'GEN_RATES sum = 0.40 (40%)');
assert(GEN_RATES[0] === 0.10, 'Gen 1 rate = 10%');
assert(GEN_RATES[1] === 0.06, 'Gen 2 rate = 6%');
for (let i = 2; i < 8; i++) assert(GEN_RATES[i] === 0.04, 'Gen ' + (i+1) + ' rate = 4%');
assert(GEN_WITHDRAW_DELAY === 300000, 'GEN_WITHDRAW_DELAY = 300000ms (5 min)');
assert(ADMIN_WALLET_SPLIT === 0.60, 'ADMIN_WALLET_SPLIT = 60%');
console.log('');

// ══════════════════════════════════════════════════
// TEST 2: creditSponsorBalance()
// ══════════════════════════════════════════════════
console.log('── Test 2: creditSponsorBalance() ──');
localStorage.clear();

// 2a: Credit non-logged-in sponsor
creditSponsorBalance('Alice', 50);
let aliceBal = parseFloat(localStorage.getItem('cw_sponsor_bal_alice') || '0');
assertClose(aliceBal, 50, 0.01, 'Alice sponsor bal = 50 after first credit');

creditSponsorBalance('Alice', 25.5);
aliceBal = parseFloat(localStorage.getItem('cw_sponsor_bal_alice') || '0');
assertClose(aliceBal, 75.5, 0.01, 'Alice sponsor bal = 75.50 after second credit');

// 2b: Credit logged-in user (should also update cw_balances)
localStorage.setItem('cw_user', JSON.stringify({ name: 'Bob', email: 'bob@test.com' }));
localStorage.setItem('cw_balances', JSON.stringify({ OLIGHFT: 1000 }));
creditSponsorBalance('Bob', 100);
let bobSponsor = parseFloat(localStorage.getItem('cw_sponsor_bal_bob') || '0');
assertClose(bobSponsor, 100, 0.01, 'Bob sponsor bal = 100');
let bobBals = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(bobBals.OLIGHFT, 1100, 0.01, 'Bob main OLIGHFT bal = 1100 (1000 + 100)');

// 2c: Case insensitivity
creditSponsorBalance('BOB', 50);
bobSponsor = parseFloat(localStorage.getItem('cw_sponsor_bal_bob') || '0');
assertClose(bobSponsor, 150, 0.01, 'BOB (uppercase) credits same key → 150');

// 2d: Credit user who is not logged in (main bal should NOT change)
let aliceBals = localStorage.getItem('cw_balances');
creditSponsorBalance('Alice', 10);
assert(localStorage.getItem('cw_balances') === aliceBals || JSON.parse(localStorage.getItem('cw_balances')).OLIGHFT === JSON.parse(aliceBals).OLIGHFT,
  'Alice credit does not alter logged-in user (Bob) main balance');
console.log('');

// ══════════════════════════════════════════════════
// TEST 3: distribute8GenCommissions() — Full 8-Gen Chain
// ══════════════════════════════════════════════════
console.log('── Test 3: distribute8GenCommissions() — Full 8-Gen Chain ──');
localStorage.clear();
adminDeposits = [];

// Build a full 8-gen chain: user1 → gen1 → gen2 → ... → gen8
const chain = [
  { email: 'user1@test.com', name: 'User1', sponsor: 'Gen1' },
  { email: 'gen1@test.com',  name: 'Gen1',  sponsor: 'Gen2' },
  { email: 'gen2@test.com',  name: 'Gen2',  sponsor: 'Gen3' },
  { email: 'gen3@test.com',  name: 'Gen3',  sponsor: 'Gen4' },
  { email: 'gen4@test.com',  name: 'Gen4',  sponsor: 'Gen5' },
  { email: 'gen5@test.com',  name: 'Gen5',  sponsor: 'Gen6' },
  { email: 'gen6@test.com',  name: 'Gen6',  sponsor: 'Gen7' },
  { email: 'gen7@test.com',  name: 'Gen7',  sponsor: 'Gen8' },
  { email: 'gen8@test.com',  name: 'Gen8',  sponsor: null }
];
buildInviteChain(chain);

const stakeAmount = 200; // 200 OLIGHFT
const result = distribute8GenCommissions('user1@test.com', stakeAmount, 'stake_001', 'Visa');

assert(result.length === 8, 'Full chain distributes to all 8 generations');

// Check per-gen amounts
for (let i = 0; i < 8; i++) {
  const expected = stakeAmount * GEN_RATES[i];
  assertClose(result[i].amount, expected, 0.01,
    'Gen ' + (i+1) + ': ' + result[i].sponsor + ' gets ' + expected.toFixed(2) + ' OLIGHFT (' + (GEN_RATES[i]*100) + '%)');
}

// Total distributed = 40% of stake
const totalDistributed = result.reduce((s, c) => s + c.amount, 0);
assertClose(totalDistributed, stakeAmount * 0.40, 0.01, 'Total distributed = ' + (stakeAmount * 0.40) + ' OLIGHFT (40%)');

// No admin deposits (all 8 gens distributed)
assert(adminDeposits.length === 0, 'No admin undistributed deposit for full chain');

// Check pending queue
const pendingQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pendingQ.length === 8, 'cw_gen_pending has 8 entries');
assert(pendingQ.every(p => p.credited === false), 'All pending items have credited=false');
assert(pendingQ.every(p => p.readyAt > Date.now()), 'All pending items have future readyAt');

// Check per-sponsor earnings
for (let i = 0; i < 8; i++) {
  const sKey = 'cw_gen_earnings_gen' + (i+1);
  const sEarnings = JSON.parse(localStorage.getItem(sKey) || '[]');
  assert(sEarnings.length === 1, 'Gen' + (i+1) + ' has 1 earnings entry');
  assert(sEarnings[0].credited === false, 'Gen' + (i+1) + ' earnings not yet credited');
  assertClose(sEarnings[0].amount, stakeAmount * GEN_RATES[i], 0.01,
    'Gen' + (i+1) + ' earnings amount = ' + (stakeAmount * GEN_RATES[i]).toFixed(2));
}

// Check commission log
const logs = JSON.parse(localStorage.getItem('cw_gen_commission_log') || '[]');
assert(logs.length === 1, 'Commission log has 1 entry');
assert(logs[0].stakeId === 'stake_001', 'Log stakeId matches');
assert(logs[0].commissions.length === 8, 'Log contains 8 commissions');
console.log('');

// ══════════════════════════════════════════════════
// TEST 4: distribute8GenCommissions() — Partial Chain (3 gens)
// ══════════════════════════════════════════════════
console.log('── Test 4: Partial Chain (3 Generations) ──');
localStorage.clear();
adminDeposits = [];

const shortChain = [
  { email: 'staker@test.com', name: 'Staker', sponsor: 'Sponsor1' },
  { email: 'sp1@test.com',    name: 'Sponsor1', sponsor: 'Sponsor2' },
  { email: 'sp2@test.com',    name: 'Sponsor2', sponsor: 'Sponsor3' },
  { email: 'sp3@test.com',    name: 'Sponsor3', sponsor: null } // no further upline
];
buildInviteChain(shortChain);

const res3 = distribute8GenCommissions('staker@test.com', 500, 'stake_002', 'Gold');
assert(res3.length === 3, 'Short chain has 3 commission payouts');

// Undistributed gens 4-8 should go to admin
const expectedUndist = 500 * (0.04 * 5); // gens 4-8 at 4% each
assert(adminDeposits.length === 1, 'Admin receives 1 undistributed deposit');
assertClose(adminDeposits[0].amount, expectedUndist, 0.01,
  'Admin undistributed = ' + expectedUndist.toFixed(2) + ' OLIGHFT (gens 4-8)');

const pq3 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq3.length === 3, 'Pending queue has 3 entries for short chain');
console.log('');

// ══════════════════════════════════════════════════
// TEST 5: distribute8GenCommissions() — No Sponsor (0 gens)
// ══════════════════════════════════════════════════
console.log('── Test 5: No Sponsor (0 Generations) ──');
localStorage.clear();
adminDeposits = [];

// Staker with no invite record
localStorage.setItem('cw_invites', '[]');
const res0 = distribute8GenCommissions('orphan@test.com', 300, 'stake_003', 'Platinum');
assert(res0.length === 0, 'No sponsor → 0 commissions');

const totalUndist0 = 300 * 0.40;
assert(adminDeposits.length === 1, 'All 8 gens undistributed → admin');
assertClose(adminDeposits[0].amount, totalUndist0, 0.01,
  'Admin gets full 40% = ' + totalUndist0.toFixed(2) + ' OLIGHFT');

const pq0 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq0.length === 0, 'Pending queue empty when no sponsors');
console.log('');

// ══════════════════════════════════════════════════
// TEST 6: _autoWithdrawGenCommissions() — Before 5 Minutes
// ══════════════════════════════════════════════════
console.log('── Test 6: Auto-Withdraw Before 5 Minutes (Nothing Credited) ──');
localStorage.clear();
adminDeposits = [];

buildInviteChain([
  { email: 'alice@test.com', name: 'Alice', sponsor: 'Bob' },
  { email: 'bob@test.com',   name: 'Bob',   sponsor: null }
]);

localStorage.setItem('cw_user', JSON.stringify({ name: 'Bob', email: 'bob@test.com' }));
localStorage.setItem('cw_balances', JSON.stringify({ OLIGHFT: 5000 }));

distribute8GenCommissions('alice@test.com', 100, 'stake_t6', 'Mastercard');

// Auto-withdraw immediately (should credit nothing — 5 min not elapsed)
const aw6 = _autoWithdrawGenCommissions();
assert(aw6.credited === 0, 'No commissions credited immediately');
assert(aw6.total === 0, 'Total credited = 0');

// Bob's balance should be unchanged
let bobBal6 = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(bobBal6.OLIGHFT, 5000, 0.01, 'Bob OLIGHFT balance unchanged at 5000');

// Sponsor bal should still be 0
let bobSponsorBal6 = parseFloat(localStorage.getItem('cw_sponsor_bal_bob') || '0');
assertClose(bobSponsorBal6, 0, 0.01, 'Bob sponsor bal = 0 (not credited yet)');

// Pending queue still has 1 uncredited entry
const pq6 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq6.length === 1, 'Pending queue still has 1 entry');
assert(pq6[0].credited === false, 'Entry still pending');
console.log('');

// ══════════════════════════════════════════════════
// TEST 7: _autoWithdrawGenCommissions() — After 5 Minutes
// ══════════════════════════════════════════════════
console.log('── Test 7: Auto-Withdraw After 5 Minutes (Commission Credited) ──');
// Manipulate readyAt to simulate 5 minutes elapsed
const pq7 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
pq7.forEach(p => { p.readyAt = Date.now() - 1000; }); // 1 second in the past
localStorage.setItem('cw_gen_pending', JSON.stringify(pq7));

// Also update earnings readyAt
const bobEarnings7 = JSON.parse(localStorage.getItem('cw_gen_earnings_bob') || '[]');
bobEarnings7.forEach(e => { e.readyAt = Date.now() - 1000; });
localStorage.setItem('cw_gen_earnings_bob', JSON.stringify(bobEarnings7));

const aw7 = _autoWithdrawGenCommissions();
assert(aw7.credited === 1, 'Auto-withdraw credited 1 commission');
assertClose(aw7.total, 100 * 0.10, 0.01, 'Total credited = 10 OLIGHFT (10% of 100)');

// Bob's balance should be updated
let bobBal7 = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(bobBal7.OLIGHFT, 5010, 0.01, 'Bob OLIGHFT balance = 5010 (5000 + 10)');

// Sponsor bal credited
let bobSponsor7 = parseFloat(localStorage.getItem('cw_sponsor_bal_bob') || '0');
assertClose(bobSponsor7, 10, 0.01, 'Bob sponsor bal = 10');

// Pending queue entry marked credited
const pq7a = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq7a.length === 1, 'Pending queue still has 1 entry (marked credited)');
assert(pq7a[0].credited === true, 'Entry marked as credited');
assert(typeof pq7a[0].creditedAt === 'number', 'creditedAt timestamp set');

// Earnings log also marked credited
const bobE7 = JSON.parse(localStorage.getItem('cw_gen_earnings_bob') || '[]');
assert(bobE7[0].credited === true, 'Earnings entry marked credited');

// Activity log created
const activity7 = JSON.parse(localStorage.getItem('cw_activity') || '[]');
assert(activity7.length >= 1, 'Activity log has entry');
assert(activity7[0].type.includes('Gen 1'), 'Activity type = Gen 1 Commission');

// Notification created
const notifs7 = JSON.parse(localStorage.getItem('cw_tx_notifications') || '[]');
assert(notifs7.length >= 1, 'Notification created');
assert(notifs7[0].type.includes('Gen 1'), 'Notification type = Gen 1 Commission');
console.log('');

// ══════════════════════════════════════════════════
// TEST 8: Double-Credit Protection
// ══════════════════════════════════════════════════
console.log('── Test 8: Double-Credit Protection ──');
// Run auto-withdraw again — should not credit again
const aw8 = _autoWithdrawGenCommissions();
assert(aw8.credited === 0, 'Second auto-withdraw credits 0 (already credited)');

let bobBal8 = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(bobBal8.OLIGHFT, 5010, 0.01, 'Bob balance still 5010 (no double-credit)');
console.log('');

// ══════════════════════════════════════════════════
// TEST 9: Multi-Stake Multi-Gen Auto-Withdraw
// ══════════════════════════════════════════════════
console.log('── Test 9: Multi-Stake Multi-Gen Auto-Withdraw ──');
localStorage.clear();
adminDeposits = [];

const multiChain = [
  { email: 'staker_a@test.com', name: 'StakerA', sponsor: 'Upline1' },
  { email: 'staker_b@test.com', name: 'StakerB', sponsor: 'Upline1' },
  { email: 'up1@test.com',      name: 'Upline1', sponsor: 'Upline2' },
  { email: 'up2@test.com',      name: 'Upline2', sponsor: null }
];
buildInviteChain(multiChain);

localStorage.setItem('cw_user', JSON.stringify({ name: 'Upline1', email: 'up1@test.com' }));
localStorage.setItem('cw_balances', JSON.stringify({ OLIGHFT: 2000 }));

// StakerA stakes 200
distribute8GenCommissions('staker_a@test.com', 200, 'stake_a', 'Visa');
// StakerB stakes 300
distribute8GenCommissions('staker_b@test.com', 300, 'stake_b', 'Gold');

let pq9 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq9.length === 4, 'Pending queue has 4 entries (2 stakes × 2 gens each)');

// Make all ready
pq9.forEach(p => { p.readyAt = Date.now() - 1000; });
localStorage.setItem('cw_gen_pending', JSON.stringify(pq9));

// Also update earnings
['upline1', 'upline2'].forEach(name => {
  const k = 'cw_gen_earnings_' + name;
  const e = JSON.parse(localStorage.getItem(k) || '[]');
  e.forEach(x => { x.readyAt = Date.now() - 1000; });
  localStorage.setItem(k, JSON.stringify(e));
});

const aw9 = _autoWithdrawGenCommissions();
assert(aw9.credited === 4, 'Auto-withdraw credited 4 commissions');

// Upline1 gets Gen1 from both stakers: 200*0.10 + 300*0.10 = 50
const up1Bal = parseFloat(localStorage.getItem('cw_sponsor_bal_upline1') || '0');
assertClose(up1Bal, 50, 0.01, 'Upline1 sponsor bal = 50 (20 + 30)');

// Upline2 gets Gen2 from both: 200*0.06 + 300*0.06 = 30
const up2Bal = parseFloat(localStorage.getItem('cw_sponsor_bal_upline2') || '0');
assertClose(up2Bal, 30, 0.01, 'Upline2 sponsor bal = 30 (12 + 18)');

// Upline1 is logged in, so main balance should increase by 50
let up1Main = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(up1Main.OLIGHFT, 2050, 0.01, 'Upline1 main OLIGHFT = 2050 (2000 + 50)');

const totalAW9 = aw9.total;
assertClose(totalAW9, 80, 0.01, 'Total auto-withdrawn = 80 OLIGHFT (50 + 30)');
console.log('');

// ══════════════════════════════════════════════════
// TEST 10: Per-Card Tier Commission Amounts
// ══════════════════════════════════════════════════
console.log('── Test 10: Per-Card Tier Commission Amounts ──');
const tierNames = Object.keys(CARD_TIERS);
for (const tier of tierNames) {
  localStorage.clear();
  adminDeposits = [];
  buildInviteChain([
    { email: 'staker@test.com', name: 'Staker', sponsor: 'Spons' },
    { email: 'spons@test.com',  name: 'Spons',  sponsor: null }
  ]);

  const stakeOLIGHFT = CARD_TIERS[tier].min / OLIGHFT_PRICE;
  const refOLIGHFT = stakeOLIGHFT * (1 - ADMIN_WALLET_SPLIT); // 40% for referral
  const genRes = distribute8GenCommissions('staker@test.com', refOLIGHFT, 'stake_' + tier, tier);

  assert(genRes.length === 1, tier + ': 1 gen distributed (short chain)');
  const expectedGen1 = refOLIGHFT * 0.10;
  assertClose(genRes[0].amount, expectedGen1, 0.01,
    tier + ': Gen1 = ' + expectedGen1.toFixed(2) + ' OLIGHFT (10% of ' + refOLIGHFT.toFixed(0) + ')');

  // Admin gets undistributed gens 2-8
  const expectedAdmin = refOLIGHFT * 0.30; // 6+4+4+4+4+4+4 = 30%
  assert(adminDeposits.length === 1, tier + ': admin gets undistributed');
  assertClose(adminDeposits[0].amount, expectedAdmin, 0.01,
    tier + ': Admin = ' + expectedAdmin.toFixed(2) + ' OLIGHFT (gens 2-8 = 30%)');
}
console.log('');

// ══════════════════════════════════════════════════
// TEST 11: Pending Queue Cleanup (Old Credited Items)
// ══════════════════════════════════════════════════
console.log('── Test 11: Pending Queue Cleanup ──');
localStorage.clear();

// Manually insert old credited items + new pending + 1 ready item to trigger cleanup
const twoDaysAgo = Date.now() - 2 * 86400000;
localStorage.setItem('cw_gen_pending', JSON.stringify([
  { sponsor: 'Old1', gen: 1, amount: 5, stakeId: 'old1', credited: true, creditedAt: twoDaysAgo, readyAt: twoDaysAgo - 300000 },
  { sponsor: 'Old2', gen: 2, amount: 3, stakeId: 'old2', credited: true, creditedAt: twoDaysAgo, readyAt: twoDaysAgo - 300000 },
  { sponsor: 'Recent', gen: 1, amount: 10, stakeId: 'recent', credited: true, creditedAt: Date.now() - 3600000, readyAt: Date.now() - 600000 },
  { sponsor: 'New1', gen: 1, amount: 7, stakeId: 'new1', credited: false, readyAt: Date.now() + 300000, ts: Date.now() },
  { sponsor: 'Ready1', gen: 1, amount: 1, stakeId: 'ready1', credited: false, readyAt: Date.now() - 1000, from: 'clean@t.com', cardTier: 'Visa', ts: Date.now() - 300000 }
]));

_autoWithdrawGenCommissions();

const pq11 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
// Already-credited items (Old1, Old2, Recent) are skipped in the loop, so they're dropped.
// Only New1 (still pending) + Ready1 (newly credited) remain.
assert(pq11.length === 2, 'Queue cleaned: 2 remain (new pending + newly credited)');
const hasOld = pq11.some(p => p.sponsor === 'Old1' || p.sponsor === 'Old2');
assert(!hasOld, 'Old credited items removed');
const hasRecent = pq11.some(p => p.sponsor === 'Recent');
assert(!hasRecent, 'Previously credited item also cleaned out');
const hasNew = pq11.some(p => p.sponsor === 'New1');
assert(hasNew, 'New uncredited item retained');
const hasReady = pq11.some(p => p.sponsor === 'Ready1');
assert(hasReady, 'Newly credited item retained');
console.log('');

// ══════════════════════════════════════════════════
// TEST 12: Commission Log Capping (max 200)
// ══════════════════════════════════════════════════
console.log('── Test 12: Commission Log Capping ──');
localStorage.clear();
adminDeposits = [];

// Pre-fill with 200 logs
const preFill = [];
for (let i = 0; i < 200; i++) preFill.push({ stakeId: 'pre_' + i, ts: i });
localStorage.setItem('cw_gen_commission_log', JSON.stringify(preFill));
localStorage.setItem('cw_invites', '[]');

distribute8GenCommissions('no@chain.com', 100, 'new_stake', 'Visa');

const log12 = JSON.parse(localStorage.getItem('cw_gen_commission_log') || '[]');
assert(log12.length <= 200, 'Commission log capped at 200 (got ' + log12.length + ')');
assert(log12[log12.length - 1].stakeId === 'new_stake', 'Newest entry is last');
console.log('');

// ══════════════════════════════════════════════════
// TEST 13: readyAt Timestamp Accuracy
// ══════════════════════════════════════════════════
console.log('── Test 13: readyAt Timestamp Accuracy ──');
localStorage.clear();
adminDeposits = [];

buildInviteChain([
  { email: 'ts@test.com', name: 'TSUser', sponsor: 'TSSpons' },
  { email: 'ts_sp@test.com', name: 'TSSpons', sponsor: null }
]);

const before = Date.now();
distribute8GenCommissions('ts@test.com', 100, 'ts_stake', 'Amex');
const after = Date.now();

const pq13 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(pq13.length === 1, 'Pending has 1 entry');
const readyAt = pq13[0].readyAt;
const ts = pq13[0].ts;

assert(ts >= before && ts <= after, 'Timestamp within execution window');
assert(readyAt >= before + GEN_WITHDRAW_DELAY && readyAt <= after + GEN_WITHDRAW_DELAY,
  'readyAt = ts + 5 min (within execution window)');
assertClose(readyAt - ts, GEN_WITHDRAW_DELAY, 100, 'readyAt - ts = exactly 300000ms');
console.log('');

// ══════════════════════════════════════════════════
// TEST 14: Card Page distribute8GenCommissions (Simulated — Same Logic)
// ══════════════════════════════════════════════════
console.log('── Test 14: Card Page Commission Consistency ──');
localStorage.clear();
adminDeposits = [];

// Card pages use GEN_RATES_ABS instead of GEN_RATES, same values
const GEN_RATES_ABS = [0.10, 0.06, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04];

function distribute8GenCommissionsCardPage(stakerEmail, stakeAmountOLIGHFT, stakeId, cardTier) {
  var invites = [];
  try { invites = JSON.parse(localStorage.getItem('cw_invites') || '[]'); } catch(e) { return []; }
  var GEN_WITHDRAW_DELAY_L = 5 * 60 * 1000;
  var currentEmail = stakerEmail.toLowerCase();
  var commissions = [];
  var nowTs = Date.now();
  for (var gen = 0; gen < 8; gen++) {
    var found = null;
    for (var inv of invites) { if (inv.invitee && inv.invitee.email && inv.invitee.email.toLowerCase() === currentEmail) { found = inv; break; } }
    if (!found || !found.inviterName) break;
    var genAmt = stakeAmountOLIGHFT * GEN_RATES_ABS[gen];
    var genUSD = genAmt * 0.50;
    var sKey = 'cw_gen_earnings_' + found.inviterName.toLowerCase();
    var sEarn = []; try { sEarn = JSON.parse(localStorage.getItem(sKey) || '[]'); } catch(e) { sEarn = []; }
    sEarn.push({ gen: gen + 1, from: stakerEmail, amount: genAmt, usd: genUSD, stakeId: stakeId, cardTier: cardTier, ts: nowTs, readyAt: nowTs + GEN_WITHDRAW_DELAY_L, credited: false });
    localStorage.setItem(sKey, JSON.stringify(sEarn));
    var pQ = []; try { pQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]'); } catch(e) { pQ = []; }
    pQ.push({ sponsor: found.inviterName, gen: gen + 1, amount: genAmt, usd: genUSD, stakeId: stakeId, cardTier: cardTier, from: stakerEmail, ts: nowTs, readyAt: nowTs + GEN_WITHDRAW_DELAY_L, credited: false });
    localStorage.setItem('cw_gen_pending', JSON.stringify(pQ));
    commissions.push({ gen: gen + 1, sponsor: found.inviterName, amount: genAmt, rate: GEN_RATES_ABS[gen] });
    var sponsorInv = null;
    for (var si = 0; si < invites.length; si++) {
      if (invites[si].invitee && invites[si].invitee.email) {
        var siName = (invites[si].invitee.name || '').toLowerCase();
        var siEmail = (invites[si].invitee.email || '').toLowerCase();
        if (siName === found.inviterName.toLowerCase() || siEmail === found.inviterName.toLowerCase()) { sponsorInv = invites[si]; break; }
      }
    }
    if (!sponsorInv || !sponsorInv.invitee) break;
    currentEmail = sponsorInv.invitee.email.toLowerCase();
  }
  if (commissions.length < 8) {
    var undist = 0; for (var g = commissions.length; g < 8; g++) undist += stakeAmountOLIGHFT * GEN_RATES_ABS[g];
    if (undist > 0) depositToAdminWallet(undist, 'unclaimed_gen_' + (commissions.length + 1) + '_to_8', stakeId);
  }
  return commissions;
}

buildInviteChain([
  { email: 'cp@test.com', name: 'CardStaker', sponsor: 'CardSpons' },
  { email: 'cps@test.com', name: 'CardSpons', sponsor: null }
]);

const cpRes = distribute8GenCommissionsCardPage('cp@test.com', 160, 'card_stake_1', 'Visa');
assert(cpRes.length === 1, 'Card page: 1 gen distributed');
assertClose(cpRes[0].amount, 16, 0.01, 'Card page Gen1 = 16 OLIGHFT (10% of 160)');

const cpPQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
assert(cpPQ.length === 1, 'Card page writes to cw_gen_pending');
assert(cpPQ[0].readyAt > Date.now(), 'Card page pending has future readyAt');
assert(cpPQ[0].credited === false, 'Card page pending credited=false');

// Now use dashboard auto-withdraw to credit it (cross-page compatibility)
cpPQ.forEach(p => { p.readyAt = Date.now() - 1000; });
localStorage.setItem('cw_gen_pending', JSON.stringify(cpPQ));
const cpEarn = JSON.parse(localStorage.getItem('cw_gen_earnings_cardspons') || '[]');
cpEarn.forEach(e => { e.readyAt = Date.now() - 1000; });
localStorage.setItem('cw_gen_earnings_cardspons', JSON.stringify(cpEarn));

const cpAW = _autoWithdrawGenCommissions();
assert(cpAW.credited === 1, 'Dashboard auto-withdraw credits card page commission');
assertClose(cpAW.total, 16, 0.01, 'Credited 16 OLIGHFT from card page stake');
console.log('');

// ══════════════════════════════════════════════════
// TEST 15: Activity & Notification Limits
// ══════════════════════════════════════════════════
console.log('── Test 15: Activity & Notification Caps ──');
localStorage.clear();

// Pre-fill with 50 entries
const preFillAct = [];
const preFillNot = [];
for (let i = 0; i < 50; i++) {
  preFillAct.push({ type: 'old_' + i, ts: i });
  preFillNot.push({ type: 'old_' + i, ts: i });
}
localStorage.setItem('cw_activity', JSON.stringify(preFillAct));
localStorage.setItem('cw_tx_notifications', JSON.stringify(preFillNot));

// Add a ready commission
localStorage.setItem('cw_gen_pending', JSON.stringify([
  { sponsor: 'Cap', gen: 1, amount: 5, stakeId: 'cap1', credited: false, readyAt: Date.now() - 1000, from: 'x@t.com', cardTier: 'Visa', ts: Date.now() - 300000 }
]));

_autoWithdrawGenCommissions();

const act15 = JSON.parse(localStorage.getItem('cw_activity') || '[]');
assert(act15.length <= 50, 'Activity capped at 50 (got ' + act15.length + ')');
assert(act15[0].type.includes('Gen 1'), 'Newest activity at index 0');

const not15 = JSON.parse(localStorage.getItem('cw_tx_notifications') || '[]');
assert(not15.length <= 50, 'Notifications capped at 50 (got ' + not15.length + ')');
assert(not15[0].type.includes('Gen 1'), 'Newest notification at index 0');
console.log('');

// ══════════════════════════════════════════════════
// TEST 16: Mixed Ready + Pending Items
// ══════════════════════════════════════════════════
console.log('── Test 16: Mixed Ready + Pending Items ──');
localStorage.clear();

localStorage.setItem('cw_gen_pending', JSON.stringify([
  { sponsor: 'Ready1', gen: 1, amount: 10, stakeId: 's1', credited: false, readyAt: Date.now() - 60000, from: 'a@t.com', cardTier: 'Visa', ts: Date.now() - 360000 },
  { sponsor: 'Ready2', gen: 2, amount: 8, stakeId: 's1', credited: false, readyAt: Date.now() - 30000, from: 'a@t.com', cardTier: 'Visa', ts: Date.now() - 330000 },
  { sponsor: 'NotYet1', gen: 1, amount: 15, stakeId: 's2', credited: false, readyAt: Date.now() + 120000, from: 'b@t.com', cardTier: 'Gold', ts: Date.now() },
  { sponsor: 'NotYet2', gen: 2, amount: 12, stakeId: 's2', credited: false, readyAt: Date.now() + 240000, from: 'b@t.com', cardTier: 'Gold', ts: Date.now() }
]));

const aw16 = _autoWithdrawGenCommissions();
assert(aw16.credited === 2, 'Only 2 ready items credited');
assertClose(aw16.total, 18, 0.01, 'Total credited = 18 (10 + 8)');

const pq16 = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
const stillPending16 = pq16.filter(p => !p.credited);
assert(stillPending16.length === 2, '2 items still pending');
assert(stillPending16[0].sponsor === 'NotYet1', 'NotYet1 still pending');
assert(stillPending16[1].sponsor === 'NotYet2', 'NotYet2 still pending');
console.log('');

// ══════════════════════════════════════════════════
// TEST 17: Earnings Matching Logic
// ══════════════════════════════════════════════════
console.log('── Test 17: Earnings Entry Matching (stakeId + gen) ──');
localStorage.clear();

// Multiple earnings from different stakes for same sponsor
localStorage.setItem('cw_gen_earnings_sponsor1', JSON.stringify([
  { gen: 1, amount: 10, stakeId: 'sA', credited: false, readyAt: Date.now() - 1000 },
  { gen: 1, amount: 20, stakeId: 'sB', credited: false, readyAt: Date.now() - 1000 },
  { gen: 2, amount: 5, stakeId: 'sA', credited: false, readyAt: Date.now() - 1000 }
]));

localStorage.setItem('cw_gen_pending', JSON.stringify([
  { sponsor: 'Sponsor1', gen: 1, amount: 10, stakeId: 'sA', credited: false, readyAt: Date.now() - 1000 },
  { sponsor: 'Sponsor1', gen: 1, amount: 20, stakeId: 'sB', credited: false, readyAt: Date.now() - 1000 }
]));

_autoWithdrawGenCommissions();

const earn17 = JSON.parse(localStorage.getItem('cw_gen_earnings_sponsor1') || '[]');
const creditedCount = earn17.filter(e => e.credited).length;
assert(creditedCount === 2, '2 earnings entries marked credited (matching stakeId+gen)');
assert(earn17[2].credited === false, 'Gen2 entry from stakeA NOT marked (not in pending)');
console.log('');

// ══════════════════════════════════════════════════
// TEST 18: Edge Cases
// ══════════════════════════════════════════════════
console.log('── Test 18: Edge Cases ──');
// 18a: Empty pending queue
localStorage.clear();
const aw18a = _autoWithdrawGenCommissions();
assert(aw18a.credited === 0, 'Empty pending → 0 credited');

// 18b: Corrupted localStorage
localStorage.setItem('cw_gen_pending', 'not json');
const aw18b = _autoWithdrawGenCommissions();
assert(aw18b.credited === 0, 'Corrupted JSON → graceful 0');

// 18c: Missing readyAt
localStorage.clear();
localStorage.setItem('cw_gen_pending', JSON.stringify([
  { sponsor: 'Test', gen: 1, amount: 5, stakeId: 'x', credited: false }
]));
const aw18c = _autoWithdrawGenCommissions();
assert(aw18c.credited === 1, 'Missing readyAt → treated as 0 → immediately ready');

// 18d: Very small amount
localStorage.clear();
buildInviteChain([
  { email: 'tiny@t.com', name: 'Tiny', sponsor: 'BigS' },
  { email: 'bigs@t.com', name: 'BigS', sponsor: null }
]);
const tinyRes = distribute8GenCommissions('tiny@t.com', 0.001, 's_tiny', 'Mastercard');
assert(tinyRes.length === 1, 'Tiny stake distributes');
assertClose(tinyRes[0].amount, 0.0001, 0.0001, 'Tiny Gen1 = 0.0001 OLIGHFT');

// 18e: Zero stake
localStorage.clear();
buildInviteChain([
  { email: 'zero@t.com', name: 'Zero', sponsor: 'ZeroS' },
  { email: 'zeros@t.com', name: 'ZeroS', sponsor: null }
]);
const zeroRes = distribute8GenCommissions('zero@t.com', 0, 's_zero', 'Visa');
assert(zeroRes.length === 1, 'Zero stake still walks chain');
assertClose(zeroRes[0].amount, 0, 0.001, 'Zero stake → 0 commission');

// 18f: Case-insensitive email matching
localStorage.clear();
localStorage.setItem('cw_invites', JSON.stringify([
  { inviterName: 'CaseSponsor', invitee: { email: 'UPPER@TEST.COM', name: 'Upper' } }
]));
const caseRes = distribute8GenCommissions('upper@test.com', 100, 's_case', 'Amex');
assert(caseRes.length === 1, 'Case-insensitive email match works');
assert(caseRes[0].sponsor === 'CaseSponsor', 'Correct sponsor found');
console.log('');

// ══════════════════════════════════════════════════
// TEST 19: Full Stake Lifecycle Simulation
// ══════════════════════════════════════════════════
console.log('── Test 19: Full Stake Lifecycle (Stake → Pending → Wait → Credit) ──');
localStorage.clear();
adminDeposits = [];

const lifecycleChain = [
  { email: 'lc_staker@test.com', name: 'LCStaker', sponsor: 'LCSponsor' },
  { email: 'lc_sp@test.com',     name: 'LCSponsor', sponsor: null }
];
buildInviteChain(lifecycleChain);

localStorage.setItem('cw_user', JSON.stringify({ name: 'LCSponsor', email: 'lc_sp@test.com' }));
localStorage.setItem('cw_balances', JSON.stringify(Object.assign({}, DEFAULT_BALS)));

// Step 1: Activate card → 60% admin, 40% referral
const cardTier = 'Visa';
const stakeUSD = CARD_TIERS[cardTier].min + CARD_TIERS[cardTier].fee; // 100 + 40 = $140
const stakeOLIGHFT = stakeUSD / OLIGHFT_PRICE; // 280 OLIGHFT
const adminShare = stakeOLIGHFT * ADMIN_WALLET_SPLIT; // 168 OLIGHFT
const refShare = stakeOLIGHFT * (1 - ADMIN_WALLET_SPLIT); // 112 OLIGHFT

assert(stakeOLIGHFT === 280, 'Visa stake = 280 OLIGHFT ($140)');
assertClose(adminShare, 168, 0.01, 'Admin 60% = 168 OLIGHFT');
assertClose(refShare, 112, 0.01, 'Referral 40% = 112 OLIGHFT');

// Step 2: Distribute commissions
const lcRes = distribute8GenCommissions('lc_staker@test.com', refShare, 'lc_stake_1', cardTier);
assert(lcRes.length === 1, 'Lifecycle: 1 gen distributed');
const gen1Amount = refShare * 0.10; // 11.2 OLIGHFT
assertClose(lcRes[0].amount, gen1Amount, 0.01, 'Gen1 = ' + gen1Amount.toFixed(2) + ' OLIGHFT');

// Step 3: Sponsor balance NOT yet credited
let lcBal = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(lcBal.OLIGHFT, DEFAULT_BALS.OLIGHFT, 0.01, 'Sponsor balance unchanged (still pending)');

// Step 4: Try auto-withdraw (too early)
_autoWithdrawGenCommissions();
lcBal = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(lcBal.OLIGHFT, DEFAULT_BALS.OLIGHFT, 0.01, 'Still unchanged after early auto-withdraw');

// Step 5: Simulate 5 minutes passing
const lcPQ = JSON.parse(localStorage.getItem('cw_gen_pending') || '[]');
lcPQ.forEach(p => { p.readyAt = Date.now() - 1; });
localStorage.setItem('cw_gen_pending', JSON.stringify(lcPQ));
const lcEarn = JSON.parse(localStorage.getItem('cw_gen_earnings_lcsponsor') || '[]');
lcEarn.forEach(e => { e.readyAt = Date.now() - 1; });
localStorage.setItem('cw_gen_earnings_lcsponsor', JSON.stringify(lcEarn));

// Step 6: Auto-withdraw after 5 min
const lcAW = _autoWithdrawGenCommissions();
assert(lcAW.credited === 1, 'Auto-withdraw credits 1 commission');
assertClose(lcAW.total, gen1Amount, 0.01, 'Credited ' + gen1Amount.toFixed(2) + ' OLIGHFT');

// Step 7: Verify final balance
lcBal = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(lcBal.OLIGHFT, DEFAULT_BALS.OLIGHFT + gen1Amount, 0.01,
  'Final balance = ' + (DEFAULT_BALS.OLIGHFT + gen1Amount).toFixed(2) + ' OLIGHFT');

// Step 8: Verify no double-credit
_autoWithdrawGenCommissions();
lcBal = JSON.parse(localStorage.getItem('cw_balances'));
assertClose(lcBal.OLIGHFT, DEFAULT_BALS.OLIGHFT + gen1Amount, 0.01,
  'No double-credit on re-run');

// Step 9: Admin got undistributed gens 2-8
const adminUndistLC = refShare * 0.30;
assert(adminDeposits.length >= 1, 'Admin received undistributed deposit');
assertClose(adminDeposits[adminDeposits.length - 1].amount, adminUndistLC, 0.01,
  'Admin undistributed = ' + adminUndistLC.toFixed(2) + ' OLIGHFT (30% of ' + refShare.toFixed(0) + ')');
console.log('');

// ══════════════════════════════════════════════════
// SUMMARY
// ══════════════════════════════════════════════════
console.log('═══════════════════════════════════════════════════════════');
if (failed === 0) {
  console.log('  \x1b[42m\x1b[97m ALL ' + passed + '/' + total + ' TESTS PASSED \x1b[0m  🎉');
} else {
  console.log('  \x1b[32m✅ Passed: ' + passed + '\x1b[0m');
  console.log('  \x1b[31m❌ Failed: ' + failed + '\x1b[0m');
  console.log('  Total: ' + total);
}
console.log('═══════════════════════════════════════════════════════════');
process.exit(failed > 0 ? 1 : 0);
