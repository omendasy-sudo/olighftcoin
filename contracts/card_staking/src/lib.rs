#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, Vec,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Card Staking Contract (Soroban)
//  6 Card Tiers: Visa, Gold, Platinum, Black, Amex, Mastercard
//  Max 10 stakes per card per user. Lock-period enforcement.
//  8-generation binary tree sponsor commissions on activation.
//  2FA verification required for withdraw/restake (off-chain).
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum CardError {
    NotInitialized      = 1,
    AlreadyInitialized  = 2,
    Unauthorized        = 3,
    InvalidCard         = 4,
    MaxStakesReached    = 5,
    StakeLocked         = 6,
    NoStakeFound        = 7,
    InsufficientBalance = 8,
    InvalidAmount       = 9,
    OverflowError       = 10,
    VerificationRequired = 11,
}

/// Card tier enum
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum CardTier {
    Visa       = 0,
    Gold       = 1,
    Platinum   = 2,
    Black      = 3,
    Amex       = 4,
    Mastercard = 5,
}

/// Individual stake record within a card
#[contracttype]
#[derive(Clone, Debug)]
pub struct CardStake {
    pub amount: i128,
    pub start_ledger: u32,
    pub end_ledger: u32,
    pub lock_days: u32,
    pub daily_reward: i128,
    pub accrued: i128,
    pub last_claim: u32,
    pub active: bool,
}

/// Card config (set by admin per tier)
#[contracttype]
#[derive(Clone, Debug)]
pub struct CardConfig {
    pub tier: CardTier,
    pub min_stake: i128,
    pub lock_days: u32,
    pub apy_bps: u32,            // annual yield in basis points (e.g., 6000 = 60%)
    pub max_stakes: u32,          // max simultaneous stakes (10)
    pub commission_bps: Vec<u32>, // 8-gen commission basis points [gen1..gen8]
}

/// All stakes for a given user + card combination
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserCardStakes {
    pub stakes: Vec<CardStake>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TokenContract,
    CardConfig(CardTier),
    UserStakes(UserStakeKey),
    Sponsor(Address),
    TotalStaked(CardTier),
    TotalStakers(CardTier),
}

#[contracttype]
#[derive(Clone)]
pub struct UserStakeKey {
    pub user: Address,
    pub tier: CardTier,
}

#[contract]
pub struct OlighftCardStaking;

// ── Internal helpers ──────────────────────────────────────────

const LEDGERS_PER_DAY: u32 = 17_280;
const MAX_GENERATIONS: usize = 8;

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_card_config(env: &Env, tier: CardTier) -> Option<CardConfig> {
    env.storage().persistent().get(&DataKey::CardConfig(tier))
}

fn get_user_stakes(env: &Env, user: &Address, tier: CardTier) -> UserCardStakes {
    let key = DataKey::UserStakes(UserStakeKey { user: user.clone(), tier });
    env.storage().persistent().get(&key).unwrap_or(UserCardStakes {
        stakes: Vec::new(env),
    })
}

fn set_user_stakes(env: &Env, user: &Address, tier: CardTier, data: &UserCardStakes) {
    let key = DataKey::UserStakes(UserStakeKey { user: user.clone(), tier });
    env.storage().persistent().set(&key, data);
}

fn get_sponsor(env: &Env, user: &Address) -> Option<Address> {
    env.storage().persistent().get(&DataKey::Sponsor(user.clone()))
}

fn get_total_staked(env: &Env, tier: CardTier) -> i128 {
    env.storage().persistent().get(&DataKey::TotalStaked(tier)).unwrap_or(0)
}

fn set_total_staked(env: &Env, tier: CardTier, val: i128) {
    env.storage().persistent().set(&DataKey::TotalStaked(tier), &val);
}

fn calc_accrued(env: &Env, stake: &CardStake) -> i128 {
    if !stake.active { return 0; }
    let current = env.ledger().sequence();
    let elapsed = current.saturating_sub(stake.last_claim) as i128;
    let days_elapsed = elapsed / (LEDGERS_PER_DAY as i128);
    stake.daily_reward * days_elapsed
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftCardStaking {

    /// Initialize the card staking system
    pub fn initialize(
        env: Env,
        admin: Address,
        token_contract: Address,
    ) -> Result<(), CardError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(CardError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);
        Ok(())
    }

    /// Configure a card tier (admin only)
    /// commission_bps: 8-element vector for generation commissions
    ///   e.g., [1000, 500, 250, 125, 100, 75, 50, 25] → 10%, 5%, 2.5%, ...
    pub fn set_card_config(
        env: Env,
        tier: CardTier,
        min_stake: i128,
        lock_days: u32,
        apy_bps: u32,
        max_stakes: u32,
        commission_bps: Vec<u32>,
    ) -> Result<(), CardError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let config = CardConfig {
            tier,
            min_stake,
            lock_days,
            apy_bps,
            max_stakes,
            commission_bps,
        };
        env.storage().persistent().set(&DataKey::CardConfig(tier), &config);
        Ok(())
    }

    /// Register a sponsor/referrer for a user
    pub fn register_sponsor(env: Env, user: Address, sponsor: Address) -> Result<(), CardError> {
        user.require_auth();
        env.storage().persistent().set(&DataKey::Sponsor(user.clone()), &sponsor);
        Ok(())
    }

    /// Activate a new stake on a card tier
    pub fn activate_stake(
        env: Env,
        staker: Address,
        tier: CardTier,
        amount: i128,
    ) -> Result<u32, CardError> {
        staker.require_auth();

        let config = get_card_config(&env, tier).ok_or(CardError::InvalidCard)?;
        if amount < config.min_stake {
            return Err(CardError::InvalidAmount);
        }

        let mut user_stakes = get_user_stakes(&env, &staker, tier);
        // Count active stakes
        let active_count: u32 = (0..user_stakes.stakes.len())
            .filter(|&i| user_stakes.stakes.get(i).map(|s| s.active).unwrap_or(false))
            .count() as u32;

        if active_count >= config.max_stakes {
            return Err(CardError::MaxStakesReached);
        }

        // Transfer tokens from staker to contract
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        token.transfer(&staker, &env.current_contract_address(), &amount);

        let current = env.ledger().sequence();
        let end = current + (config.lock_days * LEDGERS_PER_DAY);

        // daily_reward = amount * apy_bps / 10000 / 365
        let daily_reward = amount
            .checked_mul(config.apy_bps as i128).unwrap_or(0)
            / 10000 / 365;

        let stake = CardStake {
            amount,
            start_ledger: current,
            end_ledger: end,
            lock_days: config.lock_days,
            daily_reward,
            accrued: 0,
            last_claim: current,
            active: true,
        };

        user_stakes.stakes.push_back(stake);
        let stake_index = user_stakes.stakes.len() - 1;
        set_user_stakes(&env, &staker, tier, &user_stakes);

        // Update pool totals
        let total = get_total_staked(&env, tier);
        set_total_staked(&env, tier, total + amount);

        // Distribute 8-generation sponsor commissions
        Self::distribute_commissions(&env, &staker, amount, &config);

        Ok(stake_index as u32)
    }

    /// Withdraw a completed stake (lock period must be over)
    /// Note: 2FA verification is handled off-chain before calling
    pub fn withdraw_stake(
        env: Env,
        staker: Address,
        tier: CardTier,
        stake_index: u32,
    ) -> Result<i128, CardError> {
        staker.require_auth();

        let mut user_stakes = get_user_stakes(&env, &staker, tier);
        if stake_index >= user_stakes.stakes.len() as u32 {
            return Err(CardError::NoStakeFound);
        }

        let mut stake = user_stakes.stakes.get(stake_index).unwrap();
        if !stake.active {
            return Err(CardError::NoStakeFound);
        }

        let current = env.ledger().sequence();
        if current < stake.end_ledger {
            return Err(CardError::StakeLocked);
        }

        // Calculate final accrued rewards
        let pending = calc_accrued(&env, &stake);
        let total_return = stake.amount + stake.accrued + pending;

        // Transfer principal + rewards back to staker
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        token.transfer(&env.current_contract_address(), &staker, &total_return);

        // Deactivate the stake
        stake.active = false;
        stake.accrued = 0;
        stake.last_claim = current;
        user_stakes.stakes.set(stake_index, stake.clone());
        set_user_stakes(&env, &staker, tier, &user_stakes);

        // Update pool totals
        let total = get_total_staked(&env, tier);
        set_total_staked(&env, tier, total.saturating_sub(stake.amount));

        Ok(total_return)
    }

    /// Restake: withdraw completed stake and immediately re-stake it
    pub fn restake(
        env: Env,
        staker: Address,
        tier: CardTier,
        stake_index: u32,
    ) -> Result<u32, CardError> {
        staker.require_auth();

        let mut user_stakes = get_user_stakes(&env, &staker, tier);
        if stake_index >= user_stakes.stakes.len() as u32 {
            return Err(CardError::NoStakeFound);
        }

        let mut stake = user_stakes.stakes.get(stake_index).unwrap();
        if !stake.active { return Err(CardError::NoStakeFound); }

        let current = env.ledger().sequence();
        if current < stake.end_ledger {
            return Err(CardError::StakeLocked);
        }

        let config = get_card_config(&env, tier).ok_or(CardError::InvalidCard)?;

        // Calculate total with rewards
        let pending = calc_accrued(&env, &stake);
        let restake_amount = stake.amount + stake.accrued + pending;

        // Close old stake
        stake.active = false;
        stake.accrued = 0;
        stake.last_claim = current;
        user_stakes.stakes.set(stake_index, stake.clone());

        // Create new stake with restake amount (no additional transfer needed)
        let end = current + (config.lock_days * LEDGERS_PER_DAY);
        let daily_reward = restake_amount
            .checked_mul(config.apy_bps as i128).unwrap_or(0)
            / 10000 / 365;

        let new_stake = CardStake {
            amount: restake_amount,
            start_ledger: current,
            end_ledger: end,
            lock_days: config.lock_days,
            daily_reward,
            accrued: 0,
            last_claim: current,
            active: true,
        };
        user_stakes.stakes.push_back(new_stake);
        let new_index = user_stakes.stakes.len() - 1;
        set_user_stakes(&env, &staker, tier, &user_stakes);

        Ok(new_index as u32)
    }

    /// Claim rewards from an active stake without withdrawing principal
    pub fn claim_rewards(
        env: Env,
        staker: Address,
        tier: CardTier,
        stake_index: u32,
    ) -> Result<i128, CardError> {
        staker.require_auth();

        let mut user_stakes = get_user_stakes(&env, &staker, tier);
        if stake_index >= user_stakes.stakes.len() as u32 {
            return Err(CardError::NoStakeFound);
        }

        let mut stake = user_stakes.stakes.get(stake_index).unwrap();
        if !stake.active { return Err(CardError::NoStakeFound); }

        let pending = calc_accrued(&env, &stake);
        let total = stake.accrued + pending;
        if total <= 0 { return Err(CardError::InvalidAmount); }

        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        token.transfer(&env.current_contract_address(), &staker, &total);

        stake.accrued = 0;
        stake.last_claim = env.ledger().sequence();
        user_stakes.stakes.set(stake_index, stake);
        set_user_stakes(&env, &staker, tier, &user_stakes);

        Ok(total)
    }

    // ── Read-only queries ────────────────────────────────────────

    /// Get all stakes for a user on a given card tier
    pub fn get_stakes(env: Env, user: Address, tier: CardTier) -> UserCardStakes {
        get_user_stakes(&env, &user, tier)
    }

    /// Get active stake count for a user on a given card tier
    pub fn active_stake_count(env: Env, user: Address, tier: CardTier) -> u32 {
        let user_stakes = get_user_stakes(&env, &user, tier);
        (0..user_stakes.stakes.len())
            .filter(|&i| user_stakes.stakes.get(i).map(|s| s.active).unwrap_or(false))
            .count() as u32
    }

    /// Get total staked across all users for a card tier
    pub fn total_staked(env: Env, tier: CardTier) -> i128 {
        get_total_staked(&env, tier)
    }

    /// Get card configuration for a tier
    pub fn get_config(env: Env, tier: CardTier) -> Option<CardConfig> {
        get_card_config(&env, tier)
    }

    /// Get sponsor for a user
    pub fn get_sponsor(env: Env, user: Address) -> Option<Address> {
        get_sponsor(&env, &user)
    }

    /// Get pending rewards for a specific stake
    pub fn pending_rewards(env: Env, user: Address, tier: CardTier, stake_index: u32) -> i128 {
        let user_stakes = get_user_stakes(&env, &user, tier);
        if stake_index >= user_stakes.stakes.len() as u32 { return 0; }
        let stake = user_stakes.stakes.get(stake_index).unwrap();
        stake.accrued + calc_accrued(&env, &stake)
    }

    // ── Internal: 8-generation commission distribution ───────────

    fn distribute_commissions(env: &Env, staker: &Address, amount: i128, config: &CardConfig) {
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(env, &token_addr);

        let mut current_addr = staker.clone();
        let gen_count = config.commission_bps.len().min(MAX_GENERATIONS as u32);

        for i in 0..gen_count {
            let sponsor = match get_sponsor(env, &current_addr) {
                Some(s) => s,
                None => break,
            };

            let bps = config.commission_bps.get(i).unwrap_or(0);
            if bps == 0 { 
                current_addr = sponsor;
                continue;
            }

            let commission = amount
                .checked_mul(bps as i128).unwrap_or(0) / 10000;

            if commission > 0 {
                // Transfer commission from contract reserves to sponsor
                token.transfer(&env.current_contract_address(), &sponsor, &commission);
            }

            current_addr = sponsor;
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_card_tier_values() {
        assert_eq!(CardTier::Visa as u32, 0);
        assert_eq!(CardTier::Gold as u32, 1);
        assert_eq!(CardTier::Platinum as u32, 2);
        assert_eq!(CardTier::Black as u32, 3);
        assert_eq!(CardTier::Amex as u32, 4);
        assert_eq!(CardTier::Mastercard as u32, 5);
    }

    #[test]
    fn test_max_stakes_limit() {
        // Verify MAX_GENERATIONS constant
        assert_eq!(MAX_GENERATIONS, 8);
    }
}
