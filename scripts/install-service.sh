#!/usr/bin/env bash
#
# Install Ollama Multi Router as a macOS launchd user-agent so it starts
# automatically at login and restarts if it crashes.
#
# Usage:  bash scripts/install-service.sh    (or: npm run service:install)
#
set -euo pipefail

LABEL="com.dcp.ollama-multi-router"

# Resolve project root = parent of this script's directory (location-independent).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_JS="$PROJECT_DIR/src/server.js"

# Resolve an absolute node path — launchd runs with a minimal PATH.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "❌ 'node' not found in PATH. Install Node.js (>=20) first." >&2
  exit 1
fi
NODE_REAL="$(realpath "$NODE_BIN" 2>/dev/null || echo "$NODE_BIN")"
NODE_DIR="$(dirname "$NODE_REAL")"

if [ ! -f "$SERVER_JS" ]; then
  echo "❌ Cannot find $SERVER_JS" >&2
  exit 1
fi

PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/logs"
DOMAIN="gui/$(id -u)"

mkdir -p "$PLIST_DIR" "$LOG_DIR"

# Warn about a port clash with a manually-started instance.
PORT="$(grep -E '^PORT=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-20128}"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  Port $PORT is already in use. Stop any manual 'node src/server.js' first,"
  echo "    otherwise the service will fail to bind and keep restarting."
fi

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_REAL</string>
        <string>$SERVER_JS</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$PROJECT_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/service.out.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/service.err.log</string>
</dict>
</plist>
PLISTEOF

echo "✅ Wrote $PLIST"
echo "   node:    $NODE_REAL"
echo "   server:  $SERVER_JS"
echo "   workdir: $PROJECT_DIR"

# (Re)load with modern launchctl; fall back to legacy load for older systems.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load -w "$PLIST"
fi
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true

echo "✅ Service '$LABEL' installed and started."
echo "   Status:  npm run service:status"
echo "   Logs:    npm run service:logs"
echo "   Remove:  npm run service:uninstall"
