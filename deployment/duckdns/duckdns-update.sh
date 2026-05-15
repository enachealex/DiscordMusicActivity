#!/usr/bin/env bash
set -euo pipefail

SUBDOMAIN="${1:-}"
TOKEN="${2:-}"

if [[ -z "$SUBDOMAIN" || -z "$TOKEN" ]]; then
  echo "Usage: $0 <duckdns-subdomain> <duckdns-token>"
  exit 1
fi

mkdir -p "$HOME/duckdns"

cat > "$HOME/duckdns/duck.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail

curl -fsS "https://www.duckdns.org/update?domains=${SUBDOMAIN}&token=${TOKEN}&ip=" \
  -o "$HOME/duckdns/duck.log"
EOF

chmod 700 "$HOME/duckdns/duck.sh"

# Remove existing duckdns cron lines for idempotency.
crontab -l 2>/dev/null | grep -v 'duckdns/duck.sh' | crontab - || true

# Add updater every 5 minutes.
(
  crontab -l 2>/dev/null
  echo "*/5 * * * * $HOME/duckdns/duck.sh >/dev/null 2>&1"
) | crontab -

"$HOME/duckdns/duck.sh"

echo "DuckDNS updater installed for ${SUBDOMAIN}."
echo "Cron schedule: every 5 minutes"
echo "Current response log: $HOME/duckdns/duck.log"
