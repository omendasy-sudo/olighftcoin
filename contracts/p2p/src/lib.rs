#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, contracterror,
    symbol_short, Address, Env, Vec,
};

// ══════════════════════════════════════════════════════════════
//  OLIGHFT SMART COIN — Automatic P2P Trading Contract
//  On-chain order book with auto-matching engine.
//  Buy/sell orders are matched by price, tokens locked in contract.
// ══════════════════════════════════════════════════════════════

// ── Errors ───────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum P2PError {
    NotInitialized     = 1,
    AlreadyInitialized = 2,
    Unauthorized       = 3,
    InvalidAmount      = 4,
    InvalidPrice       = 5,
    OrderNotFound      = 6,
    OrderNotActive     = 7,
    SelfTrade          = 8,
    InsufficientFill   = 9,
    OverflowError      = 10,
    OrderExpired       = 11,
}

// ── Data types ───────────────────────────────────────────────

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OrderSide {
    Buy  = 0,
    Sell = 1,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum OrderStatus {
    Active    = 0,
    Filled    = 1,
    Partial   = 2,
    Cancelled = 3,
    Expired   = 4,
}

/// On-chain order record
#[contracttype]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    pub owner: Address,
    pub side: OrderSide,
    pub token: Address,
    pub pay_token: Address,
    pub amount: i128,          // total order amount (in token)
    pub filled: i128,          // amount already filled
    pub price: i128,           // price per token in pay_token (7 decimals)
    pub status: OrderStatus,
    pub created_ledger: u32,
    pub deadline_ledger: u32,
}

/// Trade record (each match produces one)
#[contracttype]
#[derive(Clone, Debug)]
pub struct Trade {
    pub id: u64,
    pub buy_order_id: u64,
    pub sell_order_id: u64,
    pub buyer: Address,
    pub seller: Address,
    pub amount: i128,
    pub price: i128,
    pub total_cost: i128,
    pub fee: i128,
    pub ledger: u32,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    FeeBps,
    NextOrderId,
    NextTradeId,
    Order(u64),
    Trade(u64),
    UserOrders(Address),
    UserTrades(Address),
    BuyOrders,       // Vec<u64> sorted by price desc (best buy first)
    SellOrders,      // Vec<u64> sorted by price asc (best sell first)
}

// ── Constants ────────────────────────────────────────────────

const LEDGERS_PER_DAY: u32 = 17_280;
const DEFAULT_EXPIRY_DAYS: u32 = 7;
const MAX_EXPIRY_DAYS: u32 = 90;
const MAX_MATCHES_PER_TX: u32 = 10;
const BUMP_INSTANCE: u32 = LEDGERS_PER_DAY * 30;
const BUMP_PERSISTENT: u32 = LEDGERS_PER_DAY * 90;

// ── Contract ─────────────────────────────────────────────────

#[contract]
pub struct OlighftP2P;

// ── Internal helpers ─────────────────────────────────────────

fn get_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).expect("not init")
}

fn get_fee_bps(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap_or(50)
}

fn get_treasury(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Treasury)
}

fn next_order_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::NextOrderId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextOrderId, &(id + 1));
    id
}

fn next_trade_id(env: &Env) -> u64 {
    let id: u64 = env.storage().instance().get(&DataKey::NextTradeId).unwrap_or(1);
    env.storage().instance().set(&DataKey::NextTradeId, &(id + 1));
    id
}

fn get_order(env: &Env, id: u64) -> Option<Order> {
    env.storage().persistent().get(&DataKey::Order(id))
}

fn set_order(env: &Env, order: &Order) {
    env.storage().persistent().set(&DataKey::Order(order.id), order);
    env.storage().persistent().extend_ttl(
        &DataKey::Order(order.id), BUMP_PERSISTENT, BUMP_PERSISTENT,
    );
}

fn set_trade(env: &Env, trade: &Trade) {
    env.storage().persistent().set(&DataKey::Trade(trade.id), trade);
    env.storage().persistent().extend_ttl(
        &DataKey::Trade(trade.id), BUMP_PERSISTENT, BUMP_PERSISTENT,
    );
}

fn push_id(env: &Env, key: &DataKey, id: u64) {
    let mut ids: Vec<u64> = env.storage().persistent().get(key).unwrap_or(Vec::new(env));
    ids.push_back(id);
    env.storage().persistent().set(key, &ids);
    env.storage().persistent().extend_ttl(key, BUMP_PERSISTENT, BUMP_PERSISTENT);
}

fn get_id_list(env: &Env, key: &DataKey) -> Vec<u64> {
    env.storage().persistent().get(key).unwrap_or(Vec::new(env))
}

fn set_id_list(env: &Env, key: &DataKey, ids: &Vec<u64>) {
    env.storage().persistent().set(key, ids);
    env.storage().persistent().extend_ttl(key, BUMP_PERSISTENT, BUMP_PERSISTENT);
}

fn remove_from_list(env: &Env, key: &DataKey, id: u64) {
    let ids = get_id_list(env, key);
    let mut new_ids = Vec::new(env);
    for i in 0..ids.len() {
        let v = ids.get(i).unwrap();
        if v != id {
            new_ids.push_back(v);
        }
    }
    set_id_list(env, key, &new_ids);
}

fn bump_instance(env: &Env) {
    env.storage().instance().extend_ttl(BUMP_INSTANCE, BUMP_INSTANCE);
}

/// Calculate: (amount * price) / STROOPS, where price has 7 decimals
fn calc_cost(amount: i128, price: i128) -> Result<i128, P2PError> {
    amount
        .checked_mul(price)
        .ok_or(P2PError::OverflowError)?
        .checked_div(10_000_000)
        .ok_or(P2PError::OverflowError)
}

// ── Implementation ───────────────────────────────────────────

#[contractimpl]
impl OlighftP2P {

    // ── Admin ────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address, fee_bps: u32) -> Result<(), P2PError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(P2PError::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &admin);
        env.storage().instance().set(&DataKey::FeeBps, &fee_bps);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
        env.storage().instance().set(&DataKey::NextTradeId, &1u64);
        bump_instance(&env);
        Ok(())
    }

    pub fn set_fee(env: Env, new_fee_bps: u32) -> Result<(), P2PError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::FeeBps, &new_fee_bps);
        bump_instance(&env);
        Ok(())
    }

    pub fn set_treasury(env: Env, treasury: Address) -> Result<(), P2PError> {
        let admin = get_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        bump_instance(&env);
        Ok(())
    }

    // ── Place Order ──────────────────────────────────────────

    /// Place a buy or sell order. Tokens are locked immediately.
    /// The engine then tries to auto-match against opposing orders.
    ///
    /// For BUY:  lock pay_token (the quote currency, e.g. USDC)
    /// For SELL: lock token (the base currency, e.g. OLIGHFT)
    ///
    /// Returns the order ID.
    pub fn place_order(
        env: Env,
        owner: Address,
        side: OrderSide,
        token: Address,
        pay_token: Address,
        amount: i128,
        price: i128,
        expiry_days: u32,
    ) -> Result<u64, P2PError> {
        owner.require_auth();
        if amount <= 0 { return Err(P2PError::InvalidAmount); }
        if price <= 0 { return Err(P2PError::InvalidPrice); }

        let days = if expiry_days == 0 { DEFAULT_EXPIRY_DAYS }
                   else if expiry_days > MAX_EXPIRY_DAYS { MAX_EXPIRY_DAYS }
                   else { expiry_days };

        let current = env.ledger().sequence();
        let deadline = current + (days * LEDGERS_PER_DAY);

        // Lock tokens from the maker
        let total_cost = calc_cost(amount, price)?;
        match side {
            OrderSide::Buy => {
                // Buyer locks pay_token (e.g. USDC) covering total cost
                let pay_client = soroban_sdk::token::Client::new(&env, &pay_token);
                pay_client.transfer(&owner, &env.current_contract_address(), &total_cost);
            }
            OrderSide::Sell => {
                // Seller locks the base token (e.g. OLIGHFT)
                let token_client = soroban_sdk::token::Client::new(&env, &token);
                token_client.transfer(&owner, &env.current_contract_address(), &amount);
            }
        }

        let id = next_order_id(&env);
        let order = Order {
            id,
            owner: owner.clone(),
            side,
            token: token.clone(),
            pay_token: pay_token.clone(),
            amount,
            filled: 0,
            price,
            status: OrderStatus::Active,
            created_ledger: current,
            deadline_ledger: deadline,
        };

        set_order(&env, &order);
        push_id(&env, &DataKey::UserOrders(owner), id);

        // Add to the correct side of the book
        match side {
            OrderSide::Buy => push_id(&env, &DataKey::BuyOrders, id),
            OrderSide::Sell => push_id(&env, &DataKey::SellOrders, id),
        }

        // Auto-match
        Self::try_match(&env, id)?;

        env.events().publish(
            (symbol_short!("p2p"), symbol_short!("order")),
            (id, owner.clone()),
        );

        bump_instance(&env);
        Ok(id)
    }

    // ── Auto-match engine ────────────────────────────────────

    /// Try to fill the given order against the opposing book.
    fn try_match(env: &Env, order_id: u64) -> Result<(), P2PError> {
        let mut taker = match get_order(env, order_id) {
            Some(o) => o,
            None => return Ok(()),
        };
        if taker.status != OrderStatus::Active { return Ok(()); }

        let opposing_key = match taker.side {
            OrderSide::Buy => DataKey::SellOrders,
            OrderSide::Sell => DataKey::BuyOrders,
        };

        let opposing_ids = get_id_list(env, &opposing_key);
        let fee_bps = get_fee_bps(env);
        let mut matches_done: u32 = 0;

        for i in 0..opposing_ids.len() {
            if matches_done >= MAX_MATCHES_PER_TX { break; }
            let remaining = taker.amount - taker.filled;
            if remaining <= 0 { break; }

            let maker_id = opposing_ids.get(i).unwrap();
            let mut maker = match get_order(env, maker_id) {
                Some(o) => o,
                None => continue,
            };

            // Skip inactive, same owner, different token pair, or expired
            if maker.status != OrderStatus::Active { continue; }
            if maker.owner == taker.owner { continue; }
            if maker.token != taker.token || maker.pay_token != taker.pay_token { continue; }
            if env.ledger().sequence() > maker.deadline_ledger { continue; }

            // Price compatibility:
            // Buy taker: taker.price >= maker.price (willing to pay at least maker's ask)
            // Sell taker: taker.price <= maker.price (willing to accept at most maker's bid)
            let prices_match = match taker.side {
                OrderSide::Buy => taker.price >= maker.price,
                OrderSide::Sell => taker.price <= maker.price,
            };
            if !prices_match { continue; }

            // Execute price = maker's price (maker was first)
            let exec_price = maker.price;
            let maker_remaining = maker.amount - maker.filled;
            let fill_amount = if remaining < maker_remaining { remaining } else { maker_remaining };
            let fill_cost = calc_cost(fill_amount, exec_price)?;

            // Determine buyer and seller
            let (buyer, seller, buy_order_id, sell_order_id) = match taker.side {
                OrderSide::Buy => (
                    taker.owner.clone(), maker.owner.clone(), taker.id, maker.id,
                ),
                OrderSide::Sell => (
                    maker.owner.clone(), taker.owner.clone(), maker.id, taker.id,
                ),
            };

            // Calculate fee (charged on the trade amount)
            let fee = fill_amount * (fee_bps as i128) / 10_000;
            let seller_receives = fill_amount - fee;

            // Transfer tokens
            let token_client = soroban_sdk::token::Client::new(env, &taker.token);
            let pay_client = soroban_sdk::token::Client::new(env, &taker.pay_token);

            // Seller gets pay_token (e.g. USDC)
            pay_client.transfer(
                &env.current_contract_address(), &seller, &fill_cost,
            );

            // Buyer gets token minus fee (e.g. OLIGHFT)
            token_client.transfer(
                &env.current_contract_address(), &buyer, &seller_receives,
            );

            // Fee to treasury
            if fee > 0 {
                if let Some(treasury) = get_treasury(env) {
                    token_client.transfer(
                        &env.current_contract_address(), &treasury, &fee,
                    );
                }
            }

            // Update fills
            taker.filled += fill_amount;
            maker.filled += fill_amount;

            // Update statuses
            if maker.filled >= maker.amount {
                maker.status = OrderStatus::Filled;
                remove_from_list(env, &opposing_key, maker.id);
            } else {
                maker.status = OrderStatus::Partial;
            }
            set_order(env, &maker);

            // Record trade
            let trade_id = next_trade_id(env);
            let trade = Trade {
                id: trade_id,
                buy_order_id,
                sell_order_id,
                buyer: buyer.clone(),
                seller: seller.clone(),
                amount: fill_amount,
                price: exec_price,
                total_cost: fill_cost,
                fee,
                ledger: env.ledger().sequence(),
            };
            set_trade(env, &trade);
            push_id(env, &DataKey::UserTrades(buyer), trade_id);
            push_id(env, &DataKey::UserTrades(seller), trade_id);

            matches_done += 1;
        }

        // Update taker status
        if taker.filled >= taker.amount {
            taker.status = OrderStatus::Filled;
            let taker_key = match taker.side {
                OrderSide::Buy => DataKey::BuyOrders,
                OrderSide::Sell => DataKey::SellOrders,
            };
            remove_from_list(env, &taker_key, taker.id);
        } else if taker.filled > 0 {
            taker.status = OrderStatus::Partial;
        }
        set_order(env, &taker);

        Ok(())
    }

    // ── Cancel Order ─────────────────────────────────────────

    /// Cancel an active/partial order. Refunds remaining locked tokens.
    pub fn cancel_order(env: Env, order_id: u64) -> Result<(), P2PError> {
        let mut order = get_order(&env, order_id)
            .ok_or(P2PError::OrderNotFound)?;
        if order.status != OrderStatus::Active && order.status != OrderStatus::Partial {
            return Err(P2PError::OrderNotActive);
        }
        order.owner.require_auth();

        let remaining = order.amount - order.filled;

        // Refund remaining locked tokens
        if remaining > 0 {
            match order.side {
                OrderSide::Buy => {
                    let refund_cost = calc_cost(remaining, order.price)?;
                    let pay_client = soroban_sdk::token::Client::new(&env, &order.pay_token);
                    pay_client.transfer(
                        &env.current_contract_address(), &order.owner, &refund_cost,
                    );
                }
                OrderSide::Sell => {
                    let token_client = soroban_sdk::token::Client::new(&env, &order.token);
                    token_client.transfer(
                        &env.current_contract_address(), &order.owner, &remaining,
                    );
                }
            }
        }

        order.status = OrderStatus::Cancelled;
        set_order(&env, &order);

        let book_key = match order.side {
            OrderSide::Buy => DataKey::BuyOrders,
            OrderSide::Sell => DataKey::SellOrders,
        };
        remove_from_list(&env, &book_key, order.id);

        bump_instance(&env);
        Ok(())
    }

    // ── Read-only queries ────────────────────────────────────

    pub fn get_order(env: Env, order_id: u64) -> Result<Order, P2PError> {
        get_order(&env, order_id).ok_or(P2PError::OrderNotFound)
    }

    pub fn get_trade(env: Env, trade_id: u64) -> Result<Trade, P2PError> {
        env.storage().persistent().get(&DataKey::Trade(trade_id))
            .ok_or(P2PError::OrderNotFound)
    }

    pub fn get_buy_orders(env: Env) -> Vec<u64> {
        get_id_list(&env, &DataKey::BuyOrders)
    }

    pub fn get_sell_orders(env: Env) -> Vec<u64> {
        get_id_list(&env, &DataKey::SellOrders)
    }

    pub fn get_user_orders(env: Env, user: Address) -> Vec<u64> {
        get_id_list(&env, &DataKey::UserOrders(user))
    }

    pub fn get_user_trades(env: Env, user: Address) -> Vec<u64> {
        get_id_list(&env, &DataKey::UserTrades(user))
    }

    pub fn bump(env: Env) {
        bump_instance(&env);
    }
}

// ══════════════════════════════════════════════════════════════
//  Tests
// ══════════════════════════════════════════════════════════════

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::token::{StellarAssetClient, TokenClient};

    fn setup_token(env: &Env, admin: &Address) -> (Address, TokenClient, StellarAssetClient) {
        let addr = env.register_stellar_asset_contract(admin.clone());
        let client = TokenClient::new(env, &addr);
        let sac = StellarAssetClient::new(env, &addr);
        (addr, client, sac)
    }

    #[test]
    fn test_auto_match_buy_sell() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let alice = Address::generate(&env);  // seller
        let bob = Address::generate(&env);    // buyer

        let (olighft, olighft_client, olighft_sac) = setup_token(&env, &admin);
        let (usdc, usdc_client, usdc_sac) = setup_token(&env, &admin);

        // Mint: Alice gets OLIGHFT, Bob gets USDC
        olighft_sac.mint(&alice, &10_000_0000000);
        usdc_sac.mint(&bob, &10_000_0000000);

        let p2p_id = env.register_contract(None, OlighftP2P);
        let client = OlighftP2PClient::new(&env, &p2p_id);
        client.initialize(&admin, &50); // 0.5% fee

        // Alice: sell 100 OLIGHFT at 0.50 USDC each
        let sell_amount: i128 = 100_0000000;
        let price: i128 = 5000000; // 0.50 with 7 decimals
        let sell_id = client.place_order(
            &alice, &OrderSide::Sell, &olighft, &usdc, &sell_amount, &price, &7,
        );
        assert_eq!(sell_id, 1);

        // Alice's 100 OLIGHFT locked
        let alice_bal = olighft_client.balance(&alice);
        assert_eq!(alice_bal, 10_000_0000000 - 100_0000000);

        // Bob: buy 100 OLIGHFT at 0.50 USDC each → should auto-match
        let buy_id = client.place_order(
            &bob, &OrderSide::Buy, &olighft, &usdc, &sell_amount, &price, &7,
        );
        assert_eq!(buy_id, 2);

        // Both should be filled
        let sell_order = client.get_order(&sell_id);
        assert_eq!(sell_order.status, OrderStatus::Filled);
        let buy_order = client.get_order(&buy_id);
        assert_eq!(buy_order.status, OrderStatus::Filled);

        // Alice receives USDC: 100 * 0.50 = 50 USDC
        let alice_usdc = usdc_client.balance(&alice);
        assert_eq!(alice_usdc, 50_0000000);

        // Bob receives OLIGHFT minus 0.5% fee: 100 - 0.5 = 99.5
        let bob_olighft = olighft_client.balance(&bob);
        assert_eq!(bob_olighft, 99_5000000);
    }

    #[test]
    fn test_partial_fill() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let alice = Address::generate(&env);
        let bob = Address::generate(&env);

        let (olighft, olighft_client, olighft_sac) = setup_token(&env, &admin);
        let (usdc, _usdc_client, usdc_sac) = setup_token(&env, &admin);

        olighft_sac.mint(&alice, &10_000_0000000);
        usdc_sac.mint(&bob, &10_000_0000000);

        let p2p_id = env.register_contract(None, OlighftP2P);
        let client = OlighftP2PClient::new(&env, &p2p_id);
        client.initialize(&admin, &50);

        let price: i128 = 5000000; // 0.50

        // Alice sells 200 OLIGHFT
        let sell_id = client.place_order(
            &alice, &OrderSide::Sell, &olighft, &usdc, &200_0000000, &price, &7,
        );

        // Bob buys only 50 OLIGHFT → partial fill
        let buy_id = client.place_order(
            &bob, &OrderSide::Buy, &olighft, &usdc, &50_0000000, &price, &7,
        );

        let sell_order = client.get_order(&sell_id);
        assert_eq!(sell_order.status, OrderStatus::Partial);
        assert_eq!(sell_order.filled, 50_0000000);

        let buy_order = client.get_order(&buy_id);
        assert_eq!(buy_order.status, OrderStatus::Filled);
    }

    #[test]
    fn test_cancel_order() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let alice = Address::generate(&env);

        let (olighft, olighft_client, olighft_sac) = setup_token(&env, &admin);
        let (usdc, _usdc_client, _usdc_sac) = setup_token(&env, &admin);

        olighft_sac.mint(&alice, &1_000_0000000);

        let p2p_id = env.register_contract(None, OlighftP2P);
        let client = OlighftP2PClient::new(&env, &p2p_id);
        client.initialize(&admin, &50);

        // Alice sells 500 OLIGHFT
        let sell_id = client.place_order(
            &alice, &OrderSide::Sell, &olighft, &usdc, &500_0000000, &5000000, &7,
        );

        // 500 locked
        assert_eq!(olighft_client.balance(&alice), 500_0000000);

        // Cancel
        client.cancel_order(&sell_id);
        let order = client.get_order(&sell_id);
        assert_eq!(order.status, OrderStatus::Cancelled);

        // 500 refunded
        assert_eq!(olighft_client.balance(&alice), 1_000_0000000);
    }
}
