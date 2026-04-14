# OLIGHFT Deploy Script - Push to GitHub + Deploy to Cloudflare Pages
param(
    [string]$Message = "update"
)

$ErrorActionPreference = "Stop"
$root = "c:\Users\OMENDA\OneDrive\crypto .html\Extra coins.html"
Set-Location $root

Write-Host "`n=== OLIGHFT Auto Deploy ===" -ForegroundColor Cyan

# Stage all changes
git add -A
$status = git status --short
if (-not $status) {
    Write-Host "No changes to deploy." -ForegroundColor Yellow
    exit 0
}

Write-Host "`nChanged files:" -ForegroundColor Green
Write-Host $status

# Commit
git commit -m $Message
Write-Host "`nCommitted." -ForegroundColor Green

# Push to GitHub
Write-Host "`nPushing to GitHub..." -ForegroundColor Cyan
git push origin main
Write-Host "Pushed." -ForegroundColor Green

# Deploy to Cloudflare Pages
Write-Host "`nDeploying to Cloudflare Pages..." -ForegroundColor Cyan
npx wrangler pages deploy . --project-name=olighftcoin --commit-dirty=true
Write-Host "`n=== Deploy complete! ===" -ForegroundColor Green

# Purge CDN cache
Write-Host "`nPurging Cloudflare CDN cache..." -ForegroundColor Cyan
node _purge-cache.js 2>$null
Write-Host "Cache purged." -ForegroundColor Green

Write-Host "`nAll done! Site will be live at https://olighftcoin.com in ~30s" -ForegroundColor Cyan
