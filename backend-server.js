/**
 * OLIGHFT SMART COIN — Unified Backend Server
 * Handles: Auth, Balances, Staking, Compound, Withdraw, 8-Gen Commissions,
 *          Supply/Price, Swap, Escrow, Activity, Admin deposits
 *
 * Database: SQLite (better-sqlite3)
 * Auth: JWT tokens
 * Port: env.OLIGHFT_BACKEND_PORT || 3001
 */

'use strict';

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');
const path       = require('path');
const fs         = require('fs');
const https      = require('https');

// ── Config ──────────────────────────────────────────────────────────────────
const PORT               = parseInt(process.env.OLIGHFT_BACKEND_PORT) || 3001;
const JWT_SECRET         = process.env.OLIGHFT_JWT_SECRET || crypto.randomBytes(64).toString('hex');
const JWT_EXPIRY         = '7d';
const BCRYPT_ROUNDS      = 10;
const DB_PATH            = path.join(__dirname, 'olighft.db');

// ── Business Constants (mirror frontend) ────────────────────────────────────
const OLIGHFT_TOTAL_SUPPLY     = 100_000_000_000_000;
const OLIGHFT_BASE_PRICE_FLOOR = 0.50;
const PRICE_ELASTICITY         = 0.35;
const ADMIN_WALLET_SPLIT       = 0.35;
const COMPOUND_FEE_RATE        = 0.02;
const WITHDRAWAL_FEE_RATE      = 0.30;
const GEN_RATES                = [0.10, 0.06, 0.04, 0.04, 0.04, 0.04, 0.04, 0.04];
const STAKE_MATURITY_MS        = 5 * 60 * 1000; // 5-min maturity for all card stakes
const OLIGHFT_PRICE_VAR        = { current: 0.50 };

const CARD_TIERS = {
  Visa:       { min: 200,   daily: 20,  fee: 0, boost: 1.0 },
  Gold:       { min: 800,   daily: 80,  fee: 0, boost: 2.0 },
  Platinum:   { min: 600,   daily: 60,  fee: 0, boost: 1.5 },
  Black:      { min: 1000,  daily: 100, fee: 0, boost: 3.0 },
  Amex:       { min: 400,   daily: 40,  fee: 0, boost: 1.2 },
  Mastercard: { min: 100,   daily: 10,  fee: 0, boost: 0.5 }
};

const LOCK_BOOSTS       = { 30: 1.5, 90: 3.5, 180: 6, 365: 10 };
const COMPOUND_BOOSTS   = { none: 0, daily: 2.4, weekly: 1.2, monthly: 0.5 };
const LOCK_PRICE_WEIGHTS = { 30: 1.0, 90: 1.3, 180: 1.6, 365: 2.0 };
const BASE_APY = 12.0;

const FEE_WALLET_ADDRESS     = 'GBLEKKQNHKVE7NIOOPY7CQ6SJ4BQCGHD3O5FCPB2B47X2ERKSJGSMWCP';
const OLIGHFT_TOKEN_CONTRACT = 'CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J';

const DEFAULT_BALS = { XLM: 10000, USDC: 2500, wETH: 1.85, wBTC: 0.042, EURC: 1200, OLIGHFT: 10000, PI: 500, BNB: 0.5 };

// ── Database Setup ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Users
  CREATE TABLE IF NOT EXISTS users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    email        TEXT UNIQUE NOT NULL COLLATE NOCASE,
    username     TEXT UNIQUE COLLATE NOCASE,
    phone        TEXT,
    name         TEXT,
    password_hash TEXT,
    otp_code     TEXT,
    otp_expires  INTEGER,
    addr         TEXT,
    secret_enc   TEXT,
    seed_enc     TEXT,
    sponsor_id   INTEGER REFERENCES users(id),
    created_at   INTEGER DEFAULT (strftime('%s','now') * 1000),
    last_login   INTEGER
  );

  -- Balances (one row per user per asset)
  CREATE TABLE IF NOT EXISTS balances (
    user_id  INTEGER NOT NULL REFERENCES users(id),
    asset    TEXT NOT NULL,
    amount   REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, asset)
  );

  -- Stakes
  CREATE TABLE IF NOT EXISTS stakes (
    id               TEXT PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    asset            TEXT NOT NULL DEFAULT 'OLIGHFT',
    amount           REAL NOT NULL,
    apy              REAL NOT NULL,
    daily_reward     REAL NOT NULL DEFAULT 0,
    start_date       INTEGER NOT NULL,
    end_date         INTEGER,
    last_compound    INTEGER NOT NULL,
    reward           REAL NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    withdrawn        INTEGER NOT NULL DEFAULT 0,
    compound_type    TEXT NOT NULL DEFAULT 'none',
    lock_days        INTEGER NOT NULL DEFAULT 0,
    card_tier        TEXT,
    card_boost       REAL NOT NULL DEFAULT 0,
    compound_interval_ms INTEGER NOT NULL DEFAULT 0,
    estimated_total_reward REAL NOT NULL DEFAULT 0,
    reserved_from_supply   REAL NOT NULL DEFAULT 0,
    compound_count   INTEGER NOT NULL DEFAULT 0,
    total_compounded REAL NOT NULL DEFAULT 0,
    admin_share      REAL NOT NULL DEFAULT 0,
    ref_share        REAL NOT NULL DEFAULT 0,
    on_chain_index   INTEGER,
    tx_hash          TEXT,
    activation_tx    TEXT,
    withdrawn_at     INTEGER,
    actual_reward    REAL
  );

  -- 8-Gen Commission Logs
  CREATE TABLE IF NOT EXISTS gen_commissions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    stake_id   TEXT NOT NULL,
    sponsor_id INTEGER NOT NULL REFERENCES users(id),
    gen        INTEGER NOT NULL,
    from_email TEXT NOT NULL,
    amount     REAL NOT NULL,
    usd        REAL NOT NULL,
    card_tier  TEXT,
    tx_hash    TEXT,
    on_chain   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Admin Deposits
  CREATE TABLE IF NOT EXISTS admin_deposits (
    id         TEXT PRIMARY KEY,
    amount     REAL NOT NULL,
    usd        REAL NOT NULL,
    source     TEXT NOT NULL,
    stake_id   TEXT,
    on_chain   INTEGER NOT NULL DEFAULT 0,
    tx_hash    TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Supply Log
  CREATE TABLE IF NOT EXISTS supply_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    amount     REAL NOT NULL,
    reason     TEXT NOT NULL,
    stake_id   TEXT,
    remaining  REAL NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Supply Pool (single-row)
  CREATE TABLE IF NOT EXISTS supply_pool (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    remaining REAL NOT NULL
  );
  INSERT OR IGNORE INTO supply_pool (id, remaining) VALUES (1, ${OLIGHFT_TOTAL_SUPPLY});

  -- Price History
  CREATE TABLE IF NOT EXISTS price_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    price      REAL NOT NULL,
    staked     REAL NOT NULL DEFAULT 0,
    circulating REAL NOT NULL DEFAULT 0,
    reserved   REAL NOT NULL DEFAULT 0,
    supply     REAL NOT NULL DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Activity Log
  CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    type       TEXT NOT NULL,
    icon       TEXT,
    detail     TEXT,
    amount_str TEXT,
    cls        TEXT,
    created_at INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Invites (referral chain)
  CREATE TABLE IF NOT EXISTS invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_id  INTEGER NOT NULL REFERENCES users(id),
    invitee_id  INTEGER NOT NULL REFERENCES users(id) UNIQUE,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Swap Transactions
  CREATE TABLE IF NOT EXISTS swaps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    token_in    TEXT NOT NULL,
    token_out   TEXT NOT NULL,
    amount_in   REAL NOT NULL,
    amount_out  REAL NOT NULL,
    fee         REAL NOT NULL DEFAULT 0,
    rate        REAL NOT NULL,
    tx_hash     TEXT,
    created_at  INTEGER DEFAULT (strftime('%s','now') * 1000)
  );

  -- Escrows
  CREATE TABLE IF NOT EXISTS escrows (
    id            TEXT PRIMARY KEY,
    buyer_id      INTEGER NOT NULL REFERENCES users(id),
    seller_addr   TEXT NOT NULL,
    arbiter_addr  TEXT,
    amount        REAL NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    deadline      INTEGER,
    description   TEXT,
    tx_hash       TEXT,
    created_at    INTEGER DEFAULT (strftime('%s','now') * 1000),
    updated_at    INTEGER
  );

  -- Wallet Registry (address lookups)
  CREATE TABLE IF NOT EXISTS wallet_registry (
    lookup_key  TEXT PRIMARY KEY COLLATE NOCASE,
    addr        TEXT NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_stakes_user ON stakes(user_id);
  CREATE INDEX IF NOT EXISTS idx_stakes_status ON stakes(status);
  CREATE INDEX IF NOT EXISTS idx_activity_user ON activity(user_id);
  CREATE INDEX IF NOT EXISTS idx_gen_comm_sponsor ON gen_commissions(sponsor_id);
  CREATE INDEX IF NOT EXISTS idx_balances_user ON balances(user_id);
  CREATE INDEX IF NOT EXISTS idx_price_history_ts ON price_history(created_at);
`);

// ── Migrations (safe for existing databases) ────────────────────────────────
try {
  db.prepare("SELECT phone FROM users LIMIT 1").get();
} catch (e) {
  db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
  console.log('[MIGRATION] Added phone column to users table');
}

// ── Prepared Statements ─────────────────────────────────────────────────────
const stmts = {
  // Users
  getUserByEmail:   db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserByPhone:   db.prepare('SELECT * FROM users WHERE phone = ?'),
  getUserById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  createUser:       db.prepare('INSERT INTO users (email, username, phone, name, password_hash, sponsor_id) VALUES (?, ?, ?, ?, ?, ?)'),
  updatePassword:   db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setOtp:           db.prepare('UPDATE users SET otp_code = ?, otp_expires = ? WHERE id = ?'),
  clearOtp:         db.prepare('UPDATE users SET otp_code = NULL, otp_expires = NULL WHERE id = ?'),
  setAddr:          db.prepare('UPDATE users SET addr = ? WHERE id = ?'),
  setLastLogin:     db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),

  // Balances
  getBalances:    db.prepare('SELECT asset, amount FROM balances WHERE user_id = ?'),
  getBalance:     db.prepare('SELECT amount FROM balances WHERE user_id = ? AND asset = ?'),
  upsertBalance:  db.prepare('INSERT INTO balances (user_id, asset, amount) VALUES (?, ?, ?) ON CONFLICT(user_id, asset) DO UPDATE SET amount = excluded.amount'),
  addBalance:     db.prepare('INSERT INTO balances (user_id, asset, amount) VALUES (?, ?, ?) ON CONFLICT(user_id, asset) DO UPDATE SET amount = amount + excluded.amount'),

  // Stakes
  insertStake:        db.prepare(`INSERT INTO stakes (id, user_id, asset, amount, apy, daily_reward, start_date, end_date, last_compound, compound_type, lock_days, card_tier, card_boost, compound_interval_ms, estimated_total_reward, reserved_from_supply, admin_share, ref_share) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getStakeById:       db.prepare('SELECT * FROM stakes WHERE id = ?'),
  getStakesByUser:    db.prepare('SELECT * FROM stakes WHERE user_id = ? ORDER BY start_date DESC'),
  getActiveStakes:    db.prepare('SELECT * FROM stakes WHERE user_id = ? AND withdrawn = 0 AND status = ?'),
  getAllActiveStakes: db.prepare('SELECT * FROM stakes WHERE withdrawn = 0 AND status = ?'),
  updateStakeCompound: db.prepare('UPDATE stakes SET amount = ?, last_compound = ?, reward = 0, compound_count = compound_count + 1, total_compounded = total_compounded + ? WHERE id = ?'),
  withdrawStake:      db.prepare('UPDATE stakes SET status = ?, withdrawn = 1, withdrawn_at = ?, actual_reward = ? WHERE id = ?'),

  // Supply
  getSupply:       db.prepare('SELECT remaining FROM supply_pool WHERE id = 1'),
  updateSupply:    db.prepare('UPDATE supply_pool SET remaining = ? WHERE id = 1'),
  insertSupplyLog: db.prepare('INSERT INTO supply_log (amount, reason, stake_id, remaining) VALUES (?, ?, ?, ?)'),

  // Price History
  insertPrice:     db.prepare('INSERT INTO price_history (price, staked, circulating, reserved, supply) VALUES (?, ?, ?, ?, ?)'),
  getPriceHistory: db.prepare('SELECT price, staked, circulating, reserved, supply, created_at as ts FROM price_history WHERE created_at >= ? ORDER BY created_at ASC'),
  getLatestPrice:  db.prepare('SELECT * FROM price_history ORDER BY created_at DESC LIMIT 1'),

  // Gen Commissions
  insertGenComm:    db.prepare('INSERT INTO gen_commissions (stake_id, sponsor_id, gen, from_email, amount, usd, card_tier) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getGenBySponsor:  db.prepare('SELECT * FROM gen_commissions WHERE sponsor_id = ? ORDER BY created_at DESC LIMIT 100'),
  getGenByStake:    db.prepare('SELECT * FROM gen_commissions WHERE stake_id = ?'),

  // Admin Deposits
  insertAdminDep:   db.prepare('INSERT INTO admin_deposits (id, amount, usd, source, stake_id) VALUES (?, ?, ?, ?, ?)'),
  getAdminDeposits: db.prepare('SELECT * FROM admin_deposits ORDER BY created_at DESC LIMIT 100'),
  getAdminTotal:    db.prepare('SELECT COALESCE(SUM(amount), 0) as total FROM admin_deposits'),

  // Activity
  insertActivity:   db.prepare('INSERT INTO activity (user_id, type, icon, detail, amount_str, cls) VALUES (?, ?, ?, ?, ?, ?)'),
  getActivity:      db.prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),

  // Invites
  insertInvite:     db.prepare('INSERT OR IGNORE INTO invites (inviter_id, invitee_id) VALUES (?, ?)'),
  getInviter:       db.prepare('SELECT inviter_id FROM invites WHERE invitee_id = ?'),
  getInvitees:      db.prepare('SELECT invitee_id FROM invites WHERE inviter_id = ?'),

  // Swaps
  insertSwap:       db.prepare('INSERT INTO swaps (user_id, token_in, token_out, amount_in, amount_out, fee, rate) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getSwapsByUser:   db.prepare('SELECT * FROM swaps WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'),

  // Escrows
  insertEscrow:     db.prepare('INSERT INTO escrows (id, buyer_id, seller_addr, arbiter_addr, amount, deadline, description) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  getEscrowById:    db.prepare('SELECT * FROM escrows WHERE id = ?'),
  getEscrowsByBuyer: db.prepare('SELECT * FROM escrows WHERE buyer_id = ? ORDER BY created_at DESC'),
  updateEscrowStatus: db.prepare('UPDATE escrows SET status = ?, updated_at = ? WHERE id = ?'),

  // Wallet Registry
  upsertWalletReg:  db.prepare('INSERT INTO wallet_registry (lookup_key, addr) VALUES (?, ?) ON CONFLICT(lookup_key) DO UPDATE SET addr = excluded.addr'),
  lookupWallet:     db.prepare('SELECT addr FROM wallet_registry WHERE lookup_key = ?'),
};

// ── Helper Functions ────────────────────────────────────────────────────────

function genId(prefix) {
  return prefix + '_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
}

function getSupplyPool() {
  return stmts.getSupply.get().remaining;
}

function deductFromSupply(amount, reason, stakeId) {
  let remaining = getSupplyPool();
  if (amount > remaining) amount = remaining;
  remaining -= amount;
  stmts.updateSupply.run(remaining);
  stmts.insertSupplyLog.run(amount, reason, stakeId || '', remaining);
  return { deducted: amount, remaining };
}

function returnToSupply(amount, stakeId) {
  let remaining = getSupplyPool();
  remaining += amount;
  if (remaining > OLIGHFT_TOTAL_SUPPLY) remaining = OLIGHFT_TOTAL_SUPPLY;
  stmts.updateSupply.run(remaining);
  stmts.insertSupplyLog.run(-amount, 'return_unused', stakeId || '', remaining);
}

function depositToAdmin(amountOLIGHFT, source, stakeId) {
  const usd = amountOLIGHFT * OLIGHFT_PRICE_VAR.current;
  const depId = genId('adm');
  stmts.insertAdminDep.run(depId, amountOLIGHFT, usd, source, stakeId || '');
  return { id: depId, amount: amountOLIGHFT, usd };
}

function getLockPriceWeight(lockDays) {
  if (lockDays >= 365) return LOCK_PRICE_WEIGHTS[365];
  if (lockDays >= 180) return LOCK_PRICE_WEIGHTS[180];
  if (lockDays >= 90)  return LOCK_PRICE_WEIGHTS[90];
  if (lockDays >= 30)  return LOCK_PRICE_WEIGHTS[30];
  return 1.0;
}

function calcOLIGHFTPrice() {
  const allStakes = stmts.getAllActiveStakes.all('active');
  const now = Date.now();
  let effectiveLocked = 0;

  for (const s of allStakes) {
    const amt = s.amount || 0;
    const lockDays = s.lock_days || 0;
    const endTs = s.start_date + STAKE_MATURITY_MS;
    let weight = getLockPriceWeight(lockDays);
    if (lockDays > 0 && now >= endTs) weight *= 0.3;
    effectiveLocked += amt * weight;
  }

  const reserved = OLIGHFT_TOTAL_SUPPLY - getSupplyPool();
  if (reserved > 0) effectiveLocked += reserved * 0.5;

  let circulating = OLIGHFT_TOTAL_SUPPLY - effectiveLocked;
  if (circulating < OLIGHFT_TOTAL_SUPPLY * 0.01) circulating = OLIGHFT_TOTAL_SUPPLY * 0.01;

  const ratio = OLIGHFT_TOTAL_SUPPLY / circulating;
  let price = OLIGHFT_BASE_PRICE_FLOOR * Math.pow(ratio, PRICE_ELASTICITY);
  if (price > OLIGHFT_BASE_PRICE_FLOOR * 100) price = OLIGHFT_BASE_PRICE_FLOOR * 100;

  OLIGHFT_PRICE_VAR.current = parseFloat(price.toFixed(6));
  return OLIGHFT_PRICE_VAR.current;
}

function getLiquidityInfo() {
  const allStakes = stmts.getAllActiveStakes.all('active');
  const now = Date.now();
  let totalStaked = 0;
  const lockBreakdown = { 30: 0, 90: 0, 180: 0, 365: 0 };

  for (const s of allStakes) {
    const amt = s.amount || 0;
    totalStaked += amt;
    const ld = s.lock_days || 0;
    if (ld >= 365) lockBreakdown[365] += amt;
    else if (ld >= 180) lockBreakdown[180] += amt;
    else if (ld >= 90)  lockBreakdown[90] += amt;
    else if (ld >= 30)  lockBreakdown[30] += amt;
  }

  const reserved = OLIGHFT_TOTAL_SUPPLY - getSupplyPool();
  let circulating = OLIGHFT_TOTAL_SUPPLY - totalStaked - (reserved > 0 ? reserved : 0);
  if (circulating < 0) circulating = 0;
  const price = calcOLIGHFTPrice();
  const priceChange = ((price - OLIGHFT_BASE_PRICE_FLOOR) / OLIGHFT_BASE_PRICE_FLOOR) * 100;

  return { totalStaked, circulating, reserved: reserved > 0 ? reserved : 0, stakingRatio: (totalStaked / OLIGHFT_TOTAL_SUPPLY) * 100, price, priceChange, lockBreakdown };
}

function getApy(lockDays, compound, cardTier) {
  let base = BASE_APY;
  let lockBoost = 0;
  for (const [d, b] of Object.entries(LOCK_BOOSTS)) {
    if (lockDays >= parseInt(d)) lockBoost = b;
  }
  const compBoost = COMPOUND_BOOSTS[compound] || 0;
  let cardBoost = 0;
  if (cardTier && CARD_TIERS[cardTier]) cardBoost = CARD_TIERS[cardTier].boost;
  return { base, lock: lockBoost, compound: compBoost, card: cardBoost, total: base + lockBoost + compBoost + cardBoost };
}

function calcCardDailyCompound(cardDailyOLIGHFT, days, compoundType) {
  return cardDailyOLIGHFT * days;
}

function getUserBalances(userId) {
  const rows = stmts.getBalances.all(userId);
  const bals = Object.assign({}, DEFAULT_BALS);
  for (const r of rows) bals[r.asset] = r.amount;
  return bals;
}

function initUserBalances(userId) {
  const txn = db.transaction(() => {
    for (const [asset, amount] of Object.entries(DEFAULT_BALS)) {
      stmts.upsertBalance.run(userId, asset, amount);
    }
  });
  txn();
}

function logActivity(userId, type, icon, detail, amtStr, cls) {
  stmts.insertActivity.run(userId, type, icon || '', detail || '', amtStr || '', cls || '');
}

// Walk sponsor chain for 8-gen commissions
function distribute8GenCommissions(stakerId, stakeAmountOLIGHFT, stakeId, cardTier) {
  const commissions = [];
  let currentUserId = stakerId;
  let genDistributed = 0;

  for (let gen = 0; gen < 8; gen++) {
    const invRow = stmts.getInviter.get(currentUserId);
    if (!invRow) break;

    const sponsorId = invRow.inviter_id;
    const sponsor = stmts.getUserById.get(sponsorId);
    if (!sponsor) break;

    const rate = GEN_RATES[gen];
    const commOLIGHFT = stakeAmountOLIGHFT * rate;
    const commUSD = commOLIGHFT * OLIGHFT_PRICE_VAR.current;

    // Credit sponsor OLIGHFT balance
    stmts.addBalance.run(sponsorId, 'OLIGHFT', commOLIGHFT);

    // Log commission
    stmts.insertGenComm.run(stakeId, sponsorId, gen + 1, '', commOLIGHFT, commUSD, cardTier || '');

    commissions.push({ gen: gen + 1, sponsorId, sponsor: sponsor.username || sponsor.email, rate, amount: commOLIGHFT, usd: commUSD });
    genDistributed++;
    currentUserId = sponsorId;
  }

  // Undistributed goes to admin
  let undistributed = 0;
  for (let g = genDistributed; g < 8; g++) {
    undistributed += stakeAmountOLIGHFT * GEN_RATES[g];
  }
  if (undistributed > 0) {
    depositToAdmin(undistributed, 'unclaimed_gen_' + (genDistributed + 1) + '_to_8', stakeId);
  }

  return commissions;
}

// ── Rate Limiter ────────────────────────────────────────────────────────────
function rateLimit(windowMs, maxReqs) {
  const map = new Map(); // each call gets its own counter map
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    let entry = map.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      map.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxReqs) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

// ── JWT Middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userEmail = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const ADMIN_EMAILS = (process.env.OLIGHFT_ADMIN_EMAILS || 'tzzminerals@gmail.com,omendaonline@gmail.com')
  .split(',').map(e => e.trim().toLowerCase());

function adminMiddleware(req, res, next) {
  authMiddleware(req, res, () => {
    if (!req.userEmail || !ADMIN_EMAILS.includes(req.userEmail.toLowerCase())) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// ── Express App ─────────────────────────────────────────────────────────────
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: ['https://olighftcoin.com', 'https://olighftcoin.pages.dev', 'http://localhost:8080', 'http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:8080', 'http://127.0.0.1:3000'],
  credentials: true
}));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit(60000, 120)); // 120 req/min global

// ═══════════════════════════════════════════════════════════════════════════
// AUTH ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/auth/register
app.post('/api/auth/register', (req, res) => {
  try {
    const { email, username, phone, name, password, sponsorUsername } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = stmts.getUserByEmail.get(email);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    if (username) {
      const uExist = stmts.getUserByUsername.get(username);
      if (uExist) return res.status(409).json({ error: 'Username already taken' });
    }

    if (phone) {
      const pExist = stmts.getUserByPhone.get(phone);
      if (pExist) return res.status(409).json({ error: 'Phone number already registered' });
    }

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);

    let sponsorId = null;
    if (sponsorUsername) {
      const sponsor = stmts.getUserByUsername.get(sponsorUsername) || stmts.getUserByEmail.get(sponsorUsername);
      if (sponsor) sponsorId = sponsor.id;
    }

    const result = stmts.createUser.run(email, username || null, phone || null, name || null, hash, sponsorId);
    const userId = result.lastInsertRowid;

    // Init balances
    initUserBalances(userId);

    // Record invite chain
    if (sponsorId) {
      stmts.insertInvite.run(sponsorId, userId);
    }

    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    stmts.setLastLogin.run(Date.now(), userId);

    logActivity(userId, 'Registered', '🎉', 'Account created' + (sponsorId ? ' (referred)' : ''), '', 'green');

    res.json({ success: true, token, user: { id: userId, email, username, phone: phone || null, name, addr: null } });
  } catch (e) {
    console.error('Register error:', e.message);
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Account already exists' });
    }
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = stmts.getUserByEmail.get(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    stmts.setLastLogin.run(Date.now(), user.id);

    res.json({ success: true, token, user: { id: user.id, email: user.email, username: user.username, phone: user.phone, name: user.name, addr: user.addr } });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/forgot — send OTP for password reset
app.post('/api/auth/forgot', rateLimit(60000, 5), (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = stmts.getUserByEmail.get(email);
    if (!user) {
      // Don't reveal whether email exists (security)
      return res.json({ success: true, message: 'If an account exists, an OTP was sent' });
    }

    const code = crypto.randomInt(100000, 999999).toString();
    const expires = Date.now() + 5 * 60 * 1000; // 5 min
    stmts.setOtp.run(code, expires, user.id);

    // In production, forward to email_server.py
    console.log(`[FORGOT OTP] ${email}: ${code} (expires ${new Date(expires).toISOString()})`);

    res.json({ success: true, message: 'If an account exists, an OTP was sent' });
  } catch (e) {
    console.error('Forgot error:', e.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// POST /api/auth/reset-password — verify OTP + set new password
app.post('/api/auth/reset-password', rateLimit(60000, 5), (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) return res.status(400).json({ error: 'Email, code, and new password required' });

    // Validate password strength
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!/[A-Z]/.test(newPassword)) return res.status(400).json({ error: 'Password must contain an uppercase letter' });
    if (!/[a-z]/.test(newPassword)) return res.status(400).json({ error: 'Password must contain a lowercase letter' });
    if (!/[0-9]/.test(newPassword)) return res.status(400).json({ error: 'Password must contain a number' });
    if (!/[^A-Za-z0-9]/.test(newPassword)) return res.status(400).json({ error: 'Password must contain a special character' });

    const user = stmts.getUserByEmail.get(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.otp_code || user.otp_expires < Date.now()) return res.status(400).json({ error: 'OTP expired or not set' });
    if (user.otp_code !== code) return res.status(400).json({ error: 'Invalid OTP' });

    const hash = bcrypt.hashSync(newPassword, BCRYPT_ROUNDS);
    stmts.updatePassword.run(hash, user.id);
    stmts.clearOtp.run(user.id);

    logActivity(user.id, 'Password Reset', '🔑', 'Password was reset via OTP', '', 'green');

    res.json({ success: true, message: 'Password reset successful' });
  } catch (e) {
    console.error('Reset password error:', e.message);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// POST /api/auth/otp/send — generate and "send" OTP (integrate with email_server.py)
app.post('/api/auth/otp/send', (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = stmts.getUserByEmail.get(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const code = crypto.randomInt(100000, 999999).toString();
    const expires = Date.now() + 5 * 60 * 1000; // 5 min
    stmts.setOtp.run(code, expires, user.id);

    // In production, forward to email_server.py
    console.log(`[OTP] ${email}: ${code} (expires ${new Date(expires).toISOString()})`);

    res.json({ success: true, message: 'OTP sent' });
  } catch (e) {
    console.error('OTP error:', e.message);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/otp/verify
app.post('/api/auth/otp/verify', (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

    const user = stmts.getUserByEmail.get(email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.otp_code || user.otp_expires < Date.now()) return res.status(400).json({ error: 'OTP expired' });
    if (user.otp_code !== code) return res.status(400).json({ error: 'Invalid OTP' });

    stmts.clearOtp.run(user.id);
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    stmts.setLastLogin.run(Date.now(), user.id);

    res.json({ success: true, token, user: { id: user.id, email: user.email, username: user.username, name: user.name, addr: user.addr } });
  } catch (e) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/wallet — register wallet address
app.post('/api/auth/wallet', authMiddleware, (req, res) => {
  try {
    const { addr } = req.body;
    if (!addr) return res.status(400).json({ error: 'Address required' });

    stmts.setAddr.run(addr, req.userId);
    const user = stmts.getUserById.get(req.userId);

    // Register lookups
    if (user.email) stmts.upsertWalletReg.run(user.email.toLowerCase(), addr);
    if (user.username) stmts.upsertWalletReg.run(user.username.toLowerCase(), addr);
    if (user.name) stmts.upsertWalletReg.run(user.name.toLowerCase(), addr);

    res.json({ success: true, addr });
  } catch (e) {
    res.status(500).json({ error: 'Failed to register wallet' });
  }
});

// GET /api/auth/me — get current user
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = stmts.getUserById.get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, email: user.email, username: user.username, name: user.name, addr: user.addr, created_at: user.created_at });
});

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/balances
app.get('/api/balances', authMiddleware, (req, res) => {
  res.json(getUserBalances(req.userId));
});

// POST /api/balances/transfer — send tokens to another user
app.post('/api/balances/transfer', authMiddleware, (req, res) => {
  try {
    const { asset, amount, recipientEmail, recipientUsername, recipientAddr } = req.body;
    if (!asset || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid asset or amount' });

    const bals = getUserBalances(req.userId);
    if ((bals[asset] || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });

    // Find recipient
    let recipient = null;
    if (recipientEmail) recipient = stmts.getUserByEmail.get(recipientEmail);
    else if (recipientUsername) recipient = stmts.getUserByUsername.get(recipientUsername);
    else if (recipientAddr) {
      // lookup by addr
      const regRow = db.prepare('SELECT lookup_key FROM wallet_registry WHERE addr = ? LIMIT 1').get(recipientAddr);
      if (regRow) {
        recipient = stmts.getUserByEmail.get(regRow.lookup_key) || stmts.getUserByUsername.get(regRow.lookup_key);
      }
    }
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    const txn = db.transaction(() => {
      stmts.addBalance.run(req.userId, asset, -amount);
      stmts.addBalance.run(recipient.id, asset, amount);
      logActivity(req.userId, 'Sent', '📤', `Sent ${amount.toFixed(2)} ${asset} to ${recipient.username || recipient.email}`, `-${amount.toFixed(2)} ${asset}`, 'red');
      logActivity(recipient.id, 'Received', '📥', `Received ${amount.toFixed(2)} ${asset} from ${req.userEmail}`, `+${amount.toFixed(2)} ${asset}`, 'green');
    });
    txn();

    res.json({ success: true, asset, amount, recipient: recipient.username || recipient.email });
  } catch (e) {
    console.error('Transfer error:', e.message);
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// STAKING ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/stake — activate card stake
app.post('/api/stake', authMiddleware, (req, res) => {
  try {
    const { cardTier, lockDays, compoundType } = req.body;
    if (!cardTier || !CARD_TIERS[cardTier]) return res.status(400).json({ error: 'Invalid card tier' });

    const config = CARD_TIERS[cardTier];
    const price = calcOLIGHFTPrice();
    const fixedAmt = config.min;
    const days = parseInt(lockDays) || 0;
    const comp = compoundType || 'none';

    // Validate balance
    const bals = getUserBalances(req.userId);
    if ((bals.OLIGHFT || 0) < fixedAmt) {
      return res.status(400).json({ error: 'Insufficient OLIGHFT balance', required: fixedAmt, have: bals.OLIGHFT || 0 });
    }

    const apy = getApy(days, comp, cardTier);
    const cardDailyOLIGHFT = config.daily;
    const effectiveDays = days > 0 ? days : 365;
    const estimatedReward = calcCardDailyCompound(cardDailyOLIGHFT, effectiveDays, comp);

    const adminShare = fixedAmt * ADMIN_WALLET_SPLIT;
    const refShare = fixedAmt * (1 - ADMIN_WALLET_SPLIT);

    const stakeId = genId('dsk');
    const now = Date.now();
    const endDate = days > 0 ? now + STAKE_MATURITY_MS : null;

    let compoundIntervalMs = 0;
    if (comp === 'daily') compoundIntervalMs = 86400000;
    if (comp === 'weekly') compoundIntervalMs = 604800000;
    if (comp === 'monthly') compoundIntervalMs = 2592000000;

    // Atomic transaction
    const txn = db.transaction(() => {
      // Debit user balance
      stmts.addBalance.run(req.userId, 'OLIGHFT', -fixedAmt);

      // Admin deposit (60%)
      depositToAdmin(adminShare, 'stake_' + cardTier, stakeId);

      // 8-gen commissions (40%)
      const commissions = distribute8GenCommissions(req.userId, refShare, stakeId, cardTier);

      // Reserve from supply
      const supplyResult = deductFromSupply(estimatedReward, 'reward_reserve', stakeId);

      // Insert stake
      stmts.insertStake.run(
        stakeId, req.userId, 'OLIGHFT', fixedAmt, apy.total, cardDailyOLIGHFT,
        now, endDate, now, comp, days, cardTier, apy.card, compoundIntervalMs,
        estimatedReward, supplyResult.deducted, adminShare, refShare
      );

      logActivity(req.userId, 'Staked', '📈',
        `${fixedAmt.toFixed(2)} OLIGHFT · ${days > 0 ? days + 'd' : 'Flex'} · ${apy.total.toFixed(1)}% APY · ${comp} compound · ${commissions.length}-gen referral`,
        `-${fixedAmt.toFixed(2)} OLIGHFT`, 'red');

      return { stakeId, amount: fixedAmt, apy: apy.total, estimatedReward, adminShare, refShare, commissions, reserved: supplyResult.deducted };
    });

    const result = txn();
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('Stake error:', e.message);
    res.status(500).json({ error: 'Staking failed' });
  }
});

// GET /api/stakes — get user's stakes
app.get('/api/stakes', authMiddleware, (req, res) => {
  const stakes = stmts.getStakesByUser.all(req.userId);
  res.json(stakes);
});

// POST /api/stake/:id/compound — compound a stake
app.post('/api/stake/:id/compound', authMiddleware, (req, res) => {
  try {
    const stake = stmts.getStakeById.get(req.params.id);
    if (!stake) return res.status(404).json({ error: 'Stake not found' });
    if (stake.user_id !== req.userId) return res.status(403).json({ error: 'Not your stake' });
    if (stake.withdrawn) return res.status(400).json({ error: 'Already withdrawn' });

    const comp = stake.compound_type;
    if (!comp || comp === 'none') return res.status(400).json({ error: 'No compound set' });

    // Check if compound is ready
    const now = Date.now();
    const lastTs = stake.last_compound || stake.start_date;
    const elapsed = (now - lastTs) / 86400000;
    if (elapsed <= 0) return res.status(400).json({ error: 'Nothing to compound yet' });

    const minInterval = comp === 'daily' ? 1 : comp === 'weekly' ? 7 : 30;
    if (elapsed < minInterval * 0.95) {
      return res.status(400).json({ error: `Compound not ready. ${(minInterval - elapsed).toFixed(1)} days remaining` });
    }

    // Calculate accrued
    let accrued = 0;
    const tier = stake.card_tier && CARD_TIERS[stake.card_tier] ? CARD_TIERS[stake.card_tier] : null;
    if (tier) {
      accrued = tier.daily * elapsed;
    } else if (stake.apy) {
      accrued = stake.amount * (stake.apy / 100) * (elapsed / 365);
    } else {
      accrued = (stake.daily_reward || 0) * elapsed;
    }
    if (accrued <= 0) return res.status(400).json({ error: 'No rewards to compound' });

    const compBoostRate = comp === 'daily' ? 0.024 : comp === 'weekly' ? 0.012 : 0.005;
    const grossBoost = accrued * compBoostRate;
    const adminFee = grossBoost * COMPOUND_FEE_RATE;
    const netBoost = grossBoost - adminFee;

    const txn = db.transaction(() => {
      // Deduct compound reward from supply
      deductFromSupply(accrued + netBoost, 'compound_reward', stake.id);

      // Update stake
      const newAmount = stake.amount + accrued + netBoost;
      stmts.updateStakeCompound.run(newAmount, now, accrued + netBoost, stake.id);

      // Admin fee
      if (adminFee > 0) {
        depositToAdmin(adminFee, 'compound_fee', stake.id);
      }

      logActivity(req.userId, 'Compounded', '🔄',
        `Compounded ${accrued.toFixed(4)} OLIGHFT + ${netBoost.toFixed(4)} boost (fee: ${adminFee.toFixed(4)})`,
        `+${(accrued + netBoost).toFixed(4)} OLIGHFT`, 'green');

      return { stakeId: stake.id, accrued, boost: netBoost, fee: adminFee, newPrincipal: newAmount };
    });

    res.json({ success: true, ...txn() });
  } catch (e) {
    console.error('Compound error:', e.message);
    res.status(500).json({ error: 'Compound failed' });
  }
});

// POST /api/stake/:id/compound-all — compound all eligible stakes
app.post('/api/stakes/compound-all', authMiddleware, (req, res) => {
  try {
    const stakes = stmts.getActiveStakes.all(req.userId, 'active');
    const now = Date.now();
    const results = [];

    for (const s of stakes) {
      if (s.withdrawn || !s.compound_type || s.compound_type === 'none') continue;
      const elapsed = (now - (s.last_compound || s.start_date)) / 86400000;
      const minInterval = s.compound_type === 'daily' ? 1 : s.compound_type === 'weekly' ? 7 : 30;
      if (elapsed < minInterval * 0.95) continue;

      let accrued = 0;
      const tier = s.card_tier && CARD_TIERS[s.card_tier] ? CARD_TIERS[s.card_tier] : null;
      if (tier) accrued = tier.daily * elapsed;
      else if (s.apy) accrued = s.amount * (s.apy / 100) * (elapsed / 365);
      else accrued = (s.daily_reward || 0) * elapsed;
      if (accrued <= 0) continue;

      const compBoostRate = s.compound_type === 'daily' ? 0.024 : s.compound_type === 'weekly' ? 0.012 : 0.005;
      const grossBoost = accrued * compBoostRate;
      const adminFee = grossBoost * COMPOUND_FEE_RATE;
      const netBoost = grossBoost - adminFee;

      const txn = db.transaction(() => {
        deductFromSupply(accrued + netBoost, 'compound_reward', s.id);
        const newAmt = s.amount + accrued + netBoost;
        stmts.updateStakeCompound.run(newAmt, now, accrued + netBoost, s.id);
        if (adminFee > 0) depositToAdmin(adminFee, 'compound_fee', s.id);
        return { stakeId: s.id, accrued, boost: netBoost, fee: adminFee, newPrincipal: newAmt };
      });
      results.push(txn());
    }

    res.json({ success: true, compounded: results.length, results });
  } catch (e) {
    console.error('CompoundAll error:', e.message);
    res.status(500).json({ error: 'Compound-all failed' });
  }
});

// POST /api/stake/:id/withdraw
app.post('/api/stake/:id/withdraw', authMiddleware, (req, res) => {
  try {
    const stake = stmts.getStakeById.get(req.params.id);
    if (!stake) return res.status(404).json({ error: 'Stake not found' });
    if (stake.user_id !== req.userId) return res.status(403).json({ error: 'Not your stake' });
    if (stake.withdrawn) return res.status(400).json({ error: 'Already withdrawn' });

    // Block manual withdraw for card stakes — auto-withdraw only
    if (stake.card_tier && CARD_TIERS[stake.card_tier]) {
      return res.status(400).json({ error: 'Card stakes are auto-withdrawn at maturity. Manual withdraw is not allowed.' });
    }

    const now = Date.now();
    if (stake.end_date && now < stake.end_date) {
      const daysLeft = Math.ceil((stake.end_date - now) / 86400000);
      return res.status(400).json({ error: `Stake locked! ${daysLeft} days remaining` });
    }

    // Calculate final accrued (use full lock period for reward)
    const lastTs = stake.last_compound || stake.start_date;
    const elapsed = stake.lock_days > 0 ? stake.lock_days : (now - lastTs) / 86400000;
    let accrued = 0;
    const tier = stake.card_tier && CARD_TIERS[stake.card_tier] ? CARD_TIERS[stake.card_tier] : null;
    if (tier) {
      accrued = calcCardDailyCompound(tier.daily, elapsed, stake.compound_type);
    } else if (stake.compound_type && stake.compound_type !== 'none' && stake.apy) {
      accrued = stake.amount * (stake.apy / 100) * (elapsed / 365);
    } else {
      accrued = (stake.daily_reward || 0) * elapsed;
    }

    const totalReturn = stake.amount + (stake.reward || 0) + accrued;
    const rewardPortion = (stake.reward || 0) + accrued;

    // Supply reconciliation
    const reservedAmt = stake.reserved_from_supply || 0;
    if (rewardPortion > reservedAmt) {
      deductFromSupply(rewardPortion - reservedAmt, 'extra_reward', stake.id);
    } else if (rewardPortion < reservedAmt) {
      returnToSupply(reservedAmt - rewardPortion, stake.id);
    }

    // 30% service fee at withdrawal
    const feeAmt = totalReturn * WITHDRAWAL_FEE_RATE;
    const netReturn = totalReturn - feeAmt;

    const txn = db.transaction(() => {
      depositToAdmin(feeAmt, 'service_fee', stake.id);
      stmts.addBalance.run(req.userId, stake.asset || 'OLIGHFT', netReturn);
      stmts.withdrawStake.run('withdrawn', now, rewardPortion, stake.id);

      logActivity(req.userId, 'Unstaked', '💰',
        `Withdrew ${netReturn.toFixed(2)} ${stake.asset || 'OLIGHFT'} (reward: ${rewardPortion.toFixed(2)} from supply)`,
        `+${netReturn.toFixed(2)} ${stake.asset || 'OLIGHFT'}`, 'green');

      return { stakeId: stake.id, gross: totalReturn, fee: feeAmt, net: netReturn, reward: rewardPortion };
    });

    res.json({ success: true, ...txn() });
  } catch (e) {
    console.error('Withdraw error:', e.message);
    res.status(500).json({ error: 'Withdrawal failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-WITHDRAW & AUTO-COMPOUND (runs server-side on interval)
// ═══════════════════════════════════════════════════════════════════════════
function autoProcessStakes() {
  const now = Date.now();
  const allActive = stmts.getAllActiveStakes.all('active');

  for (const s of allActive) {
    // Auto-compound
    if (s.compound_type && s.compound_type !== 'none') {
      const elapsed = (now - (s.last_compound || s.start_date)) / 86400000;
      const minInterval = s.compound_type === 'daily' ? 1 : s.compound_type === 'weekly' ? 7 : 30;
      if (elapsed >= minInterval) {
        try {
          let accrued = 0;
          const tier = s.card_tier && CARD_TIERS[s.card_tier] ? CARD_TIERS[s.card_tier] : null;
          if (tier) accrued = tier.daily * elapsed;
          else if (s.apy) accrued = s.amount * (s.apy / 100) * (elapsed / 365);
          else accrued = (s.daily_reward || 0) * elapsed;

          if (accrued > 0) {
            const compBoostRate = s.compound_type === 'daily' ? 0.024 : s.compound_type === 'weekly' ? 0.012 : 0.005;
            const grossBoost = accrued * compBoostRate;
            const adminFee = grossBoost * COMPOUND_FEE_RATE;
            const netBoost = grossBoost - adminFee;

            db.transaction(() => {
              deductFromSupply(accrued + netBoost, 'compound_reward', s.id);
              stmts.updateStakeCompound.run(s.amount + accrued + netBoost, now, accrued + netBoost, s.id);
              if (adminFee > 0) depositToAdmin(adminFee, 'compound_fee', s.id);
            })();
          }
        } catch (e) { console.error('Auto-compound error:', s.id, e.message); }
      }
    }

    // Auto-withdraw matured
    if (s.end_date && now >= s.end_date) {
      try {
        const lastTs = s.last_compound || s.start_date;
        const elapsed = s.lock_days > 0 ? s.lock_days : (now - lastTs) / 86400000;
        let accrued = 0;
        const tier = s.card_tier && CARD_TIERS[s.card_tier] ? CARD_TIERS[s.card_tier] : null;
        if (tier) accrued = calcCardDailyCompound(tier.daily, elapsed, s.compound_type);
        else if (s.apy) accrued = s.amount * (s.apy / 100) * (elapsed / 365);
        else accrued = (s.daily_reward || 0) * elapsed;

        const gross = s.amount + (s.reward || 0) + accrued;
        const rewardPortion = (s.reward || 0) + accrued;
        const reservedAmt = s.reserved_from_supply || 0;

        db.transaction(() => {
          if (rewardPortion > reservedAmt) deductFromSupply(rewardPortion - reservedAmt, 'extra_reward_auto', s.id);
          else if (rewardPortion < reservedAmt) returnToSupply(reservedAmt - rewardPortion, s.id);

          const fee = gross * WITHDRAWAL_FEE_RATE;
          const net = gross - fee;
          depositToAdmin(fee, 'service_fee_auto', s.id);
          stmts.addBalance.run(s.user_id, s.asset || 'OLIGHFT', net);
          stmts.withdrawStake.run('withdrawn', now, rewardPortion, s.id);
          logActivity(s.user_id, 'Auto-Withdraw', '💰', `Auto-withdrew ${net.toFixed(2)} ${s.asset || 'OLIGHFT'} (period completed)`, `+${net.toFixed(2)} ${s.asset || 'OLIGHFT'}`, 'green');
        })();
      } catch (e) { console.error('Auto-withdraw error:', s.id, e.message); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLY & PRICE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/supply
app.get('/api/supply', (req, res) => {
  const remaining = getSupplyPool();
  const info = getLiquidityInfo();
  res.json({
    totalSupply: OLIGHFT_TOTAL_SUPPLY,
    remaining,
    reserved: OLIGHFT_TOTAL_SUPPLY - remaining,
    ...info
  });
});

// GET /api/price
app.get('/api/price', (req, res) => {
  const price = calcOLIGHFTPrice();
  const info = getLiquidityInfo();
  res.json({ price, ...info });
});

// GET /api/price/history?range=1D
app.get('/api/price/history', (req, res) => {
  const range = req.query.range || '1D';
  const now = Date.now();
  let cutoff = 0;
  if (range === '1H') cutoff = now - 3600000;
  else if (range === '6H') cutoff = now - 21600000;
  else if (range === '1D') cutoff = now - 86400000;
  else if (range === '7D') cutoff = now - 604800000;
  else if (range === '30D') cutoff = now - 2592000000;
  // else ALL

  const rows = stmts.getPriceHistory.all(cutoff);
  const price = calcOLIGHFTPrice();

  // 24h high/low
  const last24 = stmts.getPriceHistory.all(now - 86400000);
  let high24 = price, low24 = price;
  for (const r of last24) {
    if (r.price > high24) high24 = r.price;
    if (r.price < low24) low24 = r.price;
  }

  res.json({ history: rows, current: price, high24, low24, stakingRatio: getLiquidityInfo().stakingRatio });
});

// Record price point (called by interval)
function recordPricePoint() {
  const price = calcOLIGHFTPrice();
  const info = getLiquidityInfo();
  stmts.insertPrice.run(price, info.totalStaked, info.circulating, info.reserved, getSupplyPool());
}

// ═══════════════════════════════════════════════════════════════════════════
// 8-GEN COMMISSION ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/commissions — get sponsor's earned commissions
app.get('/api/commissions', authMiddleware, (req, res) => {
  const comms = stmts.getGenBySponsor.all(req.userId);
  const total = comms.reduce((s, c) => s + c.amount, 0);
  const totalUsd = comms.reduce((s, c) => s + c.usd, 0);
  const byGen = {};
  for (const c of comms) {
    if (!byGen[c.gen]) byGen[c.gen] = { count: 0, amount: 0, usd: 0 };
    byGen[c.gen].count++;
    byGen[c.gen].amount += c.amount;
    byGen[c.gen].usd += c.usd;
  }
  res.json({ total, totalUsd, byGen, commissions: comms });
});

// GET /api/referrals — get invite tree
app.get('/api/referrals', authMiddleware, (req, res) => {
  const invitees = stmts.getInvitees.all(req.userId);
  const details = invitees.map(i => {
    const u = stmts.getUserById.get(i.invitee_id);
    return { id: u.id, username: u.username, email: u.email, name: u.name, created_at: u.created_at };
  });
  res.json({ count: details.length, invitees: details });
});

// ═══════════════════════════════════════════════════════════════════════════
// SWAP ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN_PRICES = { XLM: 0.12, USDC: 1, wETH: 3200, wBTC: 68000, EURC: 1.08, OLIGHFT: 0.50, PI: 0.71 };
const POOL_REGISTRY = {
  'XLM/USDC':     { currency0: 'XLM', currency1: 'USDC', fee: 3000, reserve0: 5000000, reserve1: 600000 },
  'XLM/OLIGHFT':  { currency0: 'XLM', currency1: 'OLIGHFT', fee: 3000, reserve0: 2000000, reserve1: 480000 },
  'USDC/OLIGHFT': { currency0: 'USDC', currency1: 'OLIGHFT', fee: 500, reserve0: 500000, reserve1: 1000000 },
  'USDC/EURC':    { currency0: 'USDC', currency1: 'EURC', fee: 100, reserve0: 2000000, reserve1: 1851852 },
  'wETH/USDC':    { currency0: 'wETH', currency1: 'USDC', fee: 3000, reserve0: 500, reserve1: 1600000 },
  'wBTC/USDC':    { currency0: 'wBTC', currency1: 'USDC', fee: 3000, reserve0: 25, reserve1: 1700000 },
  'wETH/OLIGHFT': { currency0: 'wETH', currency1: 'OLIGHFT', fee: 3000, reserve0: 200, reserve1: 1280000 },
  'wBTC/OLIGHFT': { currency0: 'wBTC', currency1: 'OLIGHFT', fee: 3000, reserve0: 10, reserve1: 1360000 },
  'PI/USDC':      { currency0: 'PI', currency1: 'USDC', fee: 3000, reserve0: 1500000, reserve1: 1065000 },
  'PI/OLIGHFT':   { currency0: 'PI', currency1: 'OLIGHFT', fee: 3000, reserve0: 800000, reserve1: 1136000 },
  'PI/XLM':       { currency0: 'PI', currency1: 'XLM', fee: 3000, reserve0: 1000000, reserve1: 5916667 },
  'BNB/USDC':     { currency0: 'BNB', currency1: 'USDC', fee: 3000, reserve0: 2500, reserve1: 1495000 },
  'BNB/OLIGHFT':  { currency0: 'BNB', currency1: 'OLIGHFT', fee: 3000, reserve0: 1500, reserve1: 1794000 },
  'BNB/XLM':      { currency0: 'BNB', currency1: 'XLM', fee: 3000, reserve0: 2000, reserve1: 9966667 }
};

function findPool(a, b) {
  return POOL_REGISTRY[a + '/' + b] || POOL_REGISTRY[b + '/' + a] || null;
}

function quoteSwap(tokenIn, tokenOut, amountIn) {
  let pool = findPool(tokenIn, tokenOut);
  let route = [tokenIn, tokenOut];

  // Multi-hop via USDC
  if (!pool && tokenIn !== 'USDC' && tokenOut !== 'USDC') {
    const poolA = findPool(tokenIn, 'USDC');
    const poolB = findPool('USDC', tokenOut);
    if (poolA && poolB) {
      const hop1 = quoteSinglePool(poolA, tokenIn, 'USDC', amountIn);
      const hop2 = quoteSinglePool(poolB, 'USDC', tokenOut, hop1.amountOut);
      return {
        amountOut: hop2.amountOut,
        fee: hop1.fee + hop2.fee,
        rate: hop2.amountOut / amountIn,
        route: [tokenIn, 'USDC', tokenOut],
        hops: 2
      };
    }
    return null;
  }
  if (!pool) return null;

  const result = quoteSinglePool(pool, tokenIn, tokenOut, amountIn);
  return { ...result, route, hops: 1 };
}

function quoteSinglePool(pool, tokenIn, tokenOut, amountIn) {
  const zeroForOne = tokenIn === pool.currency0;
  const reserveIn = zeroForOne ? pool.reserve0 : pool.reserve1;
  const reserveOut = zeroForOne ? pool.reserve1 : pool.reserve0;
  const feeRate = pool.fee / 1000000;
  const amountInAfterFee = amountIn * (1 - feeRate);
  const feeAmount = amountIn * feeRate;
  const amountOut = (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);
  return { amountOut, fee: feeAmount, rate: amountOut / amountIn };
}

// GET /api/swap/quote?tokenIn=XLM&tokenOut=USDC&amount=100
app.get('/api/swap/quote', (req, res) => {
  const { tokenIn, tokenOut, amount } = req.query;
  if (!tokenIn || !tokenOut || !amount) return res.status(400).json({ error: 'tokenIn, tokenOut, amount required' });
  const quote = quoteSwap(tokenIn, tokenOut, parseFloat(amount));
  if (!quote) return res.status(400).json({ error: 'No pool found for this pair' });
  res.json(quote);
});

// POST /api/swap/execute
app.post('/api/swap/execute', authMiddleware, (req, res) => {
  try {
    const { tokenIn, tokenOut, amountIn, minAmountOut } = req.body;
    if (!tokenIn || !tokenOut || !amountIn) return res.status(400).json({ error: 'Invalid swap params' });

    const bals = getUserBalances(req.userId);
    if ((bals[tokenIn] || 0) < amountIn) return res.status(400).json({ error: 'Insufficient balance' });

    const quote = quoteSwap(tokenIn, tokenOut, amountIn);
    if (!quote) return res.status(400).json({ error: 'No pool found' });
    if (minAmountOut && quote.amountOut < minAmountOut) return res.status(400).json({ error: 'Slippage exceeded' });

    const txn = db.transaction(() => {
      stmts.addBalance.run(req.userId, tokenIn, -amountIn);
      stmts.addBalance.run(req.userId, tokenOut, quote.amountOut);

      // Update pool reserves
      const poolKey = Object.keys(POOL_REGISTRY).find(k => findPool(tokenIn, tokenOut) === POOL_REGISTRY[k]);
      if (poolKey) {
        const pool = POOL_REGISTRY[poolKey];
        const zf = tokenIn === pool.currency0;
        if (zf) {
          pool.reserve0 += amountIn * (1 - pool.fee / 1000000);
          pool.reserve1 -= quote.amountOut;
        } else {
          pool.reserve1 += amountIn * (1 - pool.fee / 1000000);
          pool.reserve0 -= quote.amountOut;
        }
      }

      stmts.insertSwap.run(req.userId, tokenIn, tokenOut, amountIn, quote.amountOut, quote.fee, quote.rate);

      logActivity(req.userId, 'Swapped', '🔄',
        `Swapped ${amountIn} ${tokenIn} → ${quote.amountOut.toFixed(4)} ${tokenOut}`,
        `${amountIn} ${tokenIn} → ${quote.amountOut.toFixed(4)} ${tokenOut}`, 'green');

      return { amountIn, tokenIn, amountOut: quote.amountOut, tokenOut, rate: quote.rate, fee: quote.fee };
    });

    res.json({ success: true, ...txn() });
  } catch (e) {
    console.error('Swap error:', e.message);
    res.status(500).json({ error: 'Swap failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ESCROW ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/escrow/create
app.post('/api/escrow/create', authMiddleware, (req, res) => {
  try {
    const { sellerAddr, arbiterAddr, amount, deadlineDays, description } = req.body;
    if (!sellerAddr || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid params' });

    const bals = getUserBalances(req.userId);
    if ((bals.OLIGHFT || 0) < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const escrowId = genId('esc');
    const deadline = deadlineDays ? Date.now() + deadlineDays * 86400000 : null;

    const txn = db.transaction(() => {
      stmts.addBalance.run(req.userId, 'OLIGHFT', -amount);
      stmts.insertEscrow.run(escrowId, req.userId, sellerAddr, arbiterAddr || null, amount, deadline, description || '');
      logActivity(req.userId, 'Escrow Created', '🔒', `Escrowed ${amount} OLIGHFT`, `-${amount} OLIGHFT`, 'red');
      return escrowId;
    });

    res.json({ success: true, escrowId: txn() });
  } catch (e) {
    console.error('Escrow error:', e.message);
    res.status(500).json({ error: 'Escrow creation failed' });
  }
});

// POST /api/escrow/:id/release
app.post('/api/escrow/:id/release', authMiddleware, (req, res) => {
  try {
    const escrow = stmts.getEscrowById.get(req.params.id);
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });
    if (escrow.buyer_id !== req.userId) return res.status(403).json({ error: 'Not authorized' });
    if (escrow.status !== 'pending' && escrow.status !== 'funded') return res.status(400).json({ error: 'Cannot release' });

    // Find seller user
    const sellerReg = db.prepare('SELECT lookup_key FROM wallet_registry WHERE addr = ? LIMIT 1').get(escrow.seller_addr);
    let sellerId = null;
    if (sellerReg) {
      const seller = stmts.getUserByEmail.get(sellerReg.lookup_key) || stmts.getUserByUsername.get(sellerReg.lookup_key);
      if (seller) sellerId = seller.id;
    }

    const txn = db.transaction(() => {
      if (sellerId) stmts.addBalance.run(sellerId, 'OLIGHFT', escrow.amount);
      stmts.updateEscrowStatus.run('completed', Date.now(), escrow.id);
      logActivity(req.userId, 'Escrow Released', '✅', `Released ${escrow.amount} OLIGHFT to seller`, '', 'green');
    });
    txn();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Release failed' });
  }
});

// POST /api/escrow/:id/cancel
app.post('/api/escrow/:id/cancel', authMiddleware, (req, res) => {
  try {
    const escrow = stmts.getEscrowById.get(req.params.id);
    if (!escrow) return res.status(404).json({ error: 'Escrow not found' });
    if (escrow.buyer_id !== req.userId) return res.status(403).json({ error: 'Not authorized' });
    if (escrow.status !== 'pending') return res.status(400).json({ error: 'Can only cancel pending escrows' });

    const txn = db.transaction(() => {
      stmts.addBalance.run(req.userId, 'OLIGHFT', escrow.amount);
      stmts.updateEscrowStatus.run('cancelled', Date.now(), escrow.id);
      logActivity(req.userId, 'Escrow Cancelled', '❌', `Refunded ${escrow.amount} OLIGHFT`, `+${escrow.amount} OLIGHFT`, 'green');
    });
    txn();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Cancel failed' });
  }
});

// GET /api/escrows
app.get('/api/escrows', authMiddleware, (req, res) => {
  res.json(stmts.getEscrowsByBuyer.all(req.userId));
});

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVITY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/activity
app.get('/api/activity', authMiddleware, (req, res) => {
  res.json(stmts.getActivity.all(req.userId));
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/admin/staking-summary — aggregated staking stats across ALL users
app.get('/api/admin/staking-summary', adminMiddleware, (req, res) => {
  try {
    const allStakes = db.prepare('SELECT s.*, u.username, u.email, u.name AS user_name FROM stakes s LEFT JOIN users u ON s.user_id = u.id ORDER BY s.start_date DESC').all();
    let totalStakes = allStakes.length;
    let activeStakes = 0, withdrawnStakes = 0;
    let totalStakedValue = 0, expectedPayout = 0, totalFees = 0, totalOlighftPaidIn = 0;
    const now = Date.now();

    const records = allStakes.map(s => {
      const amount = s.amount || 0;
      const usdVal = amount * 0.50;
      totalStakedValue += usdVal;
      totalOlighftPaidIn += amount;
      totalFees += (s.admin_share || 0) * 0.50;
      expectedPayout += (s.estimated_total_reward || 0) * 0.50;

      if (s.withdrawn) {
        withdrawnStakes++;
      } else if (s.status === 'active') {
        activeStakes++;
      }

      return {
        id: s.id,
        user: s.user_name || s.username || s.email || 'Unknown',
        email: s.email || '',
        asset: s.asset,
        amount: amount,
        usd: usdVal,
        apy: s.apy,
        cardTier: s.card_tier || '—',
        lockDays: s.lock_days,
        startDate: s.start_date,
        endDate: s.end_date,
        status: s.withdrawn ? 'withdrawn' : s.status,
        reward: s.reward || 0,
        estimatedReward: s.estimated_total_reward || 0,
        compoundCount: s.compound_count || 0,
        adminShare: s.admin_share || 0,
        refShare: s.ref_share || 0,
        withdrawnAt: s.withdrawn_at || null,
        txHash: s.tx_hash || null
      };
    });

    // Gen commissions summary
    const genTotal = db.prepare('SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM gen_commissions').get();
    // Admin deposits summary
    const depTotal = db.prepare('SELECT COALESCE(SUM(usd),0) as totalUsd, COALESCE(SUM(amount),0) as totalOli, COUNT(*) as count FROM admin_deposits').get();

    res.json({
      summary: {
        totalStakes,
        activeStakes,
        withdrawnStakes,
        totalStakedValue,
        expectedPayout,
        totalFees,
        totalOlighftPaidIn,
        genCommissionsTotal: genTotal.total,
        genCommissionsCount: genTotal.count,
        adminDepositsUsd: depTotal.totalUsd,
        adminDepositsOli: depTotal.totalOli,
        adminDepositsCount: depTotal.count
      },
      records
    });
  } catch (e) {
    console.error('[ADMIN] staking-summary error:', e);
    res.status(500).json({ error: 'Failed to load staking summary' });
  }
});

// GET /api/admin/deposits
app.get('/api/admin/deposits', adminMiddleware, (req, res) => {
  const deposits = stmts.getAdminDeposits.all();
  const total = stmts.getAdminTotal.get().total;
  res.json({ total, deposits });
});

// GET /api/admin/users — list all registered users with stake counts
app.get('/api/admin/users', adminMiddleware, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.email, u.username, u.name, u.created_at, u.last_login,
             COALESCE(sp.username, sp.name, '') AS sponsor,
             (SELECT COUNT(*) FROM stakes s WHERE s.user_id = u.id) AS stake_count,
             (SELECT COALESCE(SUM(s.amount), 0) FROM stakes s WHERE s.user_id = u.id) AS total_staked
      FROM users u
      LEFT JOIN users sp ON u.sponsor_id = sp.id
      ORDER BY u.created_at DESC
    `).all();
    res.json({ total: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/supply-log
app.get('/api/admin/supply-log', adminMiddleware, (req, res) => {
  const logs = db.prepare('SELECT * FROM supply_log ORDER BY created_at DESC LIMIT 200').all();
  res.json(logs);
});

// ═══════════════════════════════════════════════════════════════════════════
// WALLET LOOKUP
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/wallet/lookup?key=username_or_email
app.get('/api/wallet/lookup', (req, res) => {
  const key = (req.query.key || '').toLowerCase();
  if (!key) return res.status(400).json({ error: 'Key required' });
  const row = stmts.lookupWallet.get(key);
  res.json({ addr: row ? row.addr : null });
});

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC PLATFORM STATS
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/stats/public', (req, res) => {
  try {
    const totalUsers = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const activeStakes = db.prepare("SELECT COUNT(*) AS count FROM stakes WHERE status = 'active'").get().count;
    const totalStaked = db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM stakes WHERE status = 'active'").get().total;
    res.json({ totalUsers, activeStakes, totalStaked, timestamp: Date.now() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/stats/users — full registered user list (admin only)
app.get('/api/stats/users', adminMiddleware, (req, res) => {
  try {
    const users = db.prepare(`
      SELECT u.id, u.email, u.username, u.name, u.created_at,
             u.last_login, u.addr,
             COALESCE(sp.username, sp.name, '') AS sponsor,
             (SELECT COUNT(*) FROM stakes s WHERE s.user_id = u.id AND s.status = 'active') AS active_stakes,
             (SELECT COALESCE(SUM(s.amount), 0) FROM stakes s WHERE s.user_id = u.id AND s.status = 'active') AS total_staked
      FROM users u
      LEFT JOIN users sp ON u.sponsor_id = sp.id
      ORDER BY u.created_at DESC
    `).all();
    res.json({ total: users.length, users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    price: OLIGHFT_PRICE_VAR.current,
    supply: getSupplyPool(),
    stakes: stmts.getAllActiveStakes.all('active').length,
    timestamp: Date.now()
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// START SERVER & TIMERS
// ═══════════════════════════════════════════════════════════════════════════

// Seed initial price history if empty
function seedPriceHistory() {
  const latest = stmts.getLatestPrice.get();
  if (latest) return;

  const now = Date.now();
  for (let i = 288; i >= 0; i--) {
    const t = now - (i * 300000);
    const jitter = (Math.random() - 0.45) * 0.008;
    const trend = (288 - i) / 288 * 0.02;
    const p = parseFloat((OLIGHFT_BASE_PRICE_FLOOR * (1 + trend + jitter)).toFixed(6));
    db.prepare('INSERT INTO price_history (price, staked, circulating, reserved, supply, created_at) VALUES (?, 0, ?, 0, ?, ?)').run(p, OLIGHFT_TOTAL_SUPPLY, OLIGHFT_TOTAL_SUPPLY, t);
  }
  console.log('[SEED] Price history seeded with 289 data points');
}

// ── Start HTTP server ──
app.listen(PORT, () => {
  console.log(`\n  ╔════════════════════════════════════════════════╗`);
  console.log(`  ║  OLIGHFT SMART COIN — Backend Server           ║`);
  console.log(`  ║  Port: ${PORT}                                    ║`);
  console.log(`  ║  DB:   ${DB_PATH}  ║`);
  console.log(`  ╚════════════════════════════════════════════════╝\n`);

  // Init
  calcOLIGHFTPrice();
  seedPriceHistory();

  // Price recording every 60s
  setInterval(() => {
    try { recordPricePoint(); } catch (e) { console.error('Price record error:', e.message); }
  }, 60000);

  // Auto-compound & auto-withdraw every 60s
  setInterval(() => {
    try { autoProcessStakes(); } catch (e) { console.error('AutoProcess error:', e.message); }
  }, 60000);

  console.log(`  [✓] Price tracker started (60s interval)`);
  console.log(`  [✓] Auto-compound & auto-withdraw started (60s interval)`);
  console.log(`  [✓] Supply pool: ${getSupplyPool().toLocaleString()} OLIGHFT`);
  console.log(`  [✓] Current price: $${OLIGHFT_PRICE_VAR.current}`);
});

// ── Start HTTPS server ──
// Priority: 1) Let's Encrypt certs  2) Self-signed certs  3) Skip HTTPS
const HTTPS_PORT = parseInt(process.env.OLIGHFT_HTTPS_PORT) || (PORT + 1);
const LE_CERT = '/etc/letsencrypt/live/olighftcoin.com/fullchain.pem';
const LE_KEY  = '/etc/letsencrypt/live/olighftcoin.com/privkey.pem';
const SELF_CERT = path.join(__dirname, 'server.cert');
const SELF_KEY  = path.join(__dirname, 'server.key');

let sslOpts = null;
if (fs.existsSync(LE_KEY) && fs.existsSync(LE_CERT)) {
  sslOpts = { key: fs.readFileSync(LE_KEY), cert: fs.readFileSync(LE_CERT) };
  console.log(`  [✓] Using Let's Encrypt SSL certs`);
} else if (fs.existsSync(SELF_KEY) && fs.existsSync(SELF_CERT)) {
  sslOpts = { key: fs.readFileSync(SELF_KEY), cert: fs.readFileSync(SELF_CERT) };
  console.log(`  [!] Using self-signed SSL certs (browsers will warn)`);
}

if (sslOpts) {
  https.createServer(sslOpts, app).listen(HTTPS_PORT, () => {
    console.log(`  [✓] HTTPS server on port ${HTTPS_PORT}`);
  });
} else {
  console.log(`  [!] No SSL certs found, HTTPS disabled. Install certbot:`);
  console.log(`      certbot certonly --standalone -d olighftcoin.com`);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
