#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, Vec,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Invite & Sponsor Contract (Soroban)
//  8-generation binary tree referral system with:
//    - Sponsor registration (auto-assign Main Wallet if none)
//    - 5-stage invite progression
//    - Commission distribution on staking activations
//    - Invite tree queries (up to 8 generations)
//    - Stage-based reward unlocks
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum InviteError {
    NotInitialized       = 1,
    AlreadyInitialized   = 2,
    Unauthorized         = 3,
    AlreadyRegistered    = 4,
    SponsorNotRegistered = 5,
    SelfSponsor          = 6,
    InvalidStage         = 7,
    OverflowError        = 8,
    NoCommission         = 9,
}

/// Invite stage (1-5)
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum InviteStage {
    Stage1 = 1,  // 0-4 direct invites
    Stage2 = 2,  // 5-14 direct invites
    Stage3 = 3,  // 15-29 direct invites
    Stage4 = 4,  // 30-49 direct invites
    Stage5 = 5,  // 50+ direct invites
}

/// User invite profile
#[contracttype]
#[derive(Clone, Debug)]
pub struct InviteProfile {
    pub user: Address,
    pub sponsor: Address,
    pub stage: InviteStage,
    pub direct_invites: u32,
    pub total_team: u32,           // all downstream members
    pub total_commissions: i128,   // lifetime commissions earned
    pub registered_ledger: u32,
}

/// Commission tier per generation (set by admin)
#[contracttype]
#[derive(Clone, Debug)]
pub struct CommissionTiers {
    pub gen1_bps: u32,
    pub gen2_bps: u32,
    pub gen3_bps: u32,
    pub gen4_bps: u32,
    pub gen5_bps: u32,
    pub gen6_bps: u32,
    pub gen7_bps: u32,
    pub gen8_bps: u32,
}

/// Stage thresholds for progression
#[contracttype]
#[derive(Clone, Debug)]
pub struct StageThresholds {
    pub stage2_min: u32,   // direct invites needed for Stage 2
    pub stage3_min: u32,
    pub stage4_min: u32,
    pub stage5_min: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    MainWallet,
    TokenContract,
    Profile(Address),
    DirectInvites(Address),   // list of direct invitees
    CommissionTiers,
    StageThresholds,
    TotalMembers,
}

#[contract]
pub struct OlighftInvite;

// ── Internal helpers ──────────────────────────────────────────

const MAX_GENERATIONS: u32 = 8;

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_main_wallet(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::MainWallet).expect("no main wallet")
}

fn get_profile(env: &Env, user: &Address) -> Option<InviteProfile> {
    env.storage().persistent().get(&DataKey::Profile(user.clone()))
}

fn set_profile(env: &Env, profile: &InviteProfile) {
    env.storage().persistent().set(&DataKey::Profile(profile.user.clone()), profile);
}

fn get_direct_invites(env: &Env, user: &Address) -> Vec<Address> {
    env.storage().persistent().get(&DataKey::DirectInvites(user.clone()))
        .unwrap_or(Vec::new(env))
}

fn set_direct_invites(env: &Env, user: &Address, list: &Vec<Address>) {
    env.storage().persistent().set(&DataKey::DirectInvites(user.clone()), list);
}

fn get_commission_tiers(env: &Env) -> CommissionTiers {
    env.storage().instance().get(&DataKey::CommissionTiers).unwrap_or(CommissionTiers {
        gen1_bps: 1000,  // 10%
        gen2_bps: 500,   // 5%
        gen3_bps: 250,   // 2.5%
        gen4_bps: 125,   // 1.25%
        gen5_bps: 100,   // 1%
        gen6_bps: 75,    // 0.75%
        gen7_bps: 50,    // 0.5%
        gen8_bps: 25,    // 0.25%
    })
}

fn get_thresholds(env: &Env) -> StageThresholds {
    env.storage().instance().get(&DataKey::StageThresholds).unwrap_or(StageThresholds {
        stage2_min: 5,
        stage3_min: 15,
        stage4_min: 30,
        stage5_min: 50,
    })
}

fn get_total_members(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::TotalMembers).unwrap_or(0)
}

fn set_total_members(env: &Env, count: u32) {
    env.storage().instance().set(&DataKey::TotalMembers, &count);
}

fn calc_stage(direct: u32, thresholds: &StageThresholds) -> InviteStage {
    if direct >= thresholds.stage5_min {
        InviteStage::Stage5
    } else if direct >= thresholds.stage4_min {
        InviteStage::Stage4
    } else if direct >= thresholds.stage3_min {
        InviteStage::Stage3
    } else if direct >= thresholds.stage2_min {
        InviteStage::Stage2
    } else {
        InviteStage::Stage1
    }
}

fn tier_bps_for_gen(tiers: &CommissionTiers, gen: u32) -> u32 {
    match gen {
        0 => tiers.gen1_bps,
        1 => tiers.gen2_bps,
        2 => tiers.gen3_bps,
        3 => tiers.gen4_bps,
        4 => tiers.gen5_bps,
        5 => tiers.gen6_bps,
        6 => tiers.gen7_bps,
        7 => tiers.gen8_bps,
        _ => 0,
    }
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftInvite {

    /// Initialize the invite system
    pub fn initialize(
        env: Env,
        admin: Address,
        main_wallet: Address,
        token_contract: Address,
    ) -> Result<(), InviteError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(InviteError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::MainWallet, &main_wallet);
        env.storage().instance().set(&DataKey::TokenContract, &token_contract);
        set_total_members(&env, 0);

        // Register main wallet as root (self-sponsored)
        let profile = InviteProfile {
            user: main_wallet.clone(),
            sponsor: main_wallet.clone(),
            stage: InviteStage::Stage5,
            direct_invites: 0,
            total_team: 0,
            total_commissions: 0,
            registered_ledger: env.ledger().sequence(),
        };
        set_profile(&env, &profile);
        set_total_members(&env, 1);

        Ok(())
    }

    /// Register a new user with a sponsor
    /// If no sponsor provided (sponsor == user), auto-assign Main Wallet
    pub fn register_invite(
        env: Env,
        user: Address,
        sponsor: Address,
    ) -> Result<(), InviteError> {
        user.require_auth();

        // Check not already registered
        if get_profile(&env, &user).is_some() {
            return Err(InviteError::AlreadyRegistered);
        }

        // Resolve sponsor
        let actual_sponsor = if user == sponsor {
            get_main_wallet(&env)
        } else {
            // Verify sponsor exists
            if get_profile(&env, &sponsor).is_none() {
                return Err(InviteError::SponsorNotRegistered);
            }
            sponsor
        };

        // Create user profile
        let profile = InviteProfile {
            user: user.clone(),
            sponsor: actual_sponsor.clone(),
            stage: InviteStage::Stage1,
            direct_invites: 0,
            total_team: 0,
            total_commissions: 0,
            registered_ledger: env.ledger().sequence(),
        };
        set_profile(&env, &profile);

        // Update sponsor's direct invites
        let mut sponsor_profile = get_profile(&env, &actual_sponsor).unwrap();
        sponsor_profile.direct_invites += 1;

        // Re-calculate stage
        let thresholds = get_thresholds(&env);
        sponsor_profile.stage = calc_stage(sponsor_profile.direct_invites, &thresholds);

        // Add to direct invite list
        let mut invites = get_direct_invites(&env, &actual_sponsor);
        invites.push_back(user.clone());
        set_direct_invites(&env, &actual_sponsor, &invites);

        set_profile(&env, &sponsor_profile);

        // Update total_team for all ancestors (up to 8 generations)
        let mut ancestor = actual_sponsor;
        for _ in 0..MAX_GENERATIONS {
            if let Some(mut anc_profile) = get_profile(&env, &ancestor) {
                anc_profile.total_team += 1;
                let next = anc_profile.sponsor.clone();
                set_profile(&env, &anc_profile);
                if next == ancestor { break; } // reached root
                ancestor = next;
            } else {
                break;
            }
        }

        // Increment global count
        let total = get_total_members(&env);
        set_total_members(&env, total + 1);

        Ok(())
    }

    /// Distribute 8-generation commissions when a stake is activated
    /// Called by the card_staking contract or by admin
    pub fn distribute_commission(
        env: Env,
        staker: Address,
        stake_amount: i128,
    ) -> Result<Vec<i128>, InviteError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let tiers = get_commission_tiers(&env);
        let token_addr: Address = env.storage().instance().get(&DataKey::TokenContract).unwrap();
        let token = soroban_sdk::token::Client::new(&env, &token_addr);

        let mut distributions: Vec<i128> = Vec::new(&env);
        let mut current = staker;

        for gen in 0..MAX_GENERATIONS {
            let profile = match get_profile(&env, &current) {
                Some(p) => p,
                None => break,
            };

            let sponsor = profile.sponsor.clone();
            if sponsor == current { break; } // reached root

            let bps = tier_bps_for_gen(&tiers, gen);
            if bps == 0 {
                distributions.push_back(0);
                current = sponsor;
                continue;
            }

            let commission = stake_amount
                .checked_mul(bps as i128).ok_or(InviteError::OverflowError)?
                / 10000;

            if commission > 0 {
                // Transfer from contract to sponsor
                token.transfer(&env.current_contract_address(), &sponsor, &commission);

                // Update sponsor profile
                if let Some(mut sp) = get_profile(&env, &sponsor) {
                    sp.total_commissions += commission;
                    set_profile(&env, &sp);
                }
            }

            distributions.push_back(commission);
            current = sponsor;
        }

        Ok(distributions)
    }

    // ── Read-only queries ────────────────────────────────────────

    /// Get user's invite profile
    pub fn get_profile(env: Env, user: Address) -> Option<InviteProfile> {
        get_profile(&env, &user)
    }

    /// Get sponsor of a user
    pub fn get_sponsor(env: Env, user: Address) -> Option<Address> {
        get_profile(&env, &user).map(|p| p.sponsor)
    }

    /// Get user's current stage
    pub fn get_stage(env: Env, user: Address) -> InviteStage {
        get_profile(&env, &user)
            .map(|p| p.stage)
            .unwrap_or(InviteStage::Stage1)
    }

    /// Get direct invitees of a user
    pub fn get_direct_invites(env: Env, user: Address) -> Vec<Address> {
        get_direct_invites(&env, &user)
    }

    /// Walk up the invite tree (returns sponsors from gen1 to gen8)
    pub fn get_invite_tree(env: Env, user: Address) -> Vec<Address> {
        let mut tree: Vec<Address> = Vec::new(&env);
        let mut current = user;
        for _ in 0..MAX_GENERATIONS {
            let profile = match get_profile(&env, &current) {
                Some(p) => p,
                None => break,
            };
            let sponsor = profile.sponsor.clone();
            if sponsor == current { break; }
            tree.push_back(sponsor.clone());
            current = sponsor;
        }
        tree
    }

    /// Get total registered members
    pub fn total_members(env: Env) -> u32 {
        get_total_members(&env)
    }

    /// Get commission tier configuration
    pub fn get_commission_tiers(env: Env) -> CommissionTiers {
        get_commission_tiers(&env)
    }

    /// Get stage thresholds
    pub fn get_stage_thresholds(env: Env) -> StageThresholds {
        get_thresholds(&env)
    }

    // ── Admin functions ──────────────────────────────────────────

    /// Update commission tiers (admin only)
    pub fn set_commission_tiers(env: Env, tiers: CommissionTiers) -> Result<(), InviteError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::CommissionTiers, &tiers);
        Ok(())
    }

    /// Update stage thresholds (admin only)
    pub fn set_stage_thresholds(env: Env, thresholds: StageThresholds) -> Result<(), InviteError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::StageThresholds, &thresholds);
        Ok(())
    }

    /// Transfer admin role
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), InviteError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Update main wallet address (admin only)
    pub fn set_main_wallet(env: Env, new_main: Address) -> Result<(), InviteError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::MainWallet, &new_main);
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_stage_calculation() {
        let thresholds = StageThresholds {
            stage2_min: 5,
            stage3_min: 15,
            stage4_min: 30,
            stage5_min: 50,
        };
        assert_eq!(calc_stage(0, &thresholds), InviteStage::Stage1);
        assert_eq!(calc_stage(4, &thresholds), InviteStage::Stage1);
        assert_eq!(calc_stage(5, &thresholds), InviteStage::Stage2);
        assert_eq!(calc_stage(14, &thresholds), InviteStage::Stage2);
        assert_eq!(calc_stage(15, &thresholds), InviteStage::Stage3);
        assert_eq!(calc_stage(29, &thresholds), InviteStage::Stage3);
        assert_eq!(calc_stage(30, &thresholds), InviteStage::Stage4);
        assert_eq!(calc_stage(49, &thresholds), InviteStage::Stage4);
        assert_eq!(calc_stage(50, &thresholds), InviteStage::Stage5);
        assert_eq!(calc_stage(100, &thresholds), InviteStage::Stage5);
    }

    #[test]
    fn test_tier_bps() {
        let tiers = CommissionTiers {
            gen1_bps: 1000,
            gen2_bps: 500,
            gen3_bps: 250,
            gen4_bps: 125,
            gen5_bps: 100,
            gen6_bps: 75,
            gen7_bps: 50,
            gen8_bps: 25,
        };
        assert_eq!(tier_bps_for_gen(&tiers, 0), 1000);
        assert_eq!(tier_bps_for_gen(&tiers, 7), 25);
        assert_eq!(tier_bps_for_gen(&tiers, 8), 0); // out of range
        // Total: 10% + 5% + 2.5% + 1.25% + 1% + 0.75% + 0.5% + 0.25% = 21.25%
        let total: u32 = tiers.gen1_bps + tiers.gen2_bps + tiers.gen3_bps + tiers.gen4_bps
            + tiers.gen5_bps + tiers.gen6_bps + tiers.gen7_bps + tiers.gen8_bps;
        assert_eq!(total, 2125); // 21.25% total commission
    }
}
