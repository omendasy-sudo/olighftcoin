#!/usr/bin/env python3
"""
OLIGHFT SMART COIN — P2P Payment API Server
Handles all P2P payment transactions: Mobile Money, Bank Transfer, Card Payments
with receipt code verification and proof management.

ENDPOINTS:
  POST /api/p2p/deposit/mobile    — Deposit via M-Pesa, Airtel Money, etc.
  POST /api/p2p/withdraw/mobile   — Withdraw to mobile money
  POST /api/p2p/deposit/bank      — Deposit via bank transfer
  POST /api/p2p/withdraw/bank     — Withdraw to bank account
  POST /api/p2p/deposit/card      — Deposit via card payment
  POST /api/p2p/withdraw/card     — Withdraw to card
  POST /api/p2p/proof/submit      — Submit payment proof (screenshot + code)
  POST /api/p2p/proof/verify      — Verify receipt code match
  POST /api/p2p/proof/reject      — Admin reject a proof
  GET  /api/p2p/transaction/:id   — Get single transaction
  GET  /api/p2p/transactions      — Get user transaction history
  GET  /api/p2p/pending           — Get pending (unverified) transactions
  GET  /api/p2p/providers         — Get all provider lists
  GET  /api/p2p/prices            — Get current coin prices

SETUP:
  pip install flask flask-cors
  python p2p-api-server.py

  Server runs on http://localhost:5000 by default.
  Set OLIGHFT_P2P_PORT env var to change.
"""

import json
import os
import sys
import re
import time
import uuid
import hashlib
import secrets
import threading
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CONFIGURATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PORT = int(os.environ.get("OLIGHFT_P2P_PORT", 5000))
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "p2p_data")
TRANSACTIONS_FILE = os.path.join(DATA_DIR, "transactions.json")
BALANCES_FILE = os.path.join(DATA_DIR, "balances.json")
PROOFS_DIR = os.path.join(DATA_DIR, "proofs")
ALLOWED_ORIGINS = [
    "https://olighftcoin.com",
    "http://109.199.109.143:8080",
    "http://localhost:8080",
    "http://localhost:8765",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "null"  # for file:// protocol
]

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  COIN PRICES & FEES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COIN_PRICES = {
    "OLIGHFT": 0.50,
    "USDC": 1.00,
    "XLM": 0.12
}

FEES = {
    "mobile_deposit":  0.015,   # 1.5%
    "mobile_withdraw": 0.02,    # 2%
    "bank_deposit":    0.01,    # 1%
    "bank_withdraw":   0.015,   # 1.5%
    "card_deposit":    0.025,   # 2.5%
    "card_withdraw":   0.03     # 3%
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PROVIDERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MOBILE_PROVIDERS = [
    "mpesa", "airtel", "tkash", "equitel", "alopesa", "yass",
    "halopesa", "tigo", "vodacom", "mtn", "orange", "wave",
    "moov", "glo", "9mobile", "ecocash", "telecash", "onemoney",
    "zamtel", "tnm", "vodafone", "gcash", "dana", "chipper"
]

BANK_PROVIDERS = [
    "kcb", "equity", "coop", "absa_ke", "stanbic_ke", "dtb",
    "ncba", "im_bank", "family", "gtbank", "access", "zenith",
    "firstbank", "uba", "fnb", "standard", "nedbank", "capitec",
    "absa_za", "crdb", "nmb", "stanbic_ug", "gcb", "ecobank",
    "wire", "sepa", "ach", "swift"
]

CARD_PROVIDERS = [
    "visa", "mastercard", "amex", "discover", "unionpay",
    "verve", "maestro", "dinersclub", "jcb", "elo"
]

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  LIMITS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIMITS = {
    "mobile_deposit":  {"min_usd": 1,  "max_usd": 10000},
    "bank_deposit":    {"min_usd": 5,  "max_usd": 50000},
    "card_deposit":    {"min_usd": 5,  "max_usd": 25000},
    "mobile_withdraw": {"min_coins": 1, "max_coins": 100000},
    "bank_withdraw":   {"min_coins": 1, "max_coins": 100000},
    "card_withdraw":   {"min_coins": 1, "max_coins": 100000},
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  DATA PERSISTENCE (Thread-safe JSON file storage)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
_data_lock = threading.Lock()

def _ensure_dirs():
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(PROOFS_DIR, exist_ok=True)

def _load_transactions():
    if not os.path.exists(TRANSACTIONS_FILE):
        return []
    with open(TRANSACTIONS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def _save_transactions(txns):
    _ensure_dirs()
    tmp = TRANSACTIONS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(txns, f, indent=2, ensure_ascii=False)
    os.replace(tmp, TRANSACTIONS_FILE)

def _load_balances():
    if not os.path.exists(BALANCES_FILE):
        return {}
    with open(BALANCES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def _save_balances(bals):
    _ensure_dirs()
    tmp = BALANCES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(bals, f, indent=2, ensure_ascii=False)
    os.replace(tmp, BALANCES_FILE)

def _get_user_balances(user_id):
    all_bals = _load_balances()
    return all_bals.get(user_id, {"OLIGHFT": 0, "USDC": 0, "XLM": 0})

def _set_user_balances(user_id, bals):
    all_bals = _load_balances()
    all_bals[user_id] = bals
    _save_balances(all_bals)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  RECEIPT CODE GENERATION
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _generate_receipt_code():
    """Generate a unique receipt code like OLI-A3X9-K7M2P4"""
    part1 = secrets.token_hex(2).upper()
    part2 = secrets.token_hex(3).upper()
    return f"OLI-{part1}-{part2}"

def _generate_tx_id(prefix):
    ts = int(time.time() * 1000)
    rand = secrets.token_hex(3)
    return f"{prefix}_{ts}_{rand}"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  VALIDATION HELPERS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
def _validate_coin(coin):
    if not coin or coin not in COIN_PRICES:
        raise ValueError(f"Invalid coin. Supported: {', '.join(COIN_PRICES.keys())}")
    return coin

def _validate_phone(phone):
    if not phone or not phone.strip():
        raise ValueError("Phone number is required")
    digits = re.sub(r'\D', '', phone.strip())
    if len(digits) < 7:
        raise ValueError("Invalid phone number — must have at least 7 digits")
    return phone.strip()

def _validate_provider(provider, provider_list, label):
    if not provider or provider not in provider_list:
        raise ValueError(f"Invalid {label} provider")
    return provider

def _validate_account_number(acct_num):
    if not acct_num or len(acct_num.strip()) < 5:
        raise ValueError("Invalid account number — minimum 5 characters")
    return acct_num.strip()

def _validate_account_name(acct_name):
    if not acct_name or len(acct_name.strip()) < 2:
        raise ValueError("Invalid account holder name — minimum 2 characters")
    return acct_name.strip()

def _validate_card_last4(last4):
    if not last4 or len(last4.strip()) < 4:
        raise ValueError("Invalid card last 4 digits")
    if not re.match(r'^\d{4}$', last4.strip()):
        raise ValueError("Invalid card last 4 — must be exactly 4 digits")
    return last4.strip()

def _validate_cardholder(name):
    if not name or len(name.strip()) < 2:
        raise ValueError("Invalid cardholder name — minimum 2 characters")
    return name.strip()

def _validate_user_id(body):
    uid = body.get("userId", "").strip()
    if not uid:
        raise ValueError("userId is required — user must be logged in")
    return uid

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CORE TRANSACTION LOGIC
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def process_deposit(body, tx_type, fee_key, prefix, limits_key, extra_fields):
    """
    Generic deposit processor for mobile / bank / card.
    Creates a pending transaction, does NOT credit wallet until proof verified.
    """
    with _data_lock:
        user_id = _validate_user_id(body)
        coin = _validate_coin(body.get("coin", ""))
        usd_amount = float(body.get("usdAmount", 0))

        lim = LIMITS[limits_key]
        if usd_amount < lim["min_usd"]:
            raise ValueError(f"Minimum deposit is ${lim['min_usd']}")
        if usd_amount > lim["max_usd"]:
            raise ValueError(f"Maximum deposit is ${lim['max_usd']:,}")

        fee_pct = FEES[fee_key]
        fee = round(usd_amount * fee_pct, 2)
        net_usd = round(usd_amount - fee, 2)
        coins_received = round(net_usd / COIN_PRICES[coin], 7)
        receipt_code = _generate_receipt_code()
        tx_id = _generate_tx_id(prefix)
        now = int(time.time() * 1000)

        record = {
            "id": tx_id,
            "type": tx_type,
            "userId": user_id,
            "coin": coin,
            "usdAmount": usd_amount,
            "fee": fee,
            "feePct": fee_pct,
            "coinsReceived": coins_received,
            "status": "pending_proof",
            "receiptCode": receipt_code,
            "proofScreenshot": None,
            "proofEnteredCode": "",
            "proofNote": "",
            "proofSubmittedAt": 0,
            "proofVerifiedAt": 0,
            "rejectReason": "",
            "timestamp": now,
            "completedAt": 0,
            **extra_fields
        }

        txns = _load_transactions()
        txns.insert(0, record)
        _save_transactions(txns)

        # Return record without internal receipt code (client gets it via email/SMS)
        client_record = {**record}
        # In production, receiptCode would be sent via SMS/email only.
        # For dev/testing, we include it in response.
        return client_record


def process_withdraw(body, tx_type, fee_key, prefix, limits_key, extra_fields):
    """
    Generic withdrawal processor for mobile / bank / card.
    Escrows coins immediately, credits fiat after proof verified.
    """
    with _data_lock:
        user_id = _validate_user_id(body)
        coin = _validate_coin(body.get("coin", ""))
        coin_amount = float(body.get("coinAmount", 0))

        lim = LIMITS[limits_key]
        if coin_amount < lim["min_coins"]:
            raise ValueError(f"Minimum withdrawal is {lim['min_coins']} coins")
        if coin_amount > lim["max_coins"]:
            raise ValueError(f"Maximum withdrawal is {lim['max_coins']:,} coins")

        # Check balance
        bals = _get_user_balances(user_id)
        available = bals.get(coin, 0)
        if coin_amount > available:
            raise ValueError(f"Insufficient {coin} balance. Available: {available:.4f}, Requested: {coin_amount:.4f}")

        usd_value = round(coin_amount * COIN_PRICES[coin], 2)
        fee_pct = FEES[fee_key]
        fee = round(usd_value * fee_pct, 2)
        net_usd = round(usd_value - fee, 2)
        receipt_code = _generate_receipt_code()
        tx_id = _generate_tx_id(prefix)
        now = int(time.time() * 1000)

        # Escrow: debit coins immediately
        bals[coin] = round(bals[coin] - coin_amount, 7)
        _set_user_balances(user_id, bals)

        record = {
            "id": tx_id,
            "type": tx_type,
            "userId": user_id,
            "coin": coin,
            "coinAmount": coin_amount,
            "usdValue": usd_value,
            "fee": fee,
            "feePct": fee_pct,
            "netUsd": net_usd,
            "status": "pending_proof",
            "receiptCode": receipt_code,
            "proofScreenshot": None,
            "proofEnteredCode": "",
            "proofNote": "",
            "proofSubmittedAt": 0,
            "proofVerifiedAt": 0,
            "rejectReason": "",
            "timestamp": now,
            "completedAt": 0,
            **extra_fields
        }

        txns = _load_transactions()
        txns.insert(0, record)
        _save_transactions(txns)

        return record


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  PROOF / VERIFICATION LOGIC
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def submit_proof(body):
    """Submit payment proof screenshot + receipt code."""
    with _data_lock:
        record_id = body.get("recordId", "").strip()
        screenshot = body.get("screenshot", "")
        entered_code = body.get("enteredCode", "").strip()
        note = body.get("note", "").strip()[:500]

        if not record_id:
            raise ValueError("recordId is required")
        if not screenshot:
            raise ValueError("Payment screenshot is required")
        if not entered_code or len(entered_code) < 3:
            raise ValueError("Receipt code is required (minimum 3 characters)")

        txns = _load_transactions()
        record = None
        idx = -1
        for i, t in enumerate(txns):
            if t["id"] == record_id:
                record = t
                idx = i
                break

        if not record:
            raise ValueError("Transaction not found")
        if record["status"] not in ("pending_proof", "rejected"):
            raise ValueError(f"Cannot submit proof for transaction in '{record['status']}' status")

        # Save proof screenshot to file (don't store base64 in JSON)
        if screenshot.startswith("data:image/"):
            proof_filename = f"{record_id}_proof.txt"
            proof_path = os.path.join(PROOFS_DIR, proof_filename)
            _ensure_dirs()
            with open(proof_path, "w", encoding="utf-8") as f:
                f.write(screenshot)
            record["proofScreenshot"] = proof_filename
        else:
            record["proofScreenshot"] = "uploaded"

        record["proofEnteredCode"] = entered_code
        record["proofNote"] = note
        record["proofSubmittedAt"] = int(time.time() * 1000)
        record["status"] = "proof_submitted"
        record["rejectReason"] = ""

        txns[idx] = record
        _save_transactions(txns)
        return record


def verify_transaction(body):
    """Verify receipt code match. Credits wallet on deposit match, finalizes withdrawal."""
    with _data_lock:
        record_id = body.get("recordId", "").strip()
        if not record_id:
            raise ValueError("recordId is required")

        txns = _load_transactions()
        record = None
        idx = -1
        for i, t in enumerate(txns):
            if t["id"] == record_id:
                record = t
                idx = i
                break

        if not record:
            raise ValueError("Transaction not found")
        if record["status"] != "proof_submitted":
            raise ValueError(f"Cannot verify transaction in '{record['status']}' status. Must be 'proof_submitted'.")

        # Compare receipt codes (case-insensitive)
        system_code = (record.get("receiptCode") or "").strip().upper()
        entered_code = (record.get("proofEnteredCode") or "").strip().upper()

        if system_code == entered_code:
            # MATCH — Confirm transaction
            record["status"] = "confirmed"
            record["proofVerifiedAt"] = int(time.time() * 1000)
            record["completedAt"] = int(time.time() * 1000)

            user_id = record["userId"]
            bals = _get_user_balances(user_id)
            coin = record["coin"]

            # Credit wallet for deposits
            is_deposit = record["type"] in ("deposit", "bank_deposit", "card_deposit")
            if is_deposit:
                bals[coin] = round(bals.get(coin, 0) + record["coinsReceived"], 7)
                _set_user_balances(user_id, bals)

            # Withdrawals: coins already escrowed, nothing more to do
            txns[idx] = record
            _save_transactions(txns)
            return record
        else:
            # MISMATCH — Reject + refund withdrawals
            record["status"] = "rejected"
            record["rejectReason"] = f"Receipt code mismatch. Expected system code, got '{entered_code}'"

            is_withdraw = record["type"] in ("withdraw", "bank_withdraw", "card_withdraw")
            if is_withdraw:
                user_id = record["userId"]
                bals = _get_user_balances(user_id)
                coin = record["coin"]
                bals[coin] = round(bals.get(coin, 0) + record["coinAmount"], 7)
                _set_user_balances(user_id, bals)

            txns[idx] = record
            _save_transactions(txns)
            raise ValueError(f"Receipt code mismatch — transaction rejected. Entered: {entered_code}")


def reject_proof(body):
    """Admin/manual rejection with optional reason. Refunds withdrawals."""
    with _data_lock:
        record_id = body.get("recordId", "").strip()
        reason = body.get("reason", "").strip() or "Proof rejected by admin"

        if not record_id:
            raise ValueError("recordId is required")

        txns = _load_transactions()
        record = None
        idx = -1
        for i, t in enumerate(txns):
            if t["id"] == record_id:
                record = t
                idx = i
                break

        if not record:
            raise ValueError("Transaction not found")
        if record["status"] not in ("proof_submitted", "pending_proof"):
            raise ValueError(f"Cannot reject transaction in '{record['status']}' status")

        record["status"] = "rejected"
        record["rejectReason"] = reason

        # Refund escrow for withdrawals
        is_withdraw = record["type"] in ("withdraw", "bank_withdraw", "card_withdraw")
        if is_withdraw:
            user_id = record["userId"]
            bals = _get_user_balances(user_id)
            coin = record["coin"]
            bals[coin] = round(bals.get(coin, 0) + record["coinAmount"], 7)
            _set_user_balances(user_id, bals)

        txns[idx] = record
        _save_transactions(txns)
        return record


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  QUERY FUNCTIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def get_transaction(tx_id):
    txns = _load_transactions()
    for t in txns:
        if t["id"] == tx_id:
            return t
    return None

def get_user_transactions(user_id, tx_type=None, limit=100):
    txns = _load_transactions()
    result = [t for t in txns if t.get("userId") == user_id]
    if tx_type:
        result = [t for t in result if t["type"] == tx_type]
    return result[:limit]

def get_pending_transactions(user_id=None):
    txns = _load_transactions()
    pending = [t for t in txns if t["status"] in ("pending_proof", "proof_submitted")]
    if user_id:
        pending = [t for t in pending if t.get("userId") == user_id]
    return pending

def get_user_balance(user_id):
    return _get_user_balances(user_id)

def sync_balance(user_id, balances):
    """Sync client-side balances to server (initial registration)."""
    with _data_lock:
        existing = _get_user_balances(user_id)
        # Only sync if user has no server balance yet
        if all(v == 0 for v in existing.values()):
            clean = {}
            for coin in COIN_PRICES:
                clean[coin] = max(0, float(balances.get(coin, 0)))
            _set_user_balances(user_id, clean)
            return clean
        return existing


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  HTTP REQUEST HANDLER
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class P2PAPIHandler(SimpleHTTPRequestHandler):

    def _cors_origin(self):
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            return origin
        return ALLOWED_ORIGINS[0]

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "3600")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def _json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def _error(self, status, msg):
        self._json_response(status, {"success": False, "error": msg})

    # ── ROUTING ───────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        qs = parse_qs(parsed.query)

        if path == "/api/p2p/providers":
            self._handle_providers()
        elif path == "/api/p2p/prices":
            self._handle_prices()
        elif path.startswith("/api/p2p/transaction/"):
            tx_id = path.split("/api/p2p/transaction/")[1]
            self._handle_get_transaction(tx_id)
        elif path == "/api/p2p/transactions":
            self._handle_get_transactions(qs)
        elif path == "/api/p2p/pending":
            self._handle_get_pending(qs)
        elif path == "/api/p2p/balance":
            self._handle_get_balance(qs)
        elif path == "/api/p2p/health":
            self._json_response(200, {"status": "ok", "server": "OLIGHFT P2P API", "version": "1.0.0", "timestamp": int(time.time() * 1000)})
        elif path.startswith("/api/"):
            self._error(404, "API endpoint not found")
        else:
            # Serve static files
            super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")

        try:
            body = self._read_body()
        except Exception:
            self._error(400, "Invalid JSON body")
            return

        routes = {
            "/api/p2p/deposit/mobile":   self._handle_deposit_mobile,
            "/api/p2p/withdraw/mobile":  self._handle_withdraw_mobile,
            "/api/p2p/deposit/bank":     self._handle_deposit_bank,
            "/api/p2p/withdraw/bank":    self._handle_withdraw_bank,
            "/api/p2p/deposit/card":     self._handle_deposit_card,
            "/api/p2p/withdraw/card":    self._handle_withdraw_card,
            "/api/p2p/proof/submit":     self._handle_submit_proof,
            "/api/p2p/proof/verify":     self._handle_verify_proof,
            "/api/p2p/proof/reject":     self._handle_reject_proof,
            "/api/p2p/balance/sync":     self._handle_sync_balance,
        }

        handler = routes.get(path)
        if handler:
            handler(body)
        else:
            self._error(404, "API endpoint not found")

    # ── DEPOSIT HANDLERS ──────────────────────────────

    def _handle_deposit_mobile(self, body):
        try:
            provider = _validate_provider(body.get("provider", ""), MOBILE_PROVIDERS, "mobile")
            phone = _validate_phone(body.get("phone", ""))

            record = process_deposit(
                body, tx_type="deposit", fee_key="mobile_deposit",
                prefix="dep", limits_key="mobile_deposit",
                extra_fields={"provider": provider, "phone": phone}
            )
            print(f"  [DEPOSIT/MOBILE] {record['coin']} ${record['usdAmount']} via {provider} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] deposit/mobile: {e}")
            self._error(500, "Internal server error")

    def _handle_deposit_bank(self, body):
        try:
            bank_id = _validate_provider(body.get("bankId", ""), BANK_PROVIDERS, "bank")
            acct_num = _validate_account_number(body.get("accountNumber", ""))
            acct_name = _validate_account_name(body.get("accountName", ""))

            record = process_deposit(
                body, tx_type="bank_deposit", fee_key="bank_deposit",
                prefix="bdep", limits_key="bank_deposit",
                extra_fields={"bankId": bank_id, "accountNumber": acct_num, "accountName": acct_name}
            )
            print(f"  [DEPOSIT/BANK] {record['coin']} ${record['usdAmount']} via {bank_id} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] deposit/bank: {e}")
            self._error(500, "Internal server error")

    def _handle_deposit_card(self, body):
        try:
            card_type = _validate_provider(body.get("cardType", ""), CARD_PROVIDERS, "card")
            last4 = _validate_card_last4(body.get("cardLast4", ""))
            holder = _validate_cardholder(body.get("cardHolder", ""))

            record = process_deposit(
                body, tx_type="card_deposit", fee_key="card_deposit",
                prefix="cdep", limits_key="card_deposit",
                extra_fields={"cardType": card_type, "cardLast4": last4, "cardHolder": holder}
            )
            print(f"  [DEPOSIT/CARD] {record['coin']} ${record['usdAmount']} via {card_type} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] deposit/card: {e}")
            self._error(500, "Internal server error")

    # ── WITHDRAW HANDLERS ─────────────────────────────

    def _handle_withdraw_mobile(self, body):
        try:
            provider = _validate_provider(body.get("provider", ""), MOBILE_PROVIDERS, "mobile")
            phone = _validate_phone(body.get("phone", ""))

            record = process_withdraw(
                body, tx_type="withdraw", fee_key="mobile_withdraw",
                prefix="wd", limits_key="mobile_withdraw",
                extra_fields={"provider": provider, "phone": phone}
            )
            print(f"  [WITHDRAW/MOBILE] {record['coin']} {record['coinAmount']} via {provider} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] withdraw/mobile: {e}")
            self._error(500, "Internal server error")

    def _handle_withdraw_bank(self, body):
        try:
            bank_id = _validate_provider(body.get("bankId", ""), BANK_PROVIDERS, "bank")
            acct_num = _validate_account_number(body.get("accountNumber", ""))
            acct_name = _validate_account_name(body.get("accountName", ""))

            record = process_withdraw(
                body, tx_type="bank_withdraw", fee_key="bank_withdraw",
                prefix="bwd", limits_key="bank_withdraw",
                extra_fields={"bankId": bank_id, "accountNumber": acct_num, "accountName": acct_name}
            )
            print(f"  [WITHDRAW/BANK] {record['coin']} {record['coinAmount']} via {bank_id} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] withdraw/bank: {e}")
            self._error(500, "Internal server error")

    def _handle_withdraw_card(self, body):
        try:
            card_type = _validate_provider(body.get("cardType", ""), CARD_PROVIDERS, "card")
            last4 = _validate_card_last4(body.get("cardLast4", ""))
            holder = _validate_cardholder(body.get("cardHolder", ""))

            record = process_withdraw(
                body, tx_type="card_withdraw", fee_key="card_withdraw",
                prefix="cwd", limits_key="card_withdraw",
                extra_fields={"cardType": card_type, "cardLast4": last4, "cardHolder": holder}
            )
            print(f"  [WITHDRAW/CARD] {record['coin']} {record['coinAmount']} via {card_type} -> {record['id']}")
            self._json_response(200, {"success": True, "transaction": record})
        except (ValueError, KeyError) as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] withdraw/card: {e}")
            self._error(500, "Internal server error")

    # ── PROOF HANDLERS ────────────────────────────────

    def _handle_submit_proof(self, body):
        try:
            record = submit_proof(body)
            print(f"  [PROOF/SUBMIT] {record['id']} -> proof_submitted")
            self._json_response(200, {"success": True, "transaction": record})
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] proof/submit: {e}")
            self._error(500, "Internal server error")

    def _handle_verify_proof(self, body):
        try:
            record = verify_transaction(body)
            print(f"  [PROOF/VERIFY] {record['id']} -> confirmed")
            self._json_response(200, {"success": True, "transaction": record})
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] proof/verify: {e}")
            self._error(500, "Internal server error")

    def _handle_reject_proof(self, body):
        try:
            record = reject_proof(body)
            print(f"  [PROOF/REJECT] {record['id']} -> rejected")
            self._json_response(200, {"success": True, "transaction": record})
        except ValueError as e:
            self._error(400, str(e))
        except Exception as e:
            print(f"  [ERROR] proof/reject: {e}")
            self._error(500, "Internal server error")

    # ── QUERY HANDLERS ────────────────────────────────

    def _handle_providers(self):
        self._json_response(200, {
            "success": True,
            "mobile": MOBILE_PROVIDERS,
            "bank": BANK_PROVIDERS,
            "card": CARD_PROVIDERS
        })

    def _handle_prices(self):
        self._json_response(200, {
            "success": True,
            "prices": COIN_PRICES,
            "fees": FEES,
            "limits": LIMITS
        })

    def _handle_get_transaction(self, tx_id):
        tx = get_transaction(tx_id)
        if tx:
            self._json_response(200, {"success": True, "transaction": tx})
        else:
            self._error(404, "Transaction not found")

    def _handle_get_transactions(self, qs):
        user_id = qs.get("userId", [""])[0]
        tx_type = qs.get("type", [None])[0]
        limit = int(qs.get("limit", ["100"])[0])
        if not user_id:
            self._error(400, "userId query parameter is required")
            return
        txns = get_user_transactions(user_id, tx_type, min(limit, 500))
        self._json_response(200, {"success": True, "transactions": txns, "count": len(txns)})

    def _handle_get_pending(self, qs):
        user_id = qs.get("userId", [None])[0]
        pending = get_pending_transactions(user_id)
        self._json_response(200, {"success": True, "transactions": pending, "count": len(pending)})

    def _handle_get_balance(self, qs):
        user_id = qs.get("userId", [""])[0]
        if not user_id:
            self._error(400, "userId query parameter is required")
            return
        bals = get_user_balance(user_id)
        self._json_response(200, {"success": True, "balances": bals})

    def _handle_sync_balance(self, body):
        try:
            user_id = _validate_user_id(body)
            balances = body.get("balances", {})
            result = sync_balance(user_id, balances)
            self._json_response(200, {"success": True, "balances": result})
        except ValueError as e:
            self._error(400, str(e))

    def log_message(self, fmt, *args):
        if args and "/api/" in str(args[0]):
            return
        super().log_message(fmt, *args)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  MAIN
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    _ensure_dirs()
    print(f"""
╔══════════════════════════════════════════════════════╗
║  OLIGHFT SMART COIN — P2P Payment API Server        ║
╠══════════════════════════════════════════════════════╣
║  Port:          {PORT:<38}║
║  Data dir:      {DATA_DIR:<38}║
║  Proofs dir:    {PROOFS_DIR:<38}║
╠══════════════════════════════════════════════════════╣
║  ENDPOINTS:                                          ║
║  POST /api/p2p/deposit/mobile                        ║
║  POST /api/p2p/deposit/bank                          ║
║  POST /api/p2p/deposit/card                          ║
║  POST /api/p2p/withdraw/mobile                       ║
║  POST /api/p2p/withdraw/bank                         ║
║  POST /api/p2p/withdraw/card                         ║
║  POST /api/p2p/proof/submit                          ║
║  POST /api/p2p/proof/verify                          ║
║  POST /api/p2p/proof/reject                          ║
║  GET  /api/p2p/transaction/:id                       ║
║  GET  /api/p2p/transactions?userId=X&type=Y          ║
║  GET  /api/p2p/pending?userId=X                      ║
║  GET  /api/p2p/balance?userId=X                      ║
║  POST /api/p2p/balance/sync                          ║
║  GET  /api/p2p/providers                             ║
║  GET  /api/p2p/prices                                ║
║  GET  /api/p2p/health                                ║
╚══════════════════════════════════════════════════════╝
""")
    server = HTTPServer(("0.0.0.0", PORT), P2PAPIHandler)
    print(f"  Server running on http://localhost:{PORT}")
    print(f"  Health check: http://localhost:{PORT}/api/p2p/health")
    print(f"  Press Ctrl+C to stop.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()
