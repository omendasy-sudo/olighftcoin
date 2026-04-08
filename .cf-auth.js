const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = '54d11594-84e4-41aa-b438-e81b8fa78ee7';
const REDIRECT = 'http://localhost:8976/oauth/callback';

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(32).toString('base64url');

const scopes = 'account:read user:read workers:write workers_kv:write workers_routes:write workers_scripts:write workers_tail:read d1:write pages:write zone:read zone:edit ssl_certs:write offline_access';

const authUrl = 'https://dash.cloudflare.com/oauth2/auth?' + new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  scope: scopes,
  state: state,
  code_challenge: challenge,
  code_challenge_method: 'S256'
}).toString();

console.log('Opening browser for Cloudflare auth with DNS permissions...');
execSync('start "" "' + authUrl + '"', { shell: true });

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith('/oauth/callback')) return;
  const url = new URL(req.url, 'http://localhost:8976');
  const code = url.searchParams.get('code');
  const retState = url.searchParams.get('state');

  if (retState !== state) {
    res.end('State mismatch!');
    server.close();
    return;
  }

  const tokenRes = await fetch('https://dash.cloudflare.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: REDIRECT,
      client_id: CLIENT_ID,
      code_verifier: verifier
    }).toString()
  });
  const tokens = await tokenRes.json();

  if (tokens.access_token) {
    const configDir = path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const toml = 'oauth_token = "' + tokens.access_token + '"\nrefresh_token = "' + (tokens.refresh_token || '') + '"\nexpiration_time = "' + new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString() + '"\n';
    fs.writeFileSync(path.join(configDir, 'default.toml'), toml);
    console.log('SUCCESS: Token saved with DNS permissions!');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authenticated! You can close this tab.</h1>');
  } else {
    console.log('Token exchange failed:', JSON.stringify(tokens));
    res.end('Failed: ' + JSON.stringify(tokens));
  }
  server.close();
  process.exit(0);
});

server.listen(8976, () => console.log('Waiting for auth callback on port 8976...'));
setTimeout(() => { console.log('Timeout'); process.exit(1); }, 120000);
