#!/usr/bin/env bash
# Generate a nightly pg_dump timer for one stamped app, into that app's own (free) Vercel Blob store.
#   sudo bash infra/vm/backup/make-timer.sh <app_id>
# Reads the app's state for the admin secret NAME only; values are pulled at run time and never stored.
set -euo pipefail
APP="${1:?usage: make-timer.sh <app_id>}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PROJ=$(python3 -c "import json;print(json.load(open('$ROOT/state/application/$APP/infrastructure.json'))['vercel']['project'])")
REF=$(python3 -c "import json;d=json.load(open('$ROOT/state/application/$APP/datastores.json'));print(d['postgres'].get('admin_url_ref','DATABASE_URL_UNPOOLED'))")
cat > "/etc/systemd/system/factory-backup@$APP.service" <<UNIT
[Unit]
Description=Nightly pg_dump of $APP into its own Vercel Blob store
[Service]
Type=oneshot
WorkingDirectory=$ROOT/molds/mold_v1/codebase
ExecStart=/usr/bin/env APP_ID=$APP VERCEL_PROJECT=$PROJ ADMIN_REF=$REF RETAIN_DAYS=7 node $ROOT/infra/vm/backup/run.mjs
UNIT
cat > "/etc/systemd/system/factory-backup@$APP.timer" <<UNIT
[Unit]
Description=Daily backup of $APP
[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now "factory-backup@$APP.timer"
echo "enabled factory-backup@$APP.timer (daily, 7-day retention, blob prefix backups/$APP/)"
