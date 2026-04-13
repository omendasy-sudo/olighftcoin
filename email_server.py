#!/usr/bin/env python3
"""
OLIGHFT SMART COIN — OTP Email Server
Serves static files + sends OTP emails via Gmail SMTP.

SETUP:
  1. Go to https://myaccount.google.com/apppasswords
     (You must have 2-Step Verification enabled on your Google account)
  2. Create an App Password for "Mail"
  3. Paste the 16-character password below in SENDER_APP_PASSWORD
  4. Run:  python email_server.py
  5. Open:  https://olighftcoin.com/auth.html  (or http://localhost:8080/auth.html locally)
"""

import json
import smtplib
import ssl
import os
import re
import sys
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from urllib.parse import unquote

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  CONFIGURATION — Fill in your Gmail App Password below
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SENDER_EMAIL        = "olighftcoin@gmail.com"
SENDER_APP_PASSWORD = os.environ.get("OLIGHFT_GMAIL_APP_PASSWORD", "")  # Set via env var or paste here
SENDER_NAME         = "OLIGHFT SMART COIN"
PORT                = int(os.environ.get("OLIGHFT_PORT", 8080))
DOMAIN              = "https://olighftcoin.com"
SERVER_IP           = "109.199.109.143"
ALLOWED_ORIGINS     = ["https://olighftcoin.com", "http://109.199.109.143:8080", "http://localhost:8080"]
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# ── Rate limiting (IP-based, in-memory) ──────────────────
_rate_limit = {}  # { ip: [timestamp, ...] }
RATE_LIMIT_MAX = 5       # max OTP requests
RATE_LIMIT_WINDOW = 300  # per 5 minutes (seconds)

EMAIL_REGEX = re.compile(r'^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$')

def _check_rate_limit(ip):
    """Return True if under limit, False if exceeded."""
    now = time.time()
    if ip not in _rate_limit:
        _rate_limit[ip] = []
    # Prune old entries
    _rate_limit[ip] = [t for t in _rate_limit[ip] if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_limit[ip]) >= RATE_LIMIT_MAX:
        return False
    _rate_limit[ip].append(now)
    return True


def build_html_email(to_name, otp_code, expire_minutes):
    """Build a styled HTML email with the OTP code."""
    return f"""\
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0f0f1a;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f1a;padding:40px 0;">
<tr><td align="center">
<table width="420" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#1a1a2e,#16213e);border-radius:16px;border:1px solid rgba(129,140,248,.25);overflow:hidden;">
  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#818cf8,#6366f1);padding:28px 32px;text-align:center;">
    <div style="font-size:28px;font-weight:700;color:#fff;letter-spacing:1px;">🔐 OLIGHFT</div>
    <div style="font-size:13px;color:rgba(255,255,255,.8);margin-top:4px;">SMART COIN Security</div>
  </td></tr>
  <!-- Body -->
  <tr><td style="padding:32px;">
    <p style="color:#e2e8f0;font-size:15px;margin:0 0 8px;">Hello <strong style="color:#818cf8;">{to_name or 'there'}</strong>,</p>
    <p style="color:#94a3b8;font-size:14px;margin:0 0 24px;line-height:1.5;">
      Use this code to verify your identity. It expires in <strong style="color:#e2e8f0;">{expire_minutes} minutes</strong>.
    </p>
    <!-- OTP Code -->
    <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:16px 0;">
      <div style="display:inline-block;background:rgba(129,140,248,.12);border:2px dashed #818cf8;border-radius:12px;padding:16px 40px;letter-spacing:12px;font-size:36px;font-weight:700;color:#818cf8;font-family:'Courier New',monospace;">
        {otp_code}
      </div>
    </td></tr>
    </table>
    <p style="color:#64748b;font-size:12px;margin:24px 0 0;line-height:1.5;">
      If you didn't request this code, ignore this email.<br>
      Do not share this code with anyone.
    </p>
  </td></tr>
  <!-- Footer -->
  <tr><td style="background:rgba(0,0,0,.2);padding:16px 32px;text-align:center;">
    <p style="color:#475569;font-size:11px;margin:0;">
      &copy; 2026 OLIGHFT SMART COIN &mdash; Secure &bull; Decentralized &bull; Fast
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""


def send_otp_email(to_email, to_name, otp_code, expire_minutes=5):
    """Send OTP email via Gmail SMTP. Returns (success, error_msg)."""
    if not SENDER_APP_PASSWORD:
        return False, "SENDER_APP_PASSWORD not set. See email_server.py header for setup instructions."

    msg = MIMEMultipart("alternative")
    msg["Subject"] = f"Your OLIGHFT Verification Code: {otp_code}"
    msg["From"]    = f"{SENDER_NAME} <{SENDER_EMAIL}>"
    msg["To"]      = to_email

    # Plain-text fallback
    plain = f"Your OLIGHFT verification code is: {otp_code}\nExpires in {expire_minutes} minutes.\nDo not share this code."
    msg.attach(MIMEText(plain, "plain"))

    # HTML version
    html = build_html_email(to_name, otp_code, expire_minutes)
    msg.attach(MIMEText(html, "html"))

    try:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context) as server:
            server.login(SENDER_EMAIL, SENDER_APP_PASSWORD)
            server.sendmail(SENDER_EMAIL, to_email, msg.as_string())
        return True, None
    except smtplib.SMTPAuthenticationError:
        return False, "Gmail authentication failed. Check your App Password."
    except Exception as e:
        return False, str(e)


class OTPRequestHandler(SimpleHTTPRequestHandler):
    """Serves static files + handles POST /api/send-otp."""

    def _cors_origin(self):
        """Return the allowed origin for CORS (check against whitelist)."""
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            return origin
        return ALLOWED_ORIGINS[0]  # default to production domain

    def do_OPTIONS(self):
        """Handle CORS preflight."""
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/send-otp":
            self._handle_send_otp()
        else:
            self.send_error(404, "Not Found")

    def _handle_send_otp(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            body = json.loads(raw)
        except Exception:
            self._json_response(400, {"success": False, "error": "Invalid JSON body."})
            return

        to_email       = body.get("email", "").strip()
        to_name        = body.get("name", "").strip()
        otp_code       = body.get("code", "").strip()
        expire_minutes = body.get("expire_minutes", 5)

        if not to_email or not otp_code:
            self._json_response(400, {"success": False, "error": "email and code are required."})
            return
        # Validate email format
        if not EMAIL_REGEX.match(to_email):
            self._json_response(400, {"success": False, "error": "Invalid email address format."})
            return

        # Validate OTP format (4-8 digit/alphanumeric)
        if not re.match(r'^[A-Za-z0-9]{4,8}$', otp_code):
            self._json_response(400, {"success": False, "error": "Invalid OTP code format."})
            return

        # Rate limiting
        client_ip = self.client_address[0]
        if not _check_rate_limit(client_ip):
            self._json_response(429, {"success": False, "error": "Too many OTP requests. Try again in a few minutes."})
            return
        print(f"  📧 Sending OTP to {to_email}...")
        success, error = send_otp_email(to_email, to_name, otp_code, expire_minutes)

        if success:
            print(f"  ✅ Email sent to {to_email}")
            self._json_response(200, {"success": True})
        else:
            print(f"  ❌ Failed: {error}")
            self._json_response(500, {"success": False, "error": error})

    def _json_response(self, status, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Cleaner logging
        if args and "/api/" in str(args[0]):
            return  # already printed in _handle_send_otp
        super().log_message(fmt, *args)


if __name__ == "__main__":
    if not SENDER_APP_PASSWORD:
        print("=" * 60)
        print("  ⚠  Gmail App Password not configured!")
        print()
        print("  1. Go to: https://myaccount.google.com/apppasswords")
        print("  2. Create an App Password (select 'Mail')")
        print("  3. Paste the 16-char password in email_server.py")
        print("     → SENDER_APP_PASSWORD = 'xxxx xxxx xxxx xxxx'")
        print()
        print("  Server starting anyway (will return errors on send)...")
        print("=" * 60)
    else:
        print(f"  ✅ Gmail configured: {SENDER_EMAIL}")

    print(f"\n  🚀 OLIGHFT Email Server running on http://localhost:{PORT}")
    print(f"  🌐 Production domain: {DOMAIN}")
    print(f"  📂 Serving files from: {os.getcwd()}")
    print(f"  📧 POST /api/send-otp  →  sends OTP email\n")

    server = HTTPServer(("0.0.0.0", PORT), OTPRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Server stopped.")
        server.server_close()
