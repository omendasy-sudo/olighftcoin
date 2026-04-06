#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, String, Vec,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — SEP-41 Token Contract (Soroban)
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TokenError {
    NotInitialized    = 1,
    AlreadyInitialized = 2,
    Unauthorized       = 3,
    InsufficientBalance = 4,
    InsufficientAllowance = 5,
    InvalidAmount      = 6,
    OverflowError      = 7,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TotalSupply,
    Balance(Address),
    Allowance(AllowanceKey),
    Name,
    Symbol,
    Decimals,
}

#[contracttype]
#[derive(Clone)]
pub struct AllowanceKey {
    pub owner: Address,
    pub spender: Address,
}

#[contract]
pub struct OlighftToken;

// ── Internal helpers ──────────────────────────────────────────

fn get_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("not initialized")
}

fn get_balance(env: &Env, addr: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::Balance(addr.clone()))
        .unwrap_or(0)
}

fn set_balance(env: &Env, addr: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::Balance(addr.clone()), &amount);
}

fn get_allowance(env: &Env, owner: &Address, spender: &Address) -> i128 {
    let key = DataKey::Allowance(AllowanceKey {
        owner: owner.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().get(&key).unwrap_or(0)
}

fn set_allowance(env: &Env, owner: &Address, spender: &Address, amount: i128) {
    let key = DataKey::Allowance(AllowanceKey {
        owner: owner.clone(),
        spender: spender.clone(),
    });
    env.storage().persistent().set(&key, &amount);
}

fn get_total_supply(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

fn set_total_supply(env: &Env, supply: i128) {
    env.storage().instance().set(&DataKey::TotalSupply, &supply);
}

fn spend_allowance(env: &Env, owner: &Address, spender: &Address, amount: i128) -> Result<(), TokenError> {
    let current = get_allowance(env, owner, spender);
    if current < amount {
        return Err(TokenError::InsufficientAllowance);
    }
    set_allowance(env, owner, spender, current - amount);
    Ok(())
}

fn do_transfer(env: &Env, from: &Address, to: &Address, amount: i128) -> Result<(), TokenError> {
    if amount <= 0 {
        return Err(TokenError::InvalidAmount);
    }
    let from_bal = get_balance(env, from);
    if from_bal < amount {
        return Err(TokenError::InsufficientBalance);
    }
    set_balance(env, from, from_bal - amount);
    let to_bal = get_balance(env, to);
    set_balance(env, to, to_bal.checked_add(amount).ok_or(TokenError::OverflowError)?);
    Ok(())
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftToken {
    /// Initialize the OLIGHFT token (admin, name, symbol, 7 decimals, initial supply)
    pub fn initialize(
        env: Env,
        admin: Address,
        name: String,
        symbol: String,
        initial_supply: i128,
    ) -> Result<(), TokenError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(TokenError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Name, &name);
        env.storage().instance().set(&DataKey::Symbol, &symbol);
        env.storage().instance().set(&DataKey::Decimals, &7u32);

        if initial_supply > 0 {
            set_balance(&env, &admin, initial_supply);
            set_total_supply(&env, initial_supply);
        }

        Ok(())
    }

    /// Transfer tokens from caller to recipient
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        do_transfer(&env, &from, &to, amount)
    }

    /// Approve spender to spend up to `amount` on behalf of owner
    pub fn approve(
        env: Env,
        owner: Address,
        spender: Address,
        amount: i128,
        _expiration_ledger: u32,
    ) -> Result<(), TokenError> {
        owner.require_auth();
        if amount < 0 {
            return Err(TokenError::InvalidAmount);
        }
        set_allowance(&env, &owner, &spender, amount);
        Ok(())
    }

    /// Transfer tokens using a pre-approved allowance
    pub fn transfer_from(
        env: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        do_transfer(&env, &from, &to, amount)
    }

    /// Mint new tokens (admin only)
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        let admin = get_admin(&env);
        admin.require_auth();
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        let bal = get_balance(&env, &to);
        set_balance(&env, &to, bal.checked_add(amount).ok_or(TokenError::OverflowError)?);
        let supply = get_total_supply(&env);
        set_total_supply(&env, supply.checked_add(amount).ok_or(TokenError::OverflowError)?);
        Ok(())
    }

    /// Burn tokens from an address (requires auth from that address)
    pub fn burn(env: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        let bal = get_balance(&env, &from);
        if bal < amount {
            return Err(TokenError::InsufficientBalance);
        }
        set_balance(&env, &from, bal - amount);
        let supply = get_total_supply(&env);
        set_total_supply(&env, supply - amount);
        Ok(())
    }

    /// Burn tokens from address using spender allowance
    pub fn burn_from(env: Env, spender: Address, from: Address, amount: i128) -> Result<(), TokenError> {
        spender.require_auth();
        spend_allowance(&env, &from, &spender, amount)?;
        if amount <= 0 {
            return Err(TokenError::InvalidAmount);
        }
        let bal = get_balance(&env, &from);
        if bal < amount {
            return Err(TokenError::InsufficientBalance);
        }
        set_balance(&env, &from, bal - amount);
        let supply = get_total_supply(&env);
        set_total_supply(&env, supply - amount);
        Ok(())
    }

    // ── Read-only queries ────────────────────────────────────

    pub fn balance(env: Env, addr: Address) -> i128 {
        get_balance(&env, &addr)
    }

    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        get_allowance(&env, &owner, &spender)
    }

    pub fn total_supply(env: Env) -> i128 {
        get_total_supply(&env)
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&DataKey::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&DataKey::Symbol).unwrap()
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Decimals).unwrap_or(7)
    }

    /// Change admin address (admin only)
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), TokenError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    pub fn admin(env: Env) -> Address {
        get_admin(&env)
    }
}

// ── Tests ─────────────────────────────────────────────────────

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_initialize_and_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OlighftToken);
        let client = OlighftTokenClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let supply = 1_000_000_0000000i128; // 1M with 7 decimals

        client.initialize(
            &admin,
            &String::from_str(&env, "OLIGHFT Smart Coin"),
            &String::from_str(&env, "OLIGHFT"),
            &supply,
        );

        assert_eq!(client.balance(&admin), supply);
        assert_eq!(client.total_supply(), supply);
        assert_eq!(client.decimals(), 7);
    }

    #[test]
    fn test_transfer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OlighftToken);
        let client = OlighftTokenClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);
        let supply = 1_000_0000000i128;

        client.initialize(
            &admin,
            &String::from_str(&env, "OLIGHFT"),
            &String::from_str(&env, "OLI"),
            &supply,
        );

        client.transfer(&admin, &user, &500_0000000);
        assert_eq!(client.balance(&admin), 500_0000000);
        assert_eq!(client.balance(&user), 500_0000000);
    }

    #[test]
    fn test_mint_and_burn() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OlighftToken);
        let client = OlighftTokenClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let user = Address::generate(&env);

        client.initialize(
            &admin,
            &String::from_str(&env, "OLIGHFT"),
            &String::from_str(&env, "OLI"),
            &0,
        );

        client.mint(&user, &1000_0000000);
        assert_eq!(client.balance(&user), 1000_0000000);
        assert_eq!(client.total_supply(), 1000_0000000);

        client.burn(&user, &300_0000000);
        assert_eq!(client.balance(&user), 700_0000000);
        assert_eq!(client.total_supply(), 700_0000000);
    }

    #[test]
    fn test_approve_and_transfer_from() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, OlighftToken);
        let client = OlighftTokenClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let owner = Address::generate(&env);
        let spender = Address::generate(&env);
        let recipient = Address::generate(&env);

        client.initialize(
            &admin,
            &String::from_str(&env, "OLIGHFT"),
            &String::from_str(&env, "OLI"),
            &0,
        );

        client.mint(&owner, &1000_0000000);
        client.approve(&owner, &spender, &500_0000000, &1000);
        assert_eq!(client.allowance(&owner, &spender), 500_0000000);

        client.transfer_from(&spender, &owner, &recipient, &200_0000000);
        assert_eq!(client.balance(&owner), 800_0000000);
        assert_eq!(client.balance(&recipient), 200_0000000);
        assert_eq!(client.allowance(&owner, &spender), 300_0000000);
    }
}
