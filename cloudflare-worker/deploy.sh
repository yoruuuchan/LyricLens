#!/usr/bin/env bash
# Deploy worker.js to Cloudflare via API directly (no wrangler needed).
# Reads CLOUDFLARE_API_TOKEN from ~/.config/codex/private.env when present.
#
# Usage: bash deploy.sh
set -eu
set -o pipefail 2>/dev/null || true

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-5e96dfd2bf22d385e4ffdaa794d74676}"
SCRIPT_NAME="${WORKER_NAME:-lyriclens-api}"
COMPAT_DATE="${COMPAT_DATE:-2026-06-01}"

# Resolve script path relative to this file so caller can run from anywhere.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_FILE="${HERE}/worker.js"

# Pick up the token from the standard private env file if not already exported.
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  if [[ -f "$HOME/.config/codex/private.env" ]]; then
    # shellcheck disable=SC1091
    source "$HOME/.config/codex/private.env"
  fi
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "missing CLOUDFLARE_API_TOKEN — export it or put it in ~/.config/codex/private.env" >&2
  exit 1
fi
if [[ ! -f "$WORKER_FILE" ]]; then
  echo "worker.js not found at $WORKER_FILE" >&2
  exit 1
fi

BOUNDARY="----lyriclens-$(date +%s)$RANDOM"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# Build multipart body: metadata JSON + the script as a module.
{
  printf -- "--%s\r\n" "$BOUNDARY"
  printf -- 'Content-Disposition: form-data; name="metadata"\r\n'
  printf -- 'Content-Type: application/json\r\n\r\n'
  printf -- '{"main_module":"worker.js","compatibility_date":"%s"}\r\n' "$COMPAT_DATE"
  printf -- "--%s\r\n" "$BOUNDARY"
  printf -- 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n'
  printf -- 'Content-Type: application/javascript+module\r\n\r\n'
  cat "$WORKER_FILE"
  printf -- "\r\n--%s--\r\n" "$BOUNDARY"
} > "$TMP"

echo "uploading $(wc -c < "$WORKER_FILE") bytes of worker.js → $SCRIPT_NAME"

RESPONSE=$(curl --silent --show-error \
  -X PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: multipart/form-data; boundary=$BOUNDARY" \
  --data-binary "@$TMP" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/$SCRIPT_NAME")

if echo "$RESPONSE" | grep -qE '"success":[[:space:]]*true'; then
  ETAG=$(python3 -c 'import json,sys; data=json.load(sys.stdin); print((data.get("result") or {}).get("etag") or "")' <<<"$RESPONSE")
  echo "deploy ok · etag ${ETAG:-unknown}"
else
  echo "deploy failed:"
  echo "$RESPONSE"
  exit 1
fi
