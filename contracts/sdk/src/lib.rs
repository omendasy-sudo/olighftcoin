#![no_std]
//! **olighft-sdk** — `std` substitute for OLIGHFT smart contracts.
//!
//! Re-exports core Soroban primitives and adds project-specific helpers for:
//! - Data structures (common types, error scaffolding)
//! - Utility functions (basis-point math, checked arithmetic, integer sqrt)
//! - Cryptographic hashing (SHA-256 / Keccak-256 via the Soroban host)
//! - Signature / authorisation verification
//! - Persistent storage access (typed get/set/has/remove across storage tiers)
//! - Contract invocation via stable identifiers

// ────────────────────────────────────────────
// Re-exports — one-stop import for every contract
// ────────────────────────────────────────────
pub use soroban_sdk::{
    self, contract, contracterror, contractimpl, contracttype,
    token, Address, Bytes, BytesN, Env, IntoVal, Map, String, Symbol, Val, Vec,
    log,
};
pub use soroban_token_sdk;

// ────────────────────────────────────────────
// Sub-modules
// ────────────────────────────────────────────
pub mod types;
pub mod math;
pub mod crypto;
pub mod auth;
pub mod storage;
pub mod invoke;

// Convenience re-exports so callers can do `use olighft_sdk::*;`
pub use types::*;
pub use math::*;
pub use crypto::*;
pub use auth::*;
pub use storage::*;
pub use invoke::*;
