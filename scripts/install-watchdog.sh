#!/bin/bash
# Install the Funnel auto-heal watchdog as a launchd agent that runs every 60s.
set -e

LABEL="com.dcp.ollama-funnel-watchdog"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WATCHDOG="$SCRIPT_DIR/funnel-watchdog.sh"
LOG_DIR="$PROJECT_DIR/logs"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Auto-detect tailscale binary.
TS_BIN="$(command -v tailscale || echo /opt/homebrew/bin/tailscale)"

# Detect the funnel hostname now (funnel is expected to be on at install time),
# and bake it into the agent so the watchdog never loses it during an outage.
FUNNEL_HOST="$("$TS_BIN" funnel status 2>/dev/null | grep -oE 'https://[a-z0-9.-]+\.ts\.net' | head -1 | sed 's|https://||')"
[ -z "$FUNNEL_HOST" ] && FUNNEL_HOST="$("$TS_BIN" status --json 2>/dev/null | sed -n 's/.*"DNSName" *: *"\([^"]*\)\.".*/\1/p' | head -1)"
echo "ℹ️  Funnel host: ${FUNNEL_HOST:-<none detected>}"

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod +x "$WATCHDOG"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$WATCHDOG</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>TAILSCALE_BIN</key>
        <string>$TS_BIN</string>
        <key>PROJECT_DIR</key>
        <string>$PROJECT_DIR</string>
        <key>FUNNEL_HOST</key>
        <string>$FUNNEL_HOST</string>
    </dict>
    <key>StartInterval</key>
    <integer>60</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/watchdog.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/watchdog.err.log</string>
</dict>
</plist>
PLISTEOF

echo "✅ Wrote $PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

echo "✅ Watchdog installed & running (checks every 60s)."
echo "   Logs: $LOG_DIR/funnel-watchdog.log"
