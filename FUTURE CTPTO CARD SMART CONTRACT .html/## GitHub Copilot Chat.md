## GitHub Copilot Chat

- Extension: 0.42.3 (prod)
- VS Code: 1.114.0 (e7fb5e96c0730b9deb70b33781f98e2f35975036)
- OS: win32 10.0.26200 x64
- GitHub Account: omendasy-sudo

## Network

User Settings:
```json
  "http.systemCertificatesNode": true,
  "github.copilot.advanced.debug.useElectronFetcher": true,
  "github.copilot.advanced.debug.useNodeFetcher": false,
  "github.copilot.advanced.debug.useNodeFetchFetcher": true
```

Connecting to https://api.github.com:
- DNS ipv4 Lookup: 140.82.121.6 (1 ms)
- DNS ipv6 Lookup: Error (2 ms): getaddrinfo ENOTFOUND api.github.com
- Proxy URL: None (2 ms)
- Electron fetch (configured): timed out after 10 seconds
- Node.js https: timed out after 10 seconds
- Node.js fetch: timed out after 10 seconds

Connecting to https://api.githubcopilot.com/_ping:
- DNS ipv4 Lookup: 140.82.112.21 (69 ms)
- DNS ipv6 Lookup: Error (38 ms): getaddrinfo ENOTFOUND api.githubcopilot.com
- Proxy URL: None (16 ms)
- Electron fetch (configured): timed out after 10 seconds
- Node.js https: timed out after 10 seconds
- Node.js fetch: timed out after 10 seconds

Connecting to https://copilot-proxy.githubusercontent.com/_ping:
- DNS ipv4 Lookup: 4.225.11.192 (37 ms)
- DNS ipv6 Lookup: Error (360 ms): getaddrinfo ENOTFOUND copilot-proxy.githubusercontent.com
- Proxy URL: None (60 ms)
- Electron fetch (configured): HTTP 200 (940 ms)
- Node.js https: HTTP 200 (1009 ms)
- Node.js fetch: HTTP 200 (1032 ms)

Connecting to https://mobile.events.data.microsoft.com: HTTP 404 (402 ms)
Connecting to https://dc.services.visualstudio.com: HTTP 404 (1460 ms)
Connecting to https://copilot-telemetry.githubusercontent.com/_ping: timed out after 10 seconds
Connecting to https://copilot-telemetry.githubusercontent.com/_ping: timed out after 10 seconds
Connecting to https://default.exp-tas.com: HTTP 400 (1376 ms)

Number of system certificates: 87

## Documentation

In corporate networks: [Troubleshooting firewall settings for GitHub Copilot](https://docs.github.com/en/copilot/troubleshooting-github-copilot/troubleshooting-firewall-settings-for-github-copilot).
