#!/usr/bin/env bash
# Post-deploy smoke test for lyriclens.yoru-and-akari.dev.
#
# The scary checks are the ones that would have caught the 2026-07-03
# cache-poison incident:
#
#   * /download cache-control MUST include "no-store". An unversioned
#     URL served with `immutable, max-age=31536000` poisons any HTTP
#     disk cache along the path — NCM's embedded Chromium honored the
#     old header for a year and kept replaying 0.4.1 past the 1.0.0
#     release without a single network request.
#
#   * /download body sha256 MUST equal /latest.json asset_digest. This
#     is the release-atomicity check: the previous design cached
#     /latest.json and /download's fetchLatestPayload independently,
#     so /latest.json advertised the new release while /download still
#     handed out the previous asset for ~10 minutes after we shipped.
#
# Usage: bash smoke.sh [BASE_URL]
#   BASE_URL defaults to https://lyriclens.yoru-and-akari.dev
set -euo pipefail

BASE="${1:-https://lyriclens.yoru-and-akari.dev}"
FAIL=0

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s\n" "$1"; FAIL=$((FAIL + 1)); }
note() { printf "  \033[33m·\033[0m %s\n" "$1"; }

echo "smoke test against $BASE"

# 1. /healthz
if curl --silent --show-error --fail "$BASE/healthz" >/dev/null; then
  pass "/healthz returns 200"
else
  fail "/healthz did not return 200"
fi

# 2. /latest.json → parse version + digest
LATEST_JSON=$(curl --silent --show-error --fail "$BASE/latest.json") \
  || { fail "/latest.json failed"; exit 1; }
VERSION=$(printf '%s' "$LATEST_JSON" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("version",""))')
DIGEST=$(printf '%s' "$LATEST_JSON" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()).get("asset_digest",""); print(d.replace("sha256:","") if d else "")')
if [[ -n "$VERSION" ]]; then
  pass "/latest.json version=$VERSION"
else
  fail "/latest.json missing version"
fi
if [[ -n "$DIGEST" ]]; then
  pass "/latest.json asset_digest present"
else
  note "/latest.json missing asset_digest (older release format — atomicity check skipped)"
fi

# 3. /download cache-control response header
# Use -D- to dump headers without following redirects; we want the
# Worker's response header, not GitHub's (which would appear if the
# Worker fell back to 302 downloadRedirect).
HEADERS=$(curl --silent --show-error -o /dev/null -D - "$BASE/download" || true)
STATUS_LINE=$(printf '%s' "$HEADERS" | head -n 1 | tr -d '\r')
CACHE_CTRL=$(printf '%s' "$HEADERS" | tr -d '\r' | awk -F': ' 'tolower($1)=="cache-control"{print tolower($2); exit}')
if [[ "$STATUS_LINE" == *"200"* ]]; then
  if [[ "$CACHE_CTRL" == *"no-store"* ]]; then
    pass "/download cache-control contains no-store ($CACHE_CTRL)"
  else
    fail "/download cache-control does NOT contain no-store (got: $CACHE_CTRL)"
  fi
elif [[ "$STATUS_LINE" == *"302"* ]]; then
  note "/download fell back to 302 downloadRedirect ($STATUS_LINE) — R2 proxy path skipped, no-store header check skipped. Investigate if not a temporary R2 hiccup."
else
  fail "/download unexpected first-hop status: $STATUS_LINE"
fi

# 4. /download body sha256 must match /latest.json asset_digest.
# This is the atomicity check: a stale /download would fail here.
if [[ -n "$DIGEST" ]]; then
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT
  curl --silent --show-error --location --fail "$BASE/download" -o "$TMP" \
    || { fail "/download failed to fetch full body"; exit 1; }
  ACTUAL_DIGEST=$(sha256sum "$TMP" | awk '{print $1}')
  if [[ "$ACTUAL_DIGEST" == "$DIGEST" ]]; then
    pass "/download sha256 matches /latest.json asset_digest ($ACTUAL_DIGEST)"
  else
    fail "/download sha256 mismatch — atomicity broken (expected $DIGEST, got $ACTUAL_DIGEST)"
  fi
fi

# 5. Landing + changelog
if curl --silent --show-error --fail "$BASE/" >/dev/null; then
  pass "/ returns 200"
else
  fail "/ did not return 200"
fi
if curl --silent --show-error --fail "$BASE/changelog" >/dev/null; then
  pass "/changelog returns 200"
else
  fail "/changelog did not return 200"
fi

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "FAIL — $FAIL check(s) failed"
  exit 1
fi
echo "all checks passed"
