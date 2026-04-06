//! Cryptographic hashing and signature verification helpers.
//!
//! All heavy lifting is delegated to the Soroban host via `env.crypto()`.

use soroban_sdk::{Bytes, BytesN, Env};

/// Compute SHA-256 of arbitrary bytes, returning a 32-byte digest.
#[inline]
pub fn sha256(env: &Env, data: &Bytes) -> BytesN<32> {
    env.crypto().sha256(data)
}

/// Compute Keccak-256 of arbitrary bytes, returning a 32-byte digest.
#[inline]
pub fn keccak256(env: &Env, data: &Bytes) -> BytesN<32> {
    env.crypto().keccak256(data)
}

/// Verify an Ed25519 signature.
///
/// Panics (traps) if the signature is invalid — matching the Soroban host
/// convention where invalid signatures abort the transaction.
#[inline]
pub fn verify_ed25519(
    env: &Env,
    public_key: &BytesN<32>,
    message: &Bytes,
    signature: &BytesN<64>,
) {
    env.crypto()
        .ed25519_verify(public_key, message, signature);
}

/// Derive a deterministic contract-scoped hash from a `&[u8]` slice.
///
/// Useful for generating namespaced keys or nonces:
/// ```ignore
/// let nonce_hash = hash_bytes(env, b"nonce:alice:42");
/// ```
pub fn hash_bytes(env: &Env, data: &[u8]) -> BytesN<32> {
    let bytes = Bytes::from_slice(env, data);
    sha256(env, &bytes)
}

/// Derive a deterministic hash from two 32-byte inputs (e.g. two addresses
/// or two keys) by concatenating them and hashing.
pub fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let mut buf = Bytes::new(env);
    buf.append(&Bytes::from_slice(env, a.to_array().as_slice()));
    buf.append(&Bytes::from_slice(env, b.to_array().as_slice()));
    sha256(env, &buf)
}
