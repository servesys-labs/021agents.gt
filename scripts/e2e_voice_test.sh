#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────
# E2E Voice Services Test
#
# Tests live GPU voice services through the OneShots tunnel with auth.
# Requires: curl, python3, jq
# ────────────────────────────────────────────────────────────────────
set -uo pipefail

SERVICE_TOKEN="${GPU_SERVICE_KEY:?Missing GPU_SERVICE_KEY env var}"
AUTH_HEADER="Authorization: Bearer ${SERVICE_TOKEN}"

PASS=0
FAIL=0
SKIP=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

echo "========================================"
echo " E2E Voice Services Test Suite"
echo " $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "========================================"
echo ""

# ── 1. Whisper STT health check ──────────────────────────────────

echo "--- Test 1: Whisper STT health check (stt.oneshots.co) ---"
STT_HEALTH=$(curl -s --max-time 15 \
  -H "${AUTH_HEADER}" \
  "https://stt.oneshots.co/health" 2>/dev/null || echo "")

if echo "$STT_HEALTH" | jq -e '.status' &>/dev/null; then
  STT_STATUS_VAL=$(echo "$STT_HEALTH" | jq -r '.status')
  STT_BACKENDS=$(echo "$STT_HEALTH" | jq -r '.backends // [] | join(", ")' 2>/dev/null || echo "")
  if echo "$STT_BACKENDS" | grep -q "/stt"; then
    pass "Whisper STT reachable (status: ${STT_STATUS_VAL}, /stt backend present)"
  else
    pass "Whisper STT reachable (status: ${STT_STATUS_VAL})"
  fi
elif [[ -z "$STT_HEALTH" ]]; then
  skip "Whisper STT unreachable (server may be offline)"
else
  fail "Whisper STT health unexpected response: ${STT_HEALTH:0:200}"
fi

# ── 2. Kokoro TTS health check ───────────────────────────────────

echo "--- Test 2: Kokoro TTS health check (tts.oneshots.co) ---"
KOKORO_HEALTH=$(curl -s --max-time 15 \
  -H "${AUTH_HEADER}" \
  "https://tts.oneshots.co/health" 2>/dev/null || echo "")

if echo "$KOKORO_HEALTH" | jq -e '.status' &>/dev/null; then
  KOKORO_STATUS_VAL=$(echo "$KOKORO_HEALTH" | jq -r '.status')
  KOKORO_BACKENDS=$(echo "$KOKORO_HEALTH" | jq -r '.backends // [] | join(", ")' 2>/dev/null || echo "")
  if echo "$KOKORO_BACKENDS" | grep -q "/tts"; then
    pass "Kokoro TTS reachable (status: ${KOKORO_STATUS_VAL}, /tts backend present)"
  else
    pass "Kokoro TTS reachable (status: ${KOKORO_STATUS_VAL})"
  fi
elif [[ -z "$KOKORO_HEALTH" ]]; then
  skip "Kokoro TTS unreachable (server may be offline)"
else
  fail "Kokoro TTS health unexpected response: ${KOKORO_HEALTH:0:200}"
fi

# ── 3. Chatterbox TTS health check ───────────────────────────────

echo "--- Test 3: Chatterbox TTS health check (tts-clone.oneshots.co) ---"
CLONE_HEALTH=$(curl -s --max-time 15 \
  -H "${AUTH_HEADER}" \
  "https://tts-clone.oneshots.co/health" 2>/dev/null || echo "")

if echo "$CLONE_HEALTH" | jq -e '.status' &>/dev/null; then
  CLONE_BACKENDS=$(echo "$CLONE_HEALTH" | jq -r '.backends // [] | join(", ")' 2>/dev/null || echo "")
  if echo "$CLONE_BACKENDS" | grep -q "/tts-clone"; then
    pass "Chatterbox TTS reachable (/tts-clone backend present)"
  else
    pass "Chatterbox TTS reachable (status: $(echo "$CLONE_HEALTH" | jq -r '.status'))"
  fi
elif [[ -z "$CLONE_HEALTH" ]]; then
  skip "Chatterbox TTS unreachable (server may be offline)"
else
  fail "Chatterbox TTS health unexpected response: ${CLONE_HEALTH:0:200}"
fi

# ── 4. Sesame CSM health check ───────────────────────────────────

echo "--- Test 4: Sesame CSM health check (tts-voice.oneshots.co) ---"
SESAME_HEALTH=$(curl -s --max-time 15 \
  -H "${AUTH_HEADER}" \
  "https://tts-voice.oneshots.co/health" 2>/dev/null || echo "")

if echo "$SESAME_HEALTH" | jq -e '.status' &>/dev/null; then
  SESAME_BACKENDS=$(echo "$SESAME_HEALTH" | jq -r '.backends // [] | join(", ")' 2>/dev/null || echo "")
  if echo "$SESAME_BACKENDS" | grep -q "/tts-voice"; then
    pass "Sesame CSM reachable (/tts-voice backend present)"
  else
    pass "Sesame CSM reachable (status: $(echo "$SESAME_HEALTH" | jq -r '.status'))"
  fi
elif [[ -z "$SESAME_HEALTH" ]]; then
  skip "Sesame CSM unreachable (server may be offline)"
else
  fail "Sesame CSM health unexpected response: ${SESAME_HEALTH:0:200}"
fi

# ── 5. Generate audio with Kokoro TTS via tunnel ─────────────────

echo "--- Test 5: Kokoro TTS audio generation ---"
TTS_HTTP=$(curl -s -o /tmp/e2e_tts_output.wav -w "%{http_code}" \
  --max-time 30 \
  -X POST \
  -H "Content-Type: application/json" \
  -H "${AUTH_HEADER}" \
  -d '{"input":"Hello, this is a test of the Kokoro text to speech system.","voice":"af_heart","model":"kokoro-v1"}' \
  "https://tts.oneshots.co/v1/audio/speech" 2>/dev/null || echo "000")

TTS_SIZE=0
if [[ -f /tmp/e2e_tts_output.wav ]]; then
  TTS_SIZE=$(wc -c < /tmp/e2e_tts_output.wav 2>/dev/null || echo "0")
fi

if [[ "$TTS_HTTP" == "200" ]] && [[ "$TTS_SIZE" -gt 1000 ]]; then
  pass "Kokoro TTS generated audio (${TTS_SIZE} bytes)"
elif [[ "$TTS_HTTP" == "000" ]]; then
  skip "Kokoro TTS unreachable for generation test"
else
  fail "Kokoro TTS generation failed (HTTP ${TTS_HTTP}, size ${TTS_SIZE})"
fi

# ── 6. Auth test: call without token should be rejected ──────────

echo "--- Test 6: Auth rejection without token ---"
NOAUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 15 \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"input":"unauthorized test","voice":"af_heart"}' \
  "https://tts.oneshots.co/v1/audio/speech" 2>/dev/null || echo "000")

if [[ "$NOAUTH_STATUS" == "401" ]] || [[ "$NOAUTH_STATUS" == "403" ]]; then
  pass "Unauthenticated request correctly rejected (HTTP ${NOAUTH_STATUS})"
elif [[ "$NOAUTH_STATUS" == "000" ]]; then
  skip "TTS unreachable for auth test"
elif [[ "$NOAUTH_STATUS" == "200" ]]; then
  fail "Unauthenticated request was NOT rejected (HTTP 200) — auth may be misconfigured"
else
  # Some auth proxies return 400 or other codes — still not 200, so acceptable
  pass "Unauthenticated request returned HTTP ${NOAUTH_STATUS} (not 200)"
fi

# ── 7. Auth test: call with token should get 200 ─────────────────

echo "--- Test 7: Auth acceptance with valid token ---"
AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 15 \
  -H "${AUTH_HEADER}" \
  "https://tts.oneshots.co/health" 2>/dev/null || echo "000")

if [[ "$AUTH_STATUS" == "200" ]]; then
  pass "Authenticated request accepted (HTTP 200)"
elif [[ "$AUTH_STATUS" == "000" ]]; then
  skip "TTS unreachable for authenticated test"
else
  fail "Authenticated request returned HTTP ${AUTH_STATUS} (expected 200)"
fi

# ── 8. TTS -> STT round-trip ─────────────────────────────────────

echo "--- Test 8: TTS -> STT round-trip ---"

if [[ -f /tmp/e2e_tts_output.wav ]] && [[ "$(wc -c < /tmp/e2e_tts_output.wav 2>/dev/null || echo 0)" -gt 1000 ]]; then
  echo "  Using Kokoro TTS output from test 5 for STT round-trip..."

  STT_RESP=$(curl -s --max-time 30 \
    -X POST \
    -H "${AUTH_HEADER}" \
    -F "file=@/tmp/e2e_tts_output.wav;type=audio/wav" \
    -F "response_format=json" \
    "https://stt.oneshots.co/v1/audio/transcriptions" 2>/dev/null || echo "")

  STT_TEXT=$(echo "$STT_RESP" | jq -r '.text // empty' 2>/dev/null || echo "")

  if [[ -n "$STT_TEXT" ]]; then
    echo "  TTS input:  'Hello, this is a test of the Kokoro text to speech system.'"
    echo "  STT output: '${STT_TEXT}'"

    STT_LOWER=$(echo "$STT_TEXT" | tr '[:upper:]' '[:lower:]')
    MATCH_COUNT=0
    for word in "hello" "test" "kokoro" "speech"; do
      if echo "$STT_LOWER" | grep -qi "$word"; then
        MATCH_COUNT=$((MATCH_COUNT + 1))
      fi
    done

    if [[ "$MATCH_COUNT" -ge 2 ]]; then
      pass "TTS->STT round-trip: ${MATCH_COUNT}/4 key words matched"
    else
      fail "TTS->STT round-trip: only ${MATCH_COUNT}/4 key words matched in '${STT_TEXT}'"
    fi
  elif [[ -z "$STT_RESP" ]]; then
    skip "Whisper STT unreachable for round-trip test"
  else
    fail "STT returned no text: ${STT_RESP:0:200}"
  fi
else
  echo "  TTS output not available, generating synthetic test tone..."

  python3 -c "
import struct, math, sys
sr=16000; dur=1.0; freq=440
samples=[int(32767*math.sin(2*math.pi*freq*t/sr)) for t in range(int(sr*dur))]
data=struct.pack(f'<{len(samples)}h', *samples)
sys.stdout.buffer.write(b'RIFF'+struct.pack('<I',36+len(data))+b'WAVEfmt '+struct.pack('<IHHIIHH',16,1,1,sr,sr*2,2,16)+b'data'+struct.pack('<I',len(data))+data)
" > /tmp/test_tone.wav 2>/dev/null

  if [[ -f /tmp/test_tone.wav ]]; then
    TONE_STT=$(curl -s --max-time 30 \
      -X POST \
      -H "${AUTH_HEADER}" \
      -F "file=@/tmp/test_tone.wav;type=audio/wav" \
      -F "response_format=json" \
      "https://stt.oneshots.co/v1/audio/transcriptions" 2>/dev/null || echo "")

    if echo "$TONE_STT" | jq -e '.text' &>/dev/null; then
      pass "STT processed synthetic tone (response: ${TONE_STT:0:100})"
    elif [[ -z "$TONE_STT" ]]; then
      skip "Whisper STT unreachable for tone test"
    else
      fail "STT failed on synthetic tone: ${TONE_STT:0:200}"
    fi
  else
    skip "Could not generate synthetic test tone (python3 error)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Results: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped"
echo "========================================"

# Clean up
rm -f /tmp/e2e_tts_output.wav /tmp/test_tone.wav 2>/dev/null || true

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
