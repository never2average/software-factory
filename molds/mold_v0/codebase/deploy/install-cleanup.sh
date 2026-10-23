#!/bin/sh
# Install the daily cleanup job (deploy/cleanup.sh) on the host: /etc/cron.d/app-cleanup, 04:17 UTC, logging to
# /var/log/app-cleanup.log (rotated by logrotate if present). Idempotent.
#   sh deploy/install-cleanup.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cat > /etc/cron.d/app-cleanup <<EOF
# The app's disk cleanup policy (deploy/cleanup.sh). Installed by deploy/install-cleanup.sh.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * * root sh $HERE/cleanup.sh >> /var/log/app-cleanup.log 2>&1
EOF
chmod 644 /etc/cron.d/app-cleanup
if [ -d /etc/logrotate.d ]; then
  cat > /etc/logrotate.d/app-cleanup <<'EOF'
/var/log/app-cleanup.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}
EOF
fi
echo "installed /etc/cron.d/app-cleanup (daily 04:17 UTC, log /var/log/app-cleanup.log)"
