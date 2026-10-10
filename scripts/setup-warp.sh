#!/usr/bin/env bash
set -euo pipefail

# Only the browser uses this loopback proxy; the runner keeps its normal network.
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/katabump-warp.gpg
. /etc/os-release
printf 'deb [arch=amd64 signed-by=/usr/share/keyrings/katabump-warp.gpg] https://pkg.cloudflareclient.com/ %s main\n' "$VERSION_CODENAME" | sudo tee /etc/apt/sources.list.d/katabump-warp.list > /dev/null
sudo apt-get update -qq > /dev/null 2>&1
sudo apt-get install -y cloudflare-warp > /dev/null 2>&1
sudo warp-cli --accept-tos registration new > /dev/null 2>&1
sudo warp-cli --accept-tos mode proxy > /dev/null 2>&1
sudo warp-cli --accept-tos proxy port 40000 > /dev/null 2>&1
sudo warp-cli --accept-tos connect > /dev/null 2>&1
for attempt in 1 2 3 4 5 6; do
  if curl -fsS --max-time 10 --socks5-hostname 127.0.0.1:40000 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | grep -Eq '^warp=(on|plus)$'; then
    if [ -n "${GITHUB_OUTPUT:-}" ]; then
      printf 'proxy=socks5://127.0.0.1:40000\n' >> "$GITHUB_OUTPUT"
    fi
    printf 'WARP 代理已连接。\n'
    exit 0
  fi
  sleep 3
done
printf 'WARP 代理连接未就绪。\n' >&2
exit 1
