#!/usr/bin/env sh
# Refresh the polling dashboard: new polls, elections held, rollover, rebuild.
#   ./update.sh
set -e
cd "$(dirname "$0")"
# Wikimedia asks API users to identify themselves; put your own contact here.
: "${POLLS_USER_AGENT:=EuropePollsDashboard/1.0 (personal research dashboard)}"
export POLLS_USER_AGENT
python3 -m polls update
echo
echo "Done. To look at it:  python3 -m http.server 8000 --directory site   then open http://localhost:8000"
