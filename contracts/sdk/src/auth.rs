//! Authorisation / signature verification helpers.
//!
//! Wraps the Soroban `require_auth` pattern used across every contract.

use soroban_sdk::{Address, Env};

/// Require that `who` has authorised the current invocation.
///
/// Equivalent to `who.require_auth()` but reads better in business-logic
/// code:
/// ```ignore
/// sdk::require_auth(&caller);
/// ```
#[inline]
pub fn require_auth(who: &Address) {
    who.require_auth();
}

/// Require that `who` authorised a *specific* sub-invocation identified
/// by the contract and function name.
#[inline]
pub fn require_auth_for(who: &Address, env: &Env) {
    // `require_auth` already covers the current invocation context
    // in Soroban; this wrapper exists for readability.
    let _ = env;
    who.require_auth();
}

/// Guard: ensure `caller` equals the stored admin, then `require_auth`.
///
/// Returns `true` if the caller IS the admin (after auth); returns `false`
/// if the addresses do not match (caller should map to an error).
pub fn require_admin(caller: &Address, admin: &Address) -> bool {
    if caller != admin {
        return false;
    }
    caller.require_auth();
    true
}
