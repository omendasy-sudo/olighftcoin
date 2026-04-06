//! Common data-structure helpers and project-wide constants.

// ── Ledger-time constants ──────────────────────────────────────────
/// Average ledgers per day (~5 s / ledger).
pub const LEDGERS_PER_DAY: u32 = 17_280;
/// Average ledgers per hour.
pub const LEDGERS_PER_HOUR: u32 = 720;

// ── Basis-point scale ──────────────────────────────────────────────
/// 100 % expressed in basis points.
pub const BPS_SCALE: i128 = 10_000;

// ── Rate / oracle scale ────────────────────────────────────────────
/// 1.0 expressed in the oracle rate format (1e7).
pub const RATE_SCALE: i128 = 10_000_000;

// ── Batch limits ───────────────────────────────────────────────────
pub const MAX_BATCH: u32 = 50;

// ── Max generations for referral trees ─────────────────────────────
pub const MAX_GENERATIONS: u32 = 8;
