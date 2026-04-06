# App Partition Guide — One Domain Per App

You have **3 separate apps**. Each must live in its **own GitHub repo** and its **own Cloudflare Pages project** with its own custom domain.

---

## Current Inventory

| App | GitHub Repo | Domain | Status |
|-----|------------|--------|--------|
| OLIGHFT SMART COIN | `omendasy-sudo/olighftcoin` | `olighftcoin.com` | ✅ Ready |
| Visual Pi Card | `omendasy-sudo/visual-pi-card` | `pivisualcard.online` | ⚠️ Needs own Pages project |
| Omenda Pi Pays | `omendasy-sudo/omenda-pi-pays` | *(needs domain)* | ⚠️ Needs own Pages project |

---

## Step-by-Step: Create Separate Cloudflare Pages Projects

### APP 1 — OLIGHFT SMART COIN (`olighftcoin.com`)

**Already done.** Your `olighftcoin` repo is pushed. Just verify:

1. Go to **Cloudflare Dashboard → Pages**
2. Find (or create) a Pages project connected to `omendasy-sudo/olighftcoin`
3. **Build settings**: Framework = None, Build command = (empty), Output directory = `/`
4. Go to **Custom domains** → Add `olighftcoin.com`
5. Cloudflare will auto-create the DNS record

### APP 2 — Visual Pi Card (`pivisualcard.online`)

1. Go to **Cloudflare Dashboard → Pages → Create a project**
2. Click **Connect to Git** → Select `omendasy-sudo/visual-pi-card`
3. **Build settings**: Framework = None, Build command = (empty), Output directory = `/`
4. Click **Save and Deploy**
5. After deploy, go to **Custom domains** → Add `pivisualcard.online`
6. **DNS**: In Cloudflare DNS for `pivisualcard.online`, the CNAME will be auto-created pointing to `<project-name>.pages.dev`

> **IMPORTANT**: If `pivisualcard.online` was previously pointed to your VPS (109.199.109.143), **delete the old A record** and let Cloudflare Pages create the CNAME.

### APP 3 — Omenda Pi Pays

1. **Buy/register a domain** for this app (e.g., `omendapipays.com` or `omendapipays.shop`)
2. **Add the domain to Cloudflare** (change nameservers at your registrar)
3. Go to **Cloudflare Dashboard → Pages → Create a project**
4. Click **Connect to Git** → Select `omendasy-sudo/omenda-pi-pays`
5. **Build settings**: Framework = None, Build command = (empty), Output directory = `/`
6. Click **Save and Deploy**
7. Go to **Custom domains** → Add your domain
8. Cloudflare will auto-create the DNS CNAME

---

## DNS Cleanup — Remove Cross-Pointing

In **Cloudflare DNS** for `olighftcoin.com`:
- **Keep**: CNAME `@` → `<olighftcoin-pages>.pages.dev` (or the A record Cloudflare Pages sets)
- **Delete**: Any A records pointing to VPS `109.199.109.143` (unless you need the VPS for email_server.py)
- **Delete**: Any CNAME/A records for subdomains belonging to other apps

In **Cloudflare DNS** for `pivisualcard.online`:
- **Delete**: Any A record pointing to `109.199.109.143`
- **Keep only**: The CNAME that Cloudflare Pages creates

---

## VPS Cleanup (109.199.109.143)

If you were running all apps on your Contabo VPS via nginx:

1. SSH into the VPS: `ssh root@109.199.109.143`
2. Stop nginx sites for apps that moved to Cloudflare Pages:
   ```bash
   sudo rm /etc/nginx/sites-enabled/olighftcoin.conf
   sudo rm /etc/nginx/sites-enabled/pivisualcard.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. **Keep the VPS** only if you need it for:
   - `email_server.py` (OTP email backend)
   - `staking-backend.js` (Soroban RPC proxy)
   - Any server-side API that Cloudflare Pages can't run

---

## Verification Checklist

After setup, verify each app is isolated:

- [ ] `https://olighftcoin.com` → Shows OLIGHFT SMART COIN (not Pi Card)
- [ ] `https://pivisualcard.online` → Shows Visual Pi Card (not OLIGHFT)
- [ ] `https://<omenda-pi-pays-domain>` → Shows Omenda Pi Pays marketplace
- [ ] Each Cloudflare Pages project shows only 1 connected repo
- [ ] DNS for each domain has only 1 target (no conflicting A/CNAME records)

---

## Summary

```
olighftcoin.com
  └── Cloudflare Pages Project #1
       └── GitHub: omendasy-sudo/olighftcoin

pivisualcard.online
  └── Cloudflare Pages Project #2
       └── GitHub: omendasy-sudo/visual-pi-card

<omenda-pi-pays-domain>
  └── Cloudflare Pages Project #3
       └── GitHub: omendasy-sudo/omenda-pi-pays
```

Each project is **completely independent**. Pushing code to one repo deploys **only** that app.
