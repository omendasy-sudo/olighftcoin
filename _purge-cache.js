const ZONE_ID = '1c55b153cdddc9fda4326021eafe4ace';
const fs = require('fs');
const path = require('path');

// Read token from .cf-purge-token file (not .env to avoid wrangler conflict)
let token;
const tokenFile = path.join(__dirname, '.cf-purge-token');
if (fs.existsSync(tokenFile)) {
  token = fs.readFileSync(tokenFile, 'utf8').trim();
}
if (!token) {
  // Fall back to wrangler OAuth
  const configPath = path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml');
  const config = fs.readFileSync(configPath, 'utf8');
  token = config.match(/oauth_token\s*=\s*"([^"]+)"/)[1];
}

async function main() {
  console.log('Zone ID:', ZONE_ID);

  // Try as Bearer token first
  let pr = await fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE_ID + '/purge_cache', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true })
  });
  let pd = await pr.json();

  // If Bearer fails, try as Global API Key with email
  if (!pd.success) {
    console.log('Bearer auth failed, trying Global API Key...');
    pr = await fetch('https://api.cloudflare.com/client/v4/zones/' + ZONE_ID + '/purge_cache', {
      method: 'POST',
      headers: {
        'X-Auth-Email': 'olighftcoin@gmail.com',
        'X-Auth-Key': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ purge_everything: true })
    });
    pd = await pr.json();
  }

  console.log('Purge result:', pd.success ? 'SUCCESS' : 'FAILED', JSON.stringify(pd.errors || []));
}
main().catch(e => console.error(e));
