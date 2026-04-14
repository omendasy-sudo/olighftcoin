const fs = require('fs');
const path = require('path');
const configPath = path.join(process.env.APPDATA, 'xdg.config', '.wrangler', 'config', 'default.toml');
const config = fs.readFileSync(configPath, 'utf8');
const token = config.match(/oauth_token\s*=\s*"([^"]+)"/)[1];

async function main() {
  const zr = await fetch('https://api.cloudflare.com/client/v4/zones?name=olighftcoin.com', {
    headers: { Authorization: 'Bearer ' + token }
  });
  const zd = await zr.json();
  const zoneId = zd.result[0].id;
  console.log('Zone ID:', zoneId);

  const pr = await fetch('https://api.cloudflare.com/client/v4/zones/' + zoneId + '/purge_cache', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purge_everything: true })
  });
  const pd = await pr.json();
  console.log('Purge result:', pd.success ? 'SUCCESS' : 'FAILED', JSON.stringify(pd.errors));
}
main().catch(e => console.error(e));
