#!/bin/sh
# Install the daily cleanup job (deploy/cleanup.sh) on the host: /etc/cron.d/octillion-cleanup, 04:17 UTC, logging to
# /var/log/octillion-cleanup.log (rotated by logrotate if present). Idempotent.
#   sh deploy/install-cleanup.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cat > /etc/cron.d/octillion-cleanup <<EOF
# Octillion disk cleanup policy (deploy/cleanup.sh). Installed by deploy/install-cleanup.sh.
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * * root sh $HERE/cleanup.sh >> /var/log/octillion-cleanup.log 2>&1
EOF
chmod 644 /etc/cron.d/octillion-cleanup
if [ -d /etc/logrotate.d ]; then
  cat > /etc/logrotate.d/octillion-cleanup <<'EOF'
/var/log/octillion-cleanup.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
}
EOF
fi
echo "installed /etc/cron.d/octillion-cleanup (daily 04:17 UTC, log /var/log/octillion-cleanup.log)"
