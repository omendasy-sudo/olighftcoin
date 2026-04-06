#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Staking Pool Contract (Soroban)
//  Supports: stake, unstake, compound, claim, lock-period
//  boosts, daily reward accrual, and auto-compound strategies.
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakeError {
    NotInitialized      = 1,
    AlreadyInitialized  = 2,
    Unauthorized        = 3,
    InsufficientBalance = 4,
    StakeLocked         = 5,
    NoStakeFound        = 6,
    InvalidAmount       = 7,
    NoRewards           = 8,
    OverflowError       = 9,
    PoolPaused          = 10,
}

/// Compound frequency for auto-compound
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CompoundFreq {
    Manual  = 0,
    Daily   = 1,
    TwiceDaily = 2,
    Weekly  = 3,
    Monthly = 4,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct StakePosition {
    pub amount: i128,
    pub lock_days: u32,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub reward_per_day: i128,
    pub boost_bps: u32,           // basis points multiplier (10000 = 1.0x)
    pub accrued_rewards: i128,
    pub last_claim_ledger: u32,
    pub auto_compound: CompoundFreq,
    pub compound_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PoolInfo {
    pub total_staked: i128,
    pub total_rewards_distributed: i128,
    pub reward_per_ledger: i128,
    pub staker_count: u32,
    pub paused: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TokenContract,
    Pool,
    Position(Address),
}

#[contract]
pub struct OlighftStaking;

// ── Internal helpers ──────────────────────────────────────────

const LEDGERS_PER_DAY: u32 = 17_280; // ~5s per ledger

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_pool(env: &Env) -> PoolInfo {
    env.storage().instance().get(&DataKey::Pool).unwrap_or(PoolInfo {
        total_staked: 0,
        total_rewards_distributed: 0,
        reward_per_ledger: 0,
        staker_count: 0,
        paused: false,
    })
}

fn set_pool(env: &Env, pool: &PoolInfo) {
    env.storage().instance().set(&DataKey::Pool, pool);
}

fn get_position(env: &Env, user: &Address) -> Option<StakePosition> {
    env.storage().persistent().get(&DataKey::Position(user.clone()))
}

fn set_position(env: &Env, user: &Address, pos: &StakePosition) {
    env.storage().persistent().set(&DataKey::Position(user.clone()), pos);
}

fn remove_position(env: &Env, user: &Address) {
    env.storage().persistent().remove(&DataKey::Position(user.clone()));
}

/// Lock-period boost table (basis points):
///   0 days → 10000 (1.0x), 30d → 12500, 90d → 15000,
///   180d → 17500, 365d → 20000, 730d → 25000
fn lock_boost(lock_days: u32) -> u32 {
    if lock_days >= 730 { 25000 }
    else if lock_days >= 365 { 20000 }
    else if lock_days >= 180 { 17500 }
    else if lock_days >= 90 { 15000 }
    else if lock_days >= 30 { 12500 }
    else { 10000 }
}

/// Calculate pending (unclaimed) rewards since last claim
fn calc_pending(env: &Env, pos: &StakePosition, pool: &PoolInfo) -> i128 {
    if pool.total_staked == 0 || pos.amount == 0 {
        return 0;
    }
    let current = env.ledger().sequence();
    let elapsed = current.saturating_sub(pos.last_claim_ledger) as i128;
    if elapsed == 0 { return 0; }

    // user_share = (pos.amount * boost) / (pool.total_staked * 10000)
    // reward = pool.reward_per_ledger * elapsed * user_share
    let boosted = pos.amount * (pos.boost_bps as i128);
    let reward = pool.reward_per_ledger
        .checked_mul(elapsed).unwrap_or(0)
        .checked_mul(boosted).unwrap_or(0)
        / (pool.total_staked * 10000);
    reward
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftStaking {

    /// Initialize the staking pool with admin, token contract, and reward rate
    pub fn initialize(
        env: Env,
        admin: Address,
        token_contract: Address,
        reward_per_ledger: i128,
    ) -> Result<(), StakeError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(StakeError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);

        let pool = PoolInfo {
            total_staked: 0,
            total_rewards_distributed: 0,
            reward_per_ledger,
            staker_count: 0,
            paused: false,
        };
        set_pool(&env, &pool);
        Ok(())
    }

    /// Stake tokens with a lock period and optional auto-compound
    pub fn stake(
        env: Env,
        user: Address,
        amount: i128,
        lock_days: u32,
        auto_compound: CompoundFreq,
    ) -> Result<(), StakeError> {
        user.require_auth();
        let mut pool = get_pool(&env);
        if pool.paused { return Err(StakeError::PoolPaused); }
        if amount <= 0 { return Err(StakeError::InvalidAmount); }

        // Transfer tokens from user to this contract via token contract
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        token.transfer(&user, &env.current_contract_address(), &amount);

        let current_ledger = env.ledger().sequence();
        let boost = lock_boost(lock_days);
        let end_ledger = current_ledger + (lock_days * LEDGERS_PER_DAY);

        // Daily reward estimate = amount * APY-base * boost / 365 / 10000
        // We store a per-day value for the position (approximation)
        let base_daily = amount / 365; // base 100% APY simplified
        let reward_per_day = base_daily * (boost as i128) / 10000;

        // If user already has a position, compound first
        if let Some(mut existing) = get_position(&env, &user) {
            let pending = calc_pending(&env, &existing, &pool);
            existing.accrued_rewards += pending;
            existing.amount += amount;
            // Only upgrade boost — never downgrade an existing higher boost
            if boost > existing.boost_bps {
                existing.boost_bps = boost;
            }
            existing.last_claim_ledger = current_ledger;
            existing.auto_compound = auto_compound;
            // Recalculate reward_per_day using the (potentially upgraded) boost
            let new_daily = existing.amount / 365 * (existing.boost_bps as i128) / 10000;
            existing.reward_per_day = new_daily;
            if end_ledger > existing.end_ledger {
                existing.end_ledger = end_ledger;
                existing.lock_days = lock_days;
            }
            set_position(&env, &user, &existing);
        } else {
            let pos = StakePosition {
                amount,
                lock_days,
                start_ledger: current_ledger,
                end_ledger,
                reward_per_day,
                boost_bps: boost,
                accrued_rewards: 0,
                last_claim_ledger: current_ledger,
                auto_compound,
                compound_ledger: current_ledger,
            };
            set_position(&env, &user, &pos);
            pool.staker_count += 1;
        }

        pool.total_staked = pool.total_staked.checked_add(amount).ok_or(StakeError::OverflowError)?;
        set_pool(&env, &pool);
        Ok(())
    }

    /// Unstake tokens after lock period expires
    pub fn unstake(env: Env, user: Address, amount: i128) -> Result<(), StakeError> {
        user.require_auth();
        if amount <= 0 { return Err(StakeError::InvalidAmount); }

        let mut pos = get_position(&env, &user).ok_or(StakeError::NoStakeFound)?;
        let current = env.ledger().sequence();

        // Enforce lock period
        if current < pos.end_ledger {
            return Err(StakeError::StakeLocked);
        }
        if pos.amount < amount {
            return Err(StakeError::InsufficientBalance);
        }

        let mut pool = get_pool(&env);

        // Accrue any pending rewards before unstaking
        let pending = calc_pending(&env, &pos, &pool);
        pos.accrued_rewards += pending;

        // Transfer tokens back to user
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        token.transfer(&env.current_contract_address(), &user, &amount);

        pos.amount -= amount;
        pos.last_claim_ledger = current;
        pool.total_staked -= amount;

        if pos.amount == 0 && pos.accrued_rewards == 0 {
            remove_position(&env, &user);
            pool.staker_count = pool.staker_count.saturating_sub(1);
        } else {
            set_position(&env, &user, &pos);
        }
        set_pool(&env, &pool);
        Ok(())
    }

    /// Compound: reinvest accrued rewards into principal stake
    pub fn compound(env: Env, user: Address) -> Result<i128, StakeError> {
        user.require_auth();
        let mut pos = get_position(&env, &user).ok_or(StakeError::NoStakeFound)?;
        let mut pool = get_pool(&env);

        // Calculate pending + accrued
        let pending = calc_pending(&env, &pos, &pool);
        let total_rewards = pos.accrued_rewards + pending;
        if total_rewards <= 0 { return Err(StakeError::NoRewards); }

        // Add rewards to principal
        pos.amount = pos.amount.checked_add(total_rewards).ok_or(StakeError::OverflowError)?;
        pos.accrued_rewards = 0;
        pos.last_claim_ledger = env.ledger().sequence();
        pos.compound_ledger = env.ledger().sequence();

        // Update pool: minted rewards added to total staked
        pool.total_staked = pool.total_staked.checked_add(total_rewards).ok_or(StakeError::OverflowError)?;
        pool.total_rewards_distributed += total_rewards;

        set_position(&env, &user, &pos);
        set_pool(&env, &pool);
        Ok(total_rewards)
    }

    /// Claim accrued rewards (withdraw without touching principal)
    pub fn claim_rewards(env: Env, user: Address) -> Result<i128, StakeError> {
        user.require_auth();
        let mut pos = get_position(&env, &user).ok_or(StakeError::NoStakeFound)?;
        let mut pool = get_pool(&env);

        let pending = calc_pending(&env, &pos, &pool);
        let total_rewards = pos.accrued_rewards + pending;
        if total_rewards <= 0 { return Err(StakeError::NoRewards); }

        // Mint reward tokens to user
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        // Note: requires the staking contract to have mint authority or pre-funded rewards
        token.transfer(&env.current_contract_address(), &user, &total_rewards);

        pos.accrued_rewards = 0;
        pos.last_claim_ledger = env.ledger().sequence();
        pool.total_rewards_distributed += total_rewards;

        set_position(&env, &user, &pos);
        set_pool(&env, &pool);
        Ok(total_rewards)
    }

    // ── Read-only queries ────────────────────────────────────────

    /// Get pending (unclaimed) rewards
    pub fn pending_rewards(env: Env, user: Address) -> i128 {
        let pool = get_pool(&env);
        match get_position(&env, &user) {
            Some(pos) => pos.accrued_rewards + calc_pending(&env, &pos, &pool),
            None => 0,
        }
    }

    /// Get user's full stake position
    pub fn get_position(env: Env, user: Address) -> Option<StakePosition> {
        get_position(&env, &user)
    }

    /// Get pool-wide info (TVL, staker count, reward rate)
    pub fn get_pool_info(env: Env) -> PoolInfo {
        get_pool(&env)
    }

    // ── Admin functions ──────────────────────────────────────────

    /// Update reward rate per ledger (admin only)
    pub fn set_rewards(env: Env, reward_per_ledger: i128) -> Result<(), StakeError> {
        let admin = get_admin(&env);
        admin.require_auth();
        let mut pool = get_pool(&env);
        pool.reward_per_ledger = reward_per_ledger;
        set_pool(&env, &pool);
        Ok(())
    }

    /// Pause/unpause the staking pool (admin only)
    pub fn set_paused(env: Env, paused: bool) -> Result<(), StakeError> {
        let admin = get_admin(&env);
        admin.require_auth();
        let mut pool = get_pool(&env);
        pool.paused = paused;
        set_pool(&env, &pool);
        Ok(())
    }

    /// Transfer admin role
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), StakeError> {
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
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::token::{StellarAssetClient, Client as TokenClient};

    // ── Helpers ───────────────────────────────────────────────

    fn setup_env() -> (Env, Address, Address, OlighftStakingClient<'static>, TokenClient<'static>, StellarAssetClient<'static>) {
        let env = Env::default();
        env.mock_all_auths();

        // Set initial ledger
        env.ledger().set(LedgerInfo {
            timestamp: 1_000_000,
            protocol_version: 21,
            sequence_number: 100,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 10,
            min_persistent_entry_ttl: 10,
            max_entry_ttl: 3_110_400,
        });

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        // Deploy SAC token (Stellar Asset Contract)
        let token_addr = env.register_stellar_asset_contract_v2(admin.clone()).address();
        let token_client = TokenClient::new(&env, &token_addr);
        let token_admin_client = StellarAssetClient::new(&env, &token_addr);

        // Deploy staking contract
        let staking_addr = env.register_contract(None, OlighftStaking);
        let staking_client = OlighftStakingClient::new(&env, &staking_addr);

        // Mint tokens to user and pre-fund the staking contract for rewards
        token_admin_client.mint(&user, &10_000_000);
        token_admin_client.mint(&staking_addr, &50_000_000); // reward pool

        // Initialize the staking contract: 1 token per ledger as reward
        staking_client.initialize(&admin, &token_addr, &1_000);

        (env, admin, user, staking_client, token_client, token_admin_client)
    }

    fn advance_ledger(env: &Env, ledgers: u32) {
        let current = env.ledger().sequence();
        env.ledger().set(LedgerInfo {
            timestamp: env.ledger().timestamp() + (ledgers as u64 * 5),
            protocol_version: 21,
            sequence_number: current + ledgers,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 10,
            min_persistent_entry_ttl: 10,
            max_entry_ttl: 3_110_400,
        });
    }

    // ── Lock boost tiers ──────────────────────────────────────

    #[test]
    fn test_lock_boost_tiers() {
        assert_eq!(lock_boost(0), 10000);
        assert_eq!(lock_boost(30), 12500);
        assert_eq!(lock_boost(90), 15000);
        assert_eq!(lock_boost(180), 17500);
        assert_eq!(lock_boost(365), 20000);
        assert_eq!(lock_boost(730), 25000);
        assert_eq!(lock_boost(1000), 25000);
    }

    // ── Initialize ────────────────────────────────────────────

    #[test]
    fn test_initialize() {
        let (env, _admin, _user, staking, _token, _token_admin) = setup_env();
        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 0);
        assert_eq!(pool.staker_count, 0);
        assert_eq!(pool.reward_per_ledger, 1_000);
        assert!(!pool.paused);
    }

    #[test]
    #[should_panic(expected = "AlreadyInitialized")]
    fn test_double_initialize() {
        let (env, admin, _user, staking, token, _token_admin) = setup_env();
        // Second init should fail
        staking.initialize(&admin, &token.address, &500);
    }

    // ── Stake ─────────────────────────────────────────────────

    #[test]
    fn test_stake_basic() {
        let (env, _admin, user, staking, token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 1_000_000);
        assert_eq!(pool.staker_count, 1);

        let pos = staking.get_position(&user).unwrap();
        assert_eq!(pos.amount, 1_000_000);
        assert_eq!(pos.lock_days, 0);
        assert_eq!(pos.boost_bps, 10000); // 1.0x for 0-day lock
    }

    #[test]
    fn test_stake_with_lock_boost() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &500_000, &90, &CompoundFreq::Daily);

        let pos = staking.get_position(&user).unwrap();
        assert_eq!(pos.amount, 500_000);
        assert_eq!(pos.lock_days, 90);
        assert_eq!(pos.boost_bps, 15000); // 1.5x for 90-day lock
        assert_eq!(pos.auto_compound, CompoundFreq::Daily);
    }

    #[test]
    fn test_stake_additive() {
        let (env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &500_000, &30, &CompoundFreq::Manual);
        staking.stake(&user, &300_000, &90, &CompoundFreq::Manual);

        let pos = staking.get_position(&user).unwrap();
        assert_eq!(pos.amount, 800_000);
        // Boost should reflect the latest lock tier
        assert_eq!(pos.boost_bps, 15000);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 800_000);
        assert_eq!(pool.staker_count, 1); // still one staker
    }

    #[test]
    #[should_panic(expected = "InvalidAmount")]
    fn test_stake_zero_amount() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();
        staking.stake(&user, &0, &0, &CompoundFreq::Manual);
    }

    #[test]
    #[should_panic(expected = "InvalidAmount")]
    fn test_stake_negative_amount() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();
        staking.stake(&user, &-100, &0, &CompoundFreq::Manual);
    }

    // ── Unstake ───────────────────────────────────────────────

    #[test]
    fn test_unstake_no_lock() {
        let (_env, _admin, user, staking, token, _token_admin) = setup_env();

        let before_bal = token.balance(&user);
        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);

        // lock_days = 0, end_ledger = current ledger, so unstake immediately
        staking.unstake(&user, &1_000_000);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 0);

        // Position should be removed
        assert!(staking.get_position(&user).is_none());

        // Balance should be restored
        assert_eq!(token.balance(&user), before_bal);
    }

    #[test]
    #[should_panic(expected = "StakeLocked")]
    fn test_unstake_before_lock_expires() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &30, &CompoundFreq::Manual);
        // Try to unstake immediately — lock hasn't expired
        staking.unstake(&user, &500_000);
    }

    #[test]
    fn test_unstake_after_lock_expires() {
        let (env, _admin, user, staking, token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &30, &CompoundFreq::Manual);

        // Advance past the 30-day lock period (30 * 17280 = 518400 ledgers)
        advance_ledger(&env, 30 * LEDGERS_PER_DAY + 1);

        staking.unstake(&user, &1_000_000);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 0);
    }

    #[test]
    fn test_partial_unstake() {
        let (env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &30, &CompoundFreq::Manual);
        advance_ledger(&env, 30 * LEDGERS_PER_DAY + 1);

        staking.unstake(&user, &400_000);

        let pos = staking.get_position(&user).unwrap();
        assert_eq!(pos.amount, 600_000);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 600_000);
    }

    #[test]
    #[should_panic(expected = "InsufficientBalance")]
    fn test_unstake_more_than_staked() {
        let (env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
        staking.unstake(&user, &2_000_000);
    }

    #[test]
    #[should_panic(expected = "NoStakeFound")]
    fn test_unstake_no_position() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();
        staking.unstake(&user, &100);
    }

    // ── Rewards & Compound ────────────────────────────────────

    #[test]
    fn test_pending_rewards_accrue() {
        let (env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);

        // Advance some ledgers so rewards accrue
        advance_ledger(&env, 1000);

        let pending = staking.pending_rewards(&user);
        assert!(pending > 0, "should have pending rewards after advancing ledgers");
    }

    #[test]
    fn test_pending_rewards_zero_without_stake() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();
        assert_eq!(staking.pending_rewards(&user), 0);
    }

    #[test]
    fn test_compound_reinvests_rewards() {
        let (env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
        advance_ledger(&env, 5000);

        let pos_before = staking.get_position(&user).unwrap();
        let pending = staking.pending_rewards(&user);
        assert!(pending > 0);

        let compounded = staking.compound(&user);
        assert_eq!(compounded, pending);

        let pos_after = staking.get_position(&user).unwrap();
        assert_eq!(pos_after.amount, pos_before.amount + compounded);
        assert_eq!(pos_after.accrued_rewards, 0);
    }

    #[test]
    #[should_panic(expected = "NoRewards")]
    fn test_compound_no_rewards() {
        let (_env, _admin, user, staking, _token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
        // No time advanced — 0 pending
        staking.compound(&user);
    }

    #[test]
    fn test_claim_rewards() {
        let (env, _admin, user, staking, token, _token_admin) = setup_env();

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
        advance_ledger(&env, 5000);

        let bal_before = token.balance(&user);
        let pending = staking.pending_rewards(&user);
        assert!(pending > 0);

        let claimed = staking.claim_rewards(&user);
        assert_eq!(claimed, pending);

        let bal_after = token.balance(&user);
        assert_eq!(bal_after, bal_before + claimed);

        // Pending should now be zero
        assert_eq!(staking.pending_rewards(&user), 0);
    }

    // ── Admin functions ───────────────────────────────────────

    #[test]
    fn test_set_rewards() {
        let (_env, admin, _user, staking, _token, _token_admin) = setup_env();

        staking.set_rewards(&2_000);
        let pool = staking.get_pool_info();
        assert_eq!(pool.reward_per_ledger, 2_000);
    }

    #[test]
    fn test_pause_and_unpause() {
        let (_env, admin, user, staking, _token, _token_admin) = setup_env();

        staking.set_paused(&true);
        let pool = staking.get_pool_info();
        assert!(pool.paused);

        staking.set_paused(&false);
        let pool = staking.get_pool_info();
        assert!(!pool.paused);
    }

    #[test]
    #[should_panic(expected = "PoolPaused")]
    fn test_stake_when_paused() {
        let (_env, admin, user, staking, _token, _token_admin) = setup_env();

        staking.set_paused(&true);
        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
    }

    #[test]
    fn test_set_admin() {
        let (env, admin, _user, staking, _token, _token_admin) = setup_env();

        let new_admin = Address::generate(&env);
        staking.set_admin(&new_admin);
        // Verify new admin can call admin functions
        staking.set_rewards(&5_000);
        assert_eq!(staking.get_pool_info().reward_per_ledger, 5_000);
    }

    // ── Multi-staker scenario ─────────────────────────────────

    #[test]
    fn test_multiple_stakers() {
        let (env, _admin, user, staking, _token, token_admin) = setup_env();

        let user2 = Address::generate(&env);
        token_admin.mint(&user2, &5_000_000);

        staking.stake(&user, &1_000_000, &0, &CompoundFreq::Manual);
        staking.stake(&user2, &2_000_000, &90, &CompoundFreq::Weekly);

        let pool = staking.get_pool_info();
        assert_eq!(pool.total_staked, 3_000_000);
        assert_eq!(pool.staker_count, 2);

        advance_ledger(&env, 5000);

        let r1 = staking.pending_rewards(&user);
        let r2 = staking.pending_rewards(&user2);
        assert!(r1 > 0);
        assert!(r2 > 0);
        // user2 has 2x stake + 1.5x boost, so should earn more
        assert!(r2 > r1, "user2 should earn more rewards (higher stake + boost)");
    }
}
