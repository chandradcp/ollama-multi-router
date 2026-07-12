#!/bin/bash
# Funnel auto-heal watchdog.
# Tailscale Funnel occasionally drops its public ingress even though `funnel
# status` still says "on" (DNS resolves but connections fail). This script
# probes the REAL public path (the same one Cursor's cloud uses) and, if it's
# down, re-registers the funnel — escalating to a full down/up reconnect if a
# cheap re-arm isn't enough. Run every 60s by launchd.

TS="${TAILSCALE_BIN:-/opt/homebrew/bin/tailscale}"
PROJECT_DIR="${PROJECT_DIR:-/Users/Jarvis/ollama-multi-router}"
LOG="$PROJECT_DIR/logs/funnel-watchdog.log"
mkdir -p "$PROJECT_DIR/logs"

# Port the router listens on (from .env, default 20128).
PORT=$(grep -E '^PORT=' "$PROJECT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 | tr -d ' \r')
PORT="${PORT:-20128}"

# Public funnel hostname. Prefer the value injected by the installer (detected
# while funnel was on, so always correct), then fall back to the node's stable
# DNSName, then funnel status. Using the injected/DNSName value means detection
# never goes blank mid-outage (funnel status hides the host when funnel is off).
HOST="${FUNNEL_HOST:-}"
[ -z "$HOST" ] && HOST=$("$TS" status --json 2>/dev/null | sed -n 's/.*"DNSName" *: *"\([^"]*\)\.".*/\1/p' | head -1)
[ -z "$HOST" ] && HOST=$("$TS" funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1 | sed 's|https://||')

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG"; }

# Probe the public funnel path by pinning the public ingress IP (bypasses local
# MagicDNS, which would otherwise resolve the name to the internal tailnet IP).
probe() {
  [ -z "$HOST" ] && { echo "000"; return; }
  local ip
  ip=$(dig +short +time=5 +tries=1 @1.1.1.1 "$HOST" A 2>/dev/null | grep -E '^[0-9]' | head -1)
  [ -z "$ip" ] && { echo "000"; return; }
  local code
  code=$(curl -s -m 12 --resolve "$HOST:443:$ip" -o /dev/null -w "%{http_code}" "https://$HOST/health" 2>/dev/null)
  echo "${code:-000}"
}

# Local router must be up first; if it's down, funnel can't help — skip.
local_code=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null)
if [ "$local_code" != "200" ]; then
  log "local router not ready (http=$local_code) — skipping this cycle"
  exit 0
fi

code=$(probe)
[ "$code" = "200" ] && exit 0   # healthy, nothing to do

log "funnel DOWN (public health=$code, host=$HOST) — re-arming"
"$TS" funnel --bg "$PORT" >/dev/null 2>&1
sleep 4
code=$(probe)
if [ "$code" = "200" ]; then
  log "recovered via re-arm"
  exit 0
fi

log "re-arm insufficient (health=$code) — reconnecting tailnet (down/up)"
"$TS" down >/dev/null 2>&1
"$TS" up --timeout=30s >/dev/null 2>&1
"$TS" funnel --bg "$PORT" >/dev/null 2>&1
sleep 6
code=$(probe)
if [ "$code" = "200" ]; then
  log "recovered via reconnect"
else
  log "STILL down after reconnect (health=$code) — will retry next cycle"
fi
