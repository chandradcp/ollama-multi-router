#!/usr/bin/env bash
#
# Stop and remove the Ollama Multi Router launchd user-agent.
#
# Usage:  bash scripts/uninstall-service.sh   (or: npm run service:uninstall)
#
set -euo pipefail

LABEL="com.dcp.ollama-multi-router"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null \
  || launchctl unload "$PLIST" 2>/dev/null \
  || true

rm -f "$PLIST"
echo "✅ Service '$LABEL' stopped and removed."
