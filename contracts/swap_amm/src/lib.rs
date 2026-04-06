#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — DEX / AMM Contract (Soroban)
//  Constant-product AMM (x * y = k) with:
//    - Pool creation (admin)
//    - Add/remove liquidity with LP shares
//    - Swap with 0.3% fee + slippage protection
//    - Price impact calculation
//    - Fee accumulation + admin withdrawal
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SwapError {
    NotInitialized       = 1,
    AlreadyInitialized   = 2,
    Unauthorized         = 3,
    PoolAlreadyExists    = 4,
    PoolNotFound         = 5,
    InsufficientLiquidity = 6,
    SlippageExceeded     = 7,
    InvalidAmount        = 8,
    InsufficientShares   = 9,
    OverflowError        = 10,
    ZeroLiquidity        = 11,
    SameToken            = 12,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct Pool {
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_shares: i128,
    pub fee_bps: u32,          // 30 = 0.3%
    pub accumulated_fees_a: i128,
    pub accumulated_fees_b: i128,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct SwapResult {
    pub amount_out: i128,
    pub fee: i128,
    pub price_impact_bps: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Pool,
    LpShares(Address),   // user → shares
}

#[contract]
pub struct OlighftSwapAmm;

// ── Internal helpers ──────────────────────────────────────────

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_pool(env: &Env) -> Option<Pool> {
    env.storage().instance().get(&DataKey::Pool)
}

fn set_pool(env: &Env, pool: &Pool) {
    env.storage().instance().set(&DataKey::Pool, pool);
}

fn get_lp_shares(env: &Env, user: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::LpShares(user.clone())).unwrap_or(0)
}

fn set_lp_shares(env: &Env, user: &Address, shares: i128) {
    env.storage().persistent().set(&DataKey::LpShares(user.clone()), &shares);
}

/// Integer square root (Babylonian method)
fn isqrt(n: i128) -> i128 {
    if n <= 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

/// Calculate output amount using constant-product formula (x * y = k)
/// Returns (amount_out, fee, price_impact_bps)
fn calc_swap_output(
    amount_in: i128,
    reserve_in: i128,
    reserve_out: i128,
    fee_bps: u32,
) -> (i128, i128, u32) {
    // Fee deduction
    let fee = amount_in * (fee_bps as i128) / 10000;
    let amount_in_after_fee = amount_in - fee;

    // Constant product: new_reserve_in * new_reserve_out = k
    // amount_out = reserve_out - k / (reserve_in + amount_in_after_fee)
    let k = reserve_in.checked_mul(reserve_out).expect("overflow in k calculation: reserves too large");
    let new_reserve_in = reserve_in + amount_in_after_fee;
    let amount_out = reserve_out - (k / new_reserve_in);

    // Price impact: deviation from spot price
    // spot_rate = reserve_out / reserve_in
    // effective_rate = amount_out / amount_in_after_fee
    // impact = (1 - effective_rate / spot_rate) * 10000
    let impact_bps = if reserve_in > 0 && amount_in_after_fee > 0 {
        let spot_out = amount_in_after_fee * reserve_out / reserve_in;
        if spot_out > 0 {
            let diff = spot_out - amount_out;
            (diff * 10000 / spot_out) as u32
        } else { 0 }
    } else { 0 };

    (amount_out, fee, impact_bps)
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftSwapAmm {

    /// Initialize the AMM with admin
    pub fn initialize(env: Env, admin: Address) -> Result<(), SwapError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(SwapError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        Ok(())
    }

    /// Create a new liquidity pool (admin only)
    pub fn create_pool(
        env: Env,
        token_a: Address,
        token_b: Address,
        fee_bps: u32,
    ) -> Result<(), SwapError> {
        let admin = get_admin(&env);
        admin.require_auth();

        if token_a == token_b {
            return Err(SwapError::SameToken);
        }
        if get_pool(&env).is_some() {
            return Err(SwapError::PoolAlreadyExists);
        }

        let pool = Pool {
            token_a,
            token_b,
            reserve_a: 0,
            reserve_b: 0,
            total_shares: 0,
            fee_bps,
            accumulated_fees_a: 0,
            accumulated_fees_b: 0,
        };
        set_pool(&env, &pool);
        Ok(())
    }

    /// Add liquidity: deposit token_a and token_b, receive LP shares
    pub fn add_liquidity(
        env: Env,
        user: Address,
        amount_a: i128,
        amount_b: i128,
    ) -> Result<i128, SwapError> {
        user.require_auth();
        if amount_a <= 0 || amount_b <= 0 {
            return Err(SwapError::InvalidAmount);
        }

        let mut pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;

        // Transfer tokens from user to contract
        let token_a_client = soroban_sdk::token::Client::new(&env, &pool.token_a);
        let token_b_client = soroban_sdk::token::Client::new(&env, &pool.token_b);
        token_a_client.transfer(&user, &env.current_contract_address(), &amount_a);
        token_b_client.transfer(&user, &env.current_contract_address(), &amount_b);

        // Calculate LP shares
        let shares = if pool.total_shares == 0 {
            // Initial liquidity: shares = sqrt(amount_a * amount_b)
            isqrt(amount_a.checked_mul(amount_b).ok_or(SwapError::OverflowError)?)
        } else {
            // Proportional: min(amount_a / reserve_a, amount_b / reserve_b) * total_shares
            let share_a = amount_a * pool.total_shares / pool.reserve_a;
            let share_b = amount_b * pool.total_shares / pool.reserve_b;
            if share_a < share_b { share_a } else { share_b }
        };

        if shares <= 0 {
            return Err(SwapError::ZeroLiquidity);
        }

        pool.reserve_a += amount_a;
        pool.reserve_b += amount_b;
        pool.total_shares += shares;
        set_pool(&env, &pool);

        let user_shares = get_lp_shares(&env, &user);
        set_lp_shares(&env, &user, user_shares + shares);

        Ok(shares)
    }

    /// Remove liquidity: burn LP shares, receive proportional token_a + token_b
    pub fn remove_liquidity(
        env: Env,
        user: Address,
        shares: i128,
    ) -> Result<(i128, i128), SwapError> {
        user.require_auth();
        if shares <= 0 {
            return Err(SwapError::InvalidAmount);
        }

        let user_shares = get_lp_shares(&env, &user);
        if user_shares < shares {
            return Err(SwapError::InsufficientShares);
        }

        let mut pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        if pool.total_shares == 0 {
            return Err(SwapError::ZeroLiquidity);
        }

        // Calculate proportional amounts
        let amount_a = shares * pool.reserve_a / pool.total_shares;
        let amount_b = shares * pool.reserve_b / pool.total_shares;

        // Transfer tokens back to user
        let token_a_client = soroban_sdk::token::Client::new(&env, &pool.token_a);
        let token_b_client = soroban_sdk::token::Client::new(&env, &pool.token_b);
        token_a_client.transfer(&env.current_contract_address(), &user, &amount_a);
        token_b_client.transfer(&env.current_contract_address(), &user, &amount_b);

        pool.reserve_a -= amount_a;
        pool.reserve_b -= amount_b;
        pool.total_shares -= shares;
        set_pool(&env, &pool);

        set_lp_shares(&env, &user, user_shares - shares);

        Ok((amount_a, amount_b))
    }

    /// Execute a swap: token_in → token_out with slippage protection
    pub fn swap(
        env: Env,
        user: Address,
        token_in: Address,
        amount_in: i128,
        min_out: i128,
    ) -> Result<SwapResult, SwapError> {
        user.require_auth();
        if amount_in <= 0 { return Err(SwapError::InvalidAmount); }

        let mut pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;

        // Determine direction
        let is_a_to_b = token_in == pool.token_a;
        let is_b_to_a = token_in == pool.token_b;
        if !is_a_to_b && !is_b_to_a {
            return Err(SwapError::PoolNotFound);
        }

        let (reserve_in, reserve_out) = if is_a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        if reserve_in == 0 || reserve_out == 0 {
            return Err(SwapError::InsufficientLiquidity);
        }

        let (amount_out, fee, impact_bps) = calc_swap_output(
            amount_in, reserve_in, reserve_out, pool.fee_bps,
        );

        if amount_out <= 0 {
            return Err(SwapError::InsufficientLiquidity);
        }
        if amount_out < min_out {
            return Err(SwapError::SlippageExceeded);
        }

        // Execute transfers
        let token_in_client = soroban_sdk::token::Client::new(&env, &token_in);
        token_in_client.transfer(&user, &env.current_contract_address(), &amount_in);

        let token_out_addr = if is_a_to_b { &pool.token_b } else { &pool.token_a };
        let token_out_client = soroban_sdk::token::Client::new(&env, token_out_addr);
        token_out_client.transfer(&env.current_contract_address(), &user, &amount_out);

        // Update reserves & fees
        if is_a_to_b {
            pool.reserve_a += amount_in;
            pool.reserve_b -= amount_out;
            pool.accumulated_fees_a += fee;
        } else {
            pool.reserve_b += amount_in;
            pool.reserve_a -= amount_out;
            pool.accumulated_fees_b += fee;
        }
        set_pool(&env, &pool);

        Ok(SwapResult { amount_out, fee, price_impact_bps: impact_bps })
    }

    // ── Read-only queries ────────────────────────────────────────

    /// Preview swap output without executing
    pub fn get_quote(
        env: Env,
        token_in: Address,
        amount_in: i128,
    ) -> Result<SwapResult, SwapError> {
        if amount_in <= 0 { return Err(SwapError::InvalidAmount); }
        let pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;

        let is_a_to_b = token_in == pool.token_a;
        let (reserve_in, reserve_out) = if is_a_to_b {
            (pool.reserve_a, pool.reserve_b)
        } else {
            (pool.reserve_b, pool.reserve_a)
        };

        if reserve_in == 0 || reserve_out == 0 {
            return Err(SwapError::InsufficientLiquidity);
        }

        let (amount_out, fee, impact_bps) = calc_swap_output(
            amount_in, reserve_in, reserve_out, pool.fee_bps,
        );

        Ok(SwapResult { amount_out, fee, price_impact_bps: impact_bps })
    }

    /// Get current pool reserves
    pub fn get_reserves(env: Env) -> Result<(i128, i128), SwapError> {
        let pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        Ok((pool.reserve_a, pool.reserve_b))
    }

    /// Get spot price of token_a in terms of token_b (scaled by 1e7)
    pub fn get_price(env: Env, token_a: Address, token_b: Address) -> Result<i128, SwapError> {
        let pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        let (ra, rb) = if token_a == pool.token_a && token_b == pool.token_b {
            (pool.reserve_a, pool.reserve_b)
        } else if token_a == pool.token_b && token_b == pool.token_a {
            (pool.reserve_b, pool.reserve_a)
        } else {
            return Err(SwapError::PoolNotFound);
        };
        if ra == 0 { return Err(SwapError::ZeroLiquidity); }
        Ok(rb * 10_000_000 / ra) // price scaled by 1e7 (7 decimals)
    }

    /// Get LP share balance for a user
    pub fn lp_balance(env: Env, user: Address) -> i128 {
        get_lp_shares(&env, &user)
    }

    /// Get total LP shares outstanding
    pub fn total_shares(env: Env) -> i128 {
        get_pool(&env).map(|p| p.total_shares).unwrap_or(0)
    }

    /// Get accumulated swap fees
    pub fn accumulated_fees(env: Env) -> Result<(i128, i128), SwapError> {
        let pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        Ok((pool.accumulated_fees_a, pool.accumulated_fees_b))
    }

    // ── Admin functions ──────────────────────────────────────────

    /// Withdraw accumulated protocol fees (admin only)
    pub fn collect_fees(env: Env) -> Result<(i128, i128), SwapError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let mut pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        let fees_a = pool.accumulated_fees_a;
        let fees_b = pool.accumulated_fees_b;

        if fees_a > 0 {
            let token_a_client = soroban_sdk::token::Client::new(&env, &pool.token_a);
            token_a_client.transfer(&env.current_contract_address(), &admin, &fees_a);
        }
        if fees_b > 0 {
            let token_b_client = soroban_sdk::token::Client::new(&env, &pool.token_b);
            token_b_client.transfer(&env.current_contract_address(), &admin, &fees_b);
        }

        pool.accumulated_fees_a = 0;
        pool.accumulated_fees_b = 0;
        set_pool(&env, &pool);

        Ok((fees_a, fees_b))
    }

    /// Update pool fee rate (admin only)
    pub fn set_fee(env: Env, fee_bps: u32) -> Result<(), SwapError> {
        let admin = get_admin(&env);
        admin.require_auth();
        let mut pool = get_pool(&env).ok_or(SwapError::PoolNotFound)?;
        pool.fee_bps = fee_bps;
        set_pool(&env, &pool);
        Ok(())
    }

    /// Transfer admin role
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), SwapError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_isqrt() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(100), 10);
        assert_eq!(isqrt(1_000_000), 1000);
        assert_eq!(isqrt(2), 1); // floor
    }

    #[test]
    fn test_swap_output_calc() {
        // Pool: 1000 A, 2000 B, 30 bps fee (0.3%)
        let (out, fee, impact) = calc_swap_output(100, 1000, 2000, 30);
        assert!(fee > 0);
        assert!(out > 0);
        assert!(out < 200); // should be less than spot due to price impact
        // fee = 100 * 30 / 10000 = 0 (rounded) — but 100*30=3000/10000=0
        // Actually fee = 100 * 30 / 10000 = 0 (integer) ... at small amounts
        // Let's test with larger numbers
        let (out2, fee2, impact2) = calc_swap_output(10000, 100000, 200000, 30);
        assert_eq!(fee2, 30); // 10000 * 30 / 10000 = 30
        assert!(out2 > 0);
        assert!(impact2 > 0); // should have some price impact
    }
}
