# OLIGHFT SMART COIN — Copilot Agent Instructions

## Project Overview
OLIGHFT SMART COIN is a crypto staking and payment platform built on **Stellar Soroban (Testnet)**. It includes a PWA frontend (static HTML/CSS/JS) and Rust smart contracts compiled to WASM.

- **Domain**: olighftcoin.com
- **GitHub Repo**: omendasy-sudo/olighftcoin
- **Hosting**: Cloudflare Pages (auto-deploy from main branch)
- **Backend APIs**: Contabo VPS at 109.199.109.143

## Tech Stack

### Frontend
- Static HTML pages (no framework)
- Inline CSS with dark theme (`#0a0a1a` background, `#6c5ce7` accent)
- Vanilla JavaScript with Stellar SDK (`@stellar/stellar-sdk`)
- PWA with service worker (`sw.js`) and `manifest.json`
- Deployed to Cloudflare Pages

### Smart Contracts (Soroban / Rust)
- Located in `contracts/` workspace
- Token (SEP-41), Staking, Card Staking, Swap AMM, Payment, Escrow, P2P, Invite
- Build target: `wasm32-unknown-unknown`
- Stellar CLI v25.2.0 for deployment
- Cargo target directory: `D:\cargo-target`

### Backend Services (VPS)
- `email_server.py` — OTP email service (Python)
- `staking-backend.js` — Soroban RPC proxy (Node.js)
- `escrow-backend.js` — Escrow service
- `p2p-backend.js` / `p2p-api-server.py` — P2P trading

## Contract Addresses (Testnet)
- Token: `CA5NW2ZJISLPTRRPEFY7XIKSB5CZ5XF2PIARJL2F37H7EPRAXXD34W6J`
- Staking: `CA5QKLZKEY2X6WTYHCBV4LYYTVXQT7L2WAJGLBWXXZAYC5XFHN3MF6HU`
- Card Staking: `CANTB5ENAFHLN2CWRFA5JFTXNXIR2DZZF4RXY6644BOSWCHQOWPVDB3V`
- Admin: `GBLEKKQNHKVE7NIOOPY7CQ6SJ4BQCGHD3O5FCPB2B47X2ERKSJGSMWCP`

## Card Tiers
| Tier | Name | Min Stake | Lock Days | APY |
|------|------|-----------|-----------|-----|
| 0 | Visa | 100 | 30 | 24% |
| 1 | Gold | 500 | 60 | 36% |
| 2 | Platinum | 1000 | 90 | 48% |
| 3 | Black | 2500 | 180 | 60% |
| 4 | Amex | 5000 | 365 | 72% |
| 5 | Mastercard | 10000 | 730 | 84% |

## Coding Conventions
- Use UTF-8 (no BOM) for all HTML files
- Keep HTML pages self-contained (inline styles and scripts)
- Use Stellar Testnet endpoints:
  - Horizon: `https://horizon-testnet.stellar.org`
  - Soroban RPC: `https://soroban-testnet.stellar.org`
  - Friendbot: `https://friendbot.stellar.org`
- Token amounts use 7 decimals (1 OLIGHFT = 10,000,000 stroops)
- CSP headers are defined in `_headers` file for Cloudflare Pages
- Redirects are defined in `_redirects` file

## Key Pages
- `auth.html` — Registration / Login (OTP-based)
- `dashboard.html` — Main dashboard with balances and staking
- `wallet.html` — Wallet management
- `send.html` / `receive.html` — Token transfers
- `swap.html` — Token swaps (AMM)
- `card-*.html` — Card tier staking pages (Visa, Gold, Platinum, Black, Amex, Mastercard)
- `activity.html` — Transaction history
- `invite.html` — Referral system
- `p2p-*.html` — P2P trading pages

## Security
- Never expose secret keys in frontend code
- All transactions must be signed client-side
- OTP verification required for auth
- CSP headers enforced via `_headers`
