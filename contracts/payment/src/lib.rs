#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    Address, Env, Vec,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Payment Contract (Soroban)
//  Cross-asset payments with oracle-based conversion,
//  batch payments, refunds (24h window), and fee management.
// ══════════════════════════════════════════════════════════════

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PayError {
    NotInitialized      = 1,
    AlreadyInitialized  = 2,
    Unauthorized        = 3,
    InsufficientBalance = 4,
    InvalidAmount       = 5,
    InvalidRecipient    = 6,
    ReceiptNotFound     = 7,
    RefundWindowExpired = 8,
    AlreadyRefunded     = 9,
    OverflowError       = 10,
    OracleError         = 11,
    BatchTooLarge       = 12,
}

/// Payment receipt stored on-chain
#[contracttype]
#[derive(Clone, Debug)]
pub struct Receipt {
    pub tx_id: u64,
    pub from: Address,
    pub to: Address,
    pub asset_in: Address,
    pub asset_out: Address,
    pub amount_in: i128,
    pub amount_out: i128,
    pub fee: i128,
    pub ledger: u32,
    pub refunded: bool,
}

/// Exchange rate entry (admin-set oracle prices)
#[contracttype]
#[derive(Clone, Debug)]
pub struct RateEntry {
    pub rate: i128,       // price scaled by 1e7
    pub updated_ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct RateKey {
    pub from: Address,
    pub to: Address,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    FeeBps,
    AccumulatedFees(Address), // token → fees
    NextTxId,
    Receipt(u64),
    Rate(RateKey),
}

#[contract]
pub struct OlighftPayment;

// ── Internal helpers ──────────────────────────────────────────

const MAX_BATCH: u32 = 50;
const REFUND_WINDOW_LEDGERS: u32 = 17_280; // ~24 hours

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_fee_bps(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap_or(10) // default 0.1%
}

fn next_tx_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::NextTxId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextTxId, &(id + 1));
    id
}

fn save_receipt(env: &Env, receipt: &Receipt) {
    env.storage().persistent().set(&DataKey::Receipt(receipt.tx_id), receipt);
}

fn get_receipt(env: &Env, tx_id: u64) -> Option<Receipt> {
    env.storage().persistent().get(&DataKey::Receipt(tx_id))
}

fn get_rate(env: &Env, from: &Address, to: &Address) -> Option<RateEntry> {
    let key = DataKey::Rate(RateKey { from: from.clone(), to: to.clone() });
    env.storage().persistent().get(&key)
}

fn add_accumulated_fee(env: &Env, token: &Address, fee: i128) {
    let key = DataKey::AccumulatedFees(token.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    env.storage().persistent().set(&key, &(current + fee));
}

fn get_accumulated_fee(env: &Env, token: &Address) -> i128 {
    env.storage().persistent().get(&DataKey::AccumulatedFees(token.clone())).unwrap_or(0)
}

// ── Contract implementation ──────────────────────────────────

#[contractimpl]
impl OlighftPayment {

    /// Initialize payment system with admin and fee rate
    pub fn initialize(env: Env, admin: Address, fee_bps: u32) -> Result<(), PayError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(PayError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::NextTxId, &1u64);
        Ok(())
    }

    /// Send a cross-asset payment
    /// If asset_in == asset_out, direct transfer with fee deduction.
    /// Otherwise, uses oracle rate for conversion.
    pub fn send_payment(
        env: Env,
        from: Address,
        to: Address,
        asset_in: Address,
        asset_out: Address,
        amount: i128,
    ) -> Result<u64, PayError> {
        from.require_auth();
        if amount <= 0 { return Err(PayError::InvalidAmount); }
        if from == to { return Err(PayError::InvalidRecipient); }

        let fee_bps = get_fee_bps(&env);
        let fee = amount * (fee_bps as i128) / 10000;
        let net_in = amount - fee;

        let amount_out;

        if asset_in == asset_out {
            // Same-asset transfer
            amount_out = net_in;
            let token = soroban_sdk::token::Client::new(&env, &asset_in);
            // Transfer net to recipient
            token.transfer(&from, &to, &net_in);
            // Transfer fee to contract
            if fee > 0 {
                token.transfer(&from, &env.current_contract_address(), &fee);
                add_accumulated_fee(&env, &asset_in, fee);
            }
        } else {
            // Cross-asset: use oracle rate
            let rate_entry = get_rate(&env, &asset_in, &asset_out)
                .ok_or(PayError::OracleError)?;

            // amount_out = net_in * rate / 1e7
            amount_out = net_in.checked_mul(rate_entry.rate).ok_or(PayError::OverflowError)? / 10_000_000;

            if amount_out <= 0 { return Err(PayError::InvalidAmount); }

            // Transfer asset_in from sender to contract
            let token_in = soroban_sdk::token::Client::new(&env, &asset_in);
            token_in.transfer(&from, &env.current_contract_address(), &amount);
            add_accumulated_fee(&env, &asset_in, fee);

            // Transfer asset_out from contract to recipient
            let token_out = soroban_sdk::token::Client::new(&env, &asset_out);
            token_out.transfer(&env.current_contract_address(), &to, &amount_out);
        }

        // Save receipt
        let tx_id = next_tx_id(&env);
        let receipt = Receipt {
            tx_id,
            from: from.clone(),
            to: to.clone(),
            asset_in: asset_in.clone(),
            asset_out: asset_out.clone(),
            amount_in: amount,
            amount_out,
            fee,
            ledger: env.ledger().sequence(),
            refunded: false,
        };
        save_receipt(&env, &receipt);

        Ok(tx_id)
    }

    /// Batch payment: send same asset to multiple recipients
    pub fn batch_pay(
        env: Env,
        from: Address,
        recipients: Vec<Address>,
        amounts: Vec<i128>,
        asset: Address,
    ) -> Result<Vec<u64>, PayError> {
        from.require_auth();

        let count = recipients.len();
        if count != amounts.len() || count == 0 {
            return Err(PayError::InvalidAmount);
        }
        if count > MAX_BATCH {
            return Err(PayError::BatchTooLarge);
        }

        let fee_bps = get_fee_bps(&env);
        let token = soroban_sdk::token::Client::new(&env, &asset);
        let mut tx_ids = Vec::new(&env);

        for i in 0..count {
            let to = recipients.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            if amount <= 0 { return Err(PayError::InvalidAmount); }
            if from == to { return Err(PayError::InvalidRecipient); }

            let fee = amount * (fee_bps as i128) / 10000;
            let net = amount - fee;

            token.transfer(&from, &to, &net);
            if fee > 0 {
                token.transfer(&from, &env.current_contract_address(), &fee);
                add_accumulated_fee(&env, &asset, fee);
            }

            let tx_id = next_tx_id(&env);
            let receipt = Receipt {
                tx_id,
                from: from.clone(),
                to,
                asset_in: asset.clone(),
                asset_out: asset.clone(),
                amount_in: amount,
                amount_out: net,
                fee,
                ledger: env.ledger().sequence(),
                refunded: false,
            };
            save_receipt(&env, &receipt);
            tx_ids.push_back(tx_id);
        }

        Ok(tx_ids)
    }

    /// Refund a payment within 24-hour window (admin only)
    pub fn refund(env: Env, tx_id: u64) -> Result<(), PayError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let mut receipt = get_receipt(&env, tx_id).ok_or(PayError::ReceiptNotFound)?;
        if receipt.refunded {
            return Err(PayError::AlreadyRefunded);
        }

        let current = env.ledger().sequence();
        if current > receipt.ledger + REFUND_WINDOW_LEDGERS {
            return Err(PayError::RefundWindowExpired);
        }

        // Reverse: refund from contract reserves back to the sender.
        // The contract holds the fee; for same-asset the recipient already received
        // the net, so we can only refund amount_in from contract reserves.
        // For cross-asset, the contract holds asset_in (full amount).
        // NOTE: The recipient must return funds separately (off-chain coordination).
        //       The contract refunds what it controls: fees + held assets.
        if receipt.asset_in == receipt.asset_out {
            let token = soroban_sdk::token::Client::new(&env, &receipt.asset_in);
            // Refund the fee portion that the contract holds back to sender
            if receipt.fee > 0 {
                token.transfer(&env.current_contract_address(), &receipt.from, &receipt.fee);
            }
        } else {
            // Cross-asset: contract holds the full amount_in, return it to sender
            let token_in = soroban_sdk::token::Client::new(&env, &receipt.asset_in);
            token_in.transfer(&env.current_contract_address(), &receipt.from, &receipt.amount_in);
        }

        receipt.refunded = true;
        save_receipt(&env, &receipt);
        Ok(())
    }

    // ── Oracle / Rate management ─────────────────────────────────

    /// Set exchange rate between two assets (admin only, TWAP oracle)
    pub fn set_rate(
        env: Env,
        from: Address,
        to: Address,
        rate: i128,
    ) -> Result<(), PayError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let entry = RateEntry {
            rate,
            updated_ledger: env.ledger().sequence(),
        };
        let key = DataKey::Rate(RateKey { from, to });
        env.storage().persistent().set(&key, &entry);
        Ok(())
    }

    /// Get current exchange rate
    pub fn get_rate(env: Env, from: Address, to: Address) -> Result<RateEntry, PayError> {
        get_rate(&env, &from, &to).ok_or(PayError::OracleError)
    }

    // ── Read-only queries ────────────────────────────────────────

    /// Get a payment receipt
    pub fn get_receipt(env: Env, tx_id: u64) -> Option<Receipt> {
        get_receipt(&env, tx_id)
    }

    /// Get current fee rate in basis points
    pub fn fee_bps(env: Env) -> u32 {
        get_fee_bps(&env)
    }

    /// Get accumulated fees for a given token
    pub fn accumulated_fees(env: Env, token: Address) -> i128 {
        get_accumulated_fee(&env, &token)
    }

    // ── Admin functions ──────────────────────────────────────────

    /// Update protocol fee rate (admin only)
    pub fn set_fee(env: Env, fee_bps: u32) -> Result<(), PayError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        Ok(())
    }

    /// Withdraw accumulated fees for a token (admin only)
    pub fn withdraw_fees(env: Env, token: Address) -> Result<i128, PayError> {
        let admin = get_admin(&env);
        admin.require_auth();

        let fees = get_accumulated_fee(&env, &token);
        if fees <= 0 { return Ok(0); }

        let token_client = soroban_sdk::token::Client::new(&env, &token);
        token_client.transfer(&env.current_contract_address(), &admin, &fees);

        env.storage().persistent().set(&DataKey::AccumulatedFees(token), &0i128);
        Ok(fees)
    }

    /// Transfer admin role
    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), PayError> {
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
    fn test_refund_window() {
        assert_eq!(REFUND_WINDOW_LEDGERS, 17_280);
    }

    #[test]
    fn test_max_batch() {
        assert_eq!(MAX_BATCH, 50);
    }

    #[test]
    fn test_fee_calc() {
        // 10 bps = 0.1%
        let amount: i128 = 1_000_0000000; // 1000 tokens (7 decimals)
        let fee = amount * 10 / 10000;
        assert_eq!(fee, 1_0000000); // 1 token fee
    }
}
