# OLIGHFT Smart Coin — Soroban Smart Contracts

## Architecture

```
contracts/
├── Cargo.toml              # Workspace root
├── token/                  # SEP-41 Token (OLIGHFT)
│   ├── Cargo.toml
│   └── src/lib.rs          # initialize, transfer, mint, burn, approve, transfer_from
│
├── staking/                # Staking Pool Engine
│   ├── Cargo.toml
│   └── src/lib.rs          # stake, unstake, compound, claim_rewards, lock-boost, auto-compound
│
├── card_staking/           # Card Tier Staking (6 tiers, 10 max per card)
│   ├── Cargo.toml
│   └── src/lib.rs          # activate_stake, withdraw_stake, restake, claim_rewards, 8-gen commissions
│
├── swap_amm/               # DEX / AMM (x*y=k)
│   ├── Cargo.toml
│   └── src/lib.rs          # create_pool, add_liquidity, remove_liquidity, swap, get_quote
│
├── payment/                # Cross-Asset Payments
│   ├── Cargo.toml
│   └── src/lib.rs          # send_payment, batch_pay, refund, oracle rates, fee management
│
└── invite/                 # Invite & Sponsor System
    ├── Cargo.toml
    └── src/lib.rs          # register_invite, distribute_commission, 5-stage, 8-gen tree
```

## Contracts Overview

### 1. Token Contract (`olighft-token`)
- **SEP-41 compliant** Stellar token interface
- `initialize(admin, name, symbol, initial_supply)` — Deploy with admin and supply
- `transfer(from, to, amount)` — Standard transfer
- `approve(owner, spender, amount)` — ERC-20-style allowance
- `transfer_from(spender, from, to, amount)` — Spend approved allowance
- `mint(to, amount)` — Admin-only minting
- `burn(from, amount)` — Token burning
- `burn_from(spender, from, amount)` — Burn via allowance
- Read: `balance`, `allowance`, `total_supply`, `name`, `symbol`, `decimals`

### 2. Staking Contract (`olighft-staking`)
- **Lock-period boosts**: 0d=1.0x, 30d=1.25x, 90d=1.5x, 180d=1.75x, 365d=2.0x, 730d=2.5x
- **Auto-compound strategies**: Manual, Daily, Twice-daily, Weekly, Monthly
- `stake(user, amount, lock_days, auto_compound)` — Stake with lock and strategy
- `unstake(user, amount)` — Withdraw after lock expires
- `compound(user)` — Reinvest rewards into principal
- `claim_rewards(user)` — Withdraw rewards only
- `set_rewards(reward_per_ledger)` — Admin reward rate
- `set_paused(paused)` — Emergency pause
- Read: `pending_rewards`, `get_position`, `get_pool_info`

### 3. Card Staking Contract (`olighft-card-staking`)
- **6 card tiers**: Visa, Gold, Platinum, Black, Amex, Mastercard
- **Max 10 active stakes per card per user**
- **8-generation binary tree** sponsor commissions on activation
- `set_card_config(tier, min_stake, lock_days, apy_bps, max_stakes, commission_bps)` — Admin config
- `activate_stake(staker, tier, amount)` — New stake on a card
- `withdraw_stake(staker, tier, stake_index)` — Withdraw after lock (2FA off-chain)
- `restake(staker, tier, stake_index)` — Compound and re-lock
- `claim_rewards(staker, tier, stake_index)` — Claim without unstaking
- Read: `get_stakes`, `active_stake_count`, `total_staked`, `pending_rewards`

### 4. Swap/AMM Contract (`olighft-swap-amm`)
- **Constant-product AMM** (x * y = k)
- **0.3% default swap fee** with slippage protection
- `create_pool(token_a, token_b, fee_bps)` — Admin pool creation
- `add_liquidity(user, amount_a, amount_b)` → LP shares (√ formula)
- `remove_liquidity(user, shares)` → proportional tokens
- `swap(user, token_in, amount_in, min_out)` → SwapResult{amount_out, fee, impact_bps}
- `collect_fees()` / `set_fee(fee_bps)` — Admin fee management
- Read: `get_quote`, `get_reserves`, `get_price`, `lp_balance`, `total_shares`

### 5. Payment Contract (`olighft-payment`)
- **Cross-asset payments** with admin-set oracle rates
- **Batch payments** (up to 50 recipients)
- **24-hour refund window** (admin-only)
- `send_payment(from, to, asset_in, asset_out, amount)` → tx_id receipt
- `batch_pay(from, recipients, amounts, asset)` → tx_ids
- `refund(tx_id)` — Reverse within 24h (admin)
- `set_rate(from, to, rate)` — Oracle price update
- `withdraw_fees(token)` — Admin fee withdrawal
- Read: `get_receipt`, `get_rate`, `fee_bps`, `accumulated_fees`

### 6. Invite Contract (`olighft-invite`)
- **8-generation binary tree** referral system
- **5 invite stages**: Stage1 (0-4), Stage2 (5-14), Stage3 (15-29), Stage4 (30-49), Stage5 (50+)
- **Default commissions**: Gen1=10%, Gen2=5%, Gen3=2.5%, Gen4=1.25%, Gen5=1%, Gen6=0.75%, Gen7=0.5%, Gen8=0.25% (21.25% total)
- `register_invite(user, sponsor)` — Register with auto-stage calculation
- `distribute_commission(staker, stake_amount)` — Pay 8-gen commissions
- `set_commission_tiers(tiers)` / `set_stage_thresholds(thresholds)` — Admin config
- Read: `get_profile`, `get_sponsor`, `get_stage`, `get_invite_tree`, `get_direct_invites`

## Build & Deploy

### Prerequisites
```bash
# Install Rust + Soroban CLI
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
cargo install --locked soroban-cli
```

### Build All Contracts
```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown
```

### Deploy to Stellar Testnet
```bash
# Configure network
soroban network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

# Generate deployer identity
soroban keys generate deployer --network testnet

# Deploy each contract
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_token.wasm \
  --network testnet --source deployer

soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_staking.wasm \
  --network testnet --source deployer

soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_card_staking.wasm \
  --network testnet --source deployer

soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_swap_amm.wasm \
  --network testnet --source deployer

soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_payment.wasm \
  --network testnet --source deployer

soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/olighft_invite.wasm \
  --network testnet --source deployer
```

### Initialize After Deploy
```bash
# 1. Initialize token
soroban contract invoke --id <TOKEN_CONTRACT_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR> --name "OLIGHFT Smart Coin" --symbol "OLIGHFT" --initial_supply 1000000000000000

# 2. Initialize staking
soroban contract invoke --id <STAKING_CONTRACT_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR> --token_contract <TOKEN_CONTRACT_ID> --reward_per_ledger 1000000

# 3. Initialize card staking
soroban contract invoke --id <CARD_STAKING_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR> --token_contract <TOKEN_CONTRACT_ID>

# 4. Initialize AMM
soroban contract invoke --id <SWAP_AMM_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR>

# 5. Initialize payments
soroban contract invoke --id <PAYMENT_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR> --fee_bps 10

# 6. Initialize invite system
soroban contract invoke --id <INVITE_ID> --network testnet --source deployer \
  -- initialize --admin <ADMIN_ADDR> --main_wallet <MAIN_WALLET_ADDR> --token_contract <TOKEN_CONTRACT_ID>
```

### Run Tests
```bash
cd contracts
cargo test
```

## Function Mapping: HTML ↔ Soroban

| HTML File | JS Function | Soroban Contract | Soroban Function |
|-----------|-------------|-----------------|-----------------|
| wallet.html | generateMnemonic24 | — | Off-chain (client) |
| wallet.html | toggleGoogleAuth | — | Off-chain (client) |
| send.html | sendTx | `olighft-payment` | `send_payment` |
| receive.html | simulateReceive | `olighft-token` | `transfer` |
| swap.html | executeSwap | `olighft-swap-amm` | `swap` |
| card-*.html | activateCardStake | `olighft-card-staking` | `activate_stake` |
| card-*.html | withdrawCardStake | `olighft-card-staking` | `withdraw_stake` |
| card-*.html | restakeCard | `olighft-card-staking` | `restake` |
| auth.html | handleRegister | `olighft-invite` | `register_invite` |
| auth.html | handleLogin | — | Off-chain (client) |
| staking-compound.html | stakeTokens | `olighft-staking` | `stake` |
| staking-compound.html | runCalculator | `olighft-staking` | `pending_rewards` |
