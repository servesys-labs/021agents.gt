#!/usr/bin/env bash
# Lightweight auth canary for runtime proxy ingress.
# Emits GitHub Actions-style error annotations on failure.
#
# Required env:
#   E2E_RUNTIME_URL
#   E2E_SERVICE_TOKEN

set -euo pipefail

RT_URL="${E2E_RUNTIME_URL:-https://runtime.oneshots.co}"
RT_URL="${RT_URL%/}"
TOKEN="${E2E_SERVICE_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "::error::Missing E2E_SERVICE_TOKEN"
  exit 1
fi

body='{"input":{"input":"reply with ok"},"config":{"metadata":{"agent_name":"my-assistant","org_id":"default"}}}'

call() {
  local auth="$1"
  if [[ -n "$auth" ]]; then
    curl -sS -w '\n%{http_code}' -X POST "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
      -H "Authorization: Bearer ${auth}" \
      -H "Content-Type: application/json" \
      --data "$body"
  else
    curl -sS -w '\n%{http_code}' -X POST "${RT_URL}/api/v1/runtime-proxy/runnable/invoke" \
      -H "Content-Type: application/json" \
      --data "$body"
  fi
}

ok_out="$(call "$TOKEN")"
ok_body="${ok_out%$'\n'*}"
ok_code="${ok_out##*$'\n'}"
if [[ "$ok_code" != "200" && "$ok_code" != "202" ]]; then
  echo "::error::Auth canary failed (valid token rejected). HTTP=${ok_code} body=${ok_body:0:300}"
  exit 1
fi

bad_out="$(call "")"
bad_body="${bad_out%$'\n'*}"
bad_code="${bad_out##*$'\n'}"
if [[ "$bad_code" != "401" ]]; then
  echo "::error::Auth canary failed (missing token not rejected). HTTP=${bad_code} body=${bad_body:0:300}"
  exit 1
fi

echo "auth-canary: PASS valid_token=${ok_code} missing_token=${bad_code} runtime=${RT_URL}"
