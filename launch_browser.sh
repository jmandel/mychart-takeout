#!/usr/bin/env bash
# Launch Chromium with CDP enabled on :9222, then sign in to MyChart in the
# window that opens and run:  bun apps/cli/src/main.ts export
#
# Choose which Chrome/Chromium profile to open with $MYCHART_PROFILE
# (chrome://version shows profile paths). Defaults to the default profile.
set -euo pipefail
PROFILE="${MYCHART_PROFILE:-Default}"
PORT="${CDP_PORT:-9222}"
exec chromium --remote-debugging-port="$PORT" --profile-directory="$PROFILE" "$@"
