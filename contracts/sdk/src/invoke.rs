//! Cross-contract invocation via **stable identifiers**.
//!
//! Instead of hard-coding contract addresses, callers store an `Address` for
//! each external contract (e.g. saved in instance storage under a well-known
//! symbol) and call through this module.  The helpers construct the
//! appropriate Soroban client on the fly.

use soroban_sdk::{token, Address, Env, IntoVal, Symbol, Val, Vec};

// ── Token client shorthand ─────────────────────────────────────────

/// Build a Stellar-Asset / SEP-41 token client from a contract address.
#[inline]
pub fn token_client<'a>(env: &'a Env, token_addr: &Address) -> token::Client<'a> {
    token::Client::new(env, token_addr)
}

/// One-liner: transfer `amount` of `token_addr` from `from` → `to`.
pub fn transfer(
    env: &Env,
    token_addr: &Address,
    from: &Address,
    to: &Address,
    amount: &i128,
) {
    token_client(env, token_addr).transfer(from, to, amount);
}

// ── Generic contract invocation ────────────────────────────────────

/// Invoke an arbitrary function on a contract identified by `contract_id`.
///
/// ```ignore
/// let result: i128 = invoke(
///     &env,
///     &staking_contract_addr,
///     &Symbol::new(&env, "pending_rewards"),
///     args,
/// );
/// ```
pub fn invoke<T>(env: &Env, contract_id: &Address, func: &Symbol, args: Vec<Val>) -> T
where
    T: soroban_sdk::TryFromVal<Env, Val>,
{
    env.invoke_contract(contract_id, func, args)
}

/// Fire-and-forget invocation (return value discarded).
pub fn invoke_void(env: &Env, contract_id: &Address, func: &Symbol, args: Vec<Val>) {
    let _: Val = env.invoke_contract(contract_id, func, args);
}

// ── Stable-identifier registry pattern ─────────────────────────────

/// Well-known symbol keys for external contract addresses stored in
/// instance storage. Contracts that need to call siblings can
/// `instance_get(env, &ContractId::Token)` to retrieve the address.
///
/// Extend this enum per project; it is intentionally non-exhaustive.
#[soroban_sdk::contracttype]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ContractId {
    Token,
    Staking,
    CardStaking,
    SwapAmm,
    Payment,
    Invite,
}

/// Store an external contract address under its stable identifier.
pub fn register_contract(env: &Env, id: &ContractId, addr: &Address) {
    env.storage().instance().set(id, addr);
}

/// Retrieve a previously registered contract address.
pub fn resolve_contract(env: &Env, id: &ContractId) -> Option<Address> {
    env.storage().instance().get(id)
}
