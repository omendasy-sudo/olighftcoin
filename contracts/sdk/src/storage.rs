//! Typed helpers over Soroban's three storage tiers:
//!
//! | Tier          | Lifetime          | Typical use               |
//! |---------------|-------------------|---------------------------|
//! | **Instance**  | tied to contract  | admin, config, totals     |
//! | **Persistent**| survives archival | balances, positions       |
//! | **Temporary** | short-lived       | nonces, one-shot flags    |

use soroban_sdk::{Env, IntoVal, TryFromVal, Val};

// ── Instance storage ───────────────────────────────────────────────

/// Read a value from **instance** storage.
pub fn instance_get<K, V>(env: &Env, key: &K) -> Option<V>
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    env.storage().instance().get(key)
}

/// Write a value to **instance** storage.
pub fn instance_set<K, V>(env: &Env, key: &K, val: &V)
where
    K: IntoVal<Env, Val>,
    V: IntoVal<Env, Val>,
{
    env.storage().instance().set(key, val);
}

/// Check existence in **instance** storage.
pub fn instance_has<K>(env: &Env, key: &K) -> bool
where
    K: IntoVal<Env, Val>,
{
    env.storage().instance().has(key)
}

/// Remove a key from **instance** storage.
pub fn instance_remove<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage().instance().remove(key);
}

// ── Persistent storage ─────────────────────────────────────────────

/// Read a value from **persistent** storage.
pub fn persistent_get<K, V>(env: &Env, key: &K) -> Option<V>
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    env.storage().persistent().get(key)
}

/// Write a value to **persistent** storage.
pub fn persistent_set<K, V>(env: &Env, key: &K, val: &V)
where
    K: IntoVal<Env, Val>,
    V: IntoVal<Env, Val>,
{
    env.storage().persistent().set(key, val);
}

/// Check existence in **persistent** storage.
pub fn persistent_has<K>(env: &Env, key: &K) -> bool
where
    K: IntoVal<Env, Val>,
{
    env.storage().persistent().has(key)
}

/// Remove a key from **persistent** storage.
pub fn persistent_remove<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage().persistent().remove(key);
}

// ── Temporary storage ──────────────────────────────────────────────

/// Read a value from **temporary** storage.
pub fn temporary_get<K, V>(env: &Env, key: &K) -> Option<V>
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    env.storage().temporary().get(key)
}

/// Write a value to **temporary** storage.
pub fn temporary_set<K, V>(env: &Env, key: &K, val: &V)
where
    K: IntoVal<Env, Val>,
    V: IntoVal<Env, Val>,
{
    env.storage().temporary().set(key, val);
}

/// Check existence in **temporary** storage.
pub fn temporary_has<K>(env: &Env, key: &K) -> bool
where
    K: IntoVal<Env, Val>,
{
    env.storage().temporary().has(key)
}

/// Remove a key from **temporary** storage.
pub fn temporary_remove<K>(env: &Env, key: &K)
where
    K: IntoVal<Env, Val>,
{
    env.storage().temporary().remove(key);
}

// ── Convenience: get-or-default ────────────────────────────────────

/// Get from instance storage, returning `default` when absent.
pub fn instance_get_or<K, V>(env: &Env, key: &K, default: V) -> V
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    instance_get(env, key).unwrap_or(default)
}

/// Get from persistent storage, returning `default` when absent.
pub fn persistent_get_or<K, V>(env: &Env, key: &K, default: V) -> V
where
    K: IntoVal<Env, Val>,
    V: TryFromVal<Env, Val>,
{
    persistent_get(env, key).unwrap_or(default)
}
