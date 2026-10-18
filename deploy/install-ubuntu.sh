#!/usr/bin/env bash
# Fresh Ubuntu 24.04 x86_64 installation; rerun to resume an interrupted install.
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive
export LC_ALL=C.UTF-8
trap 'echo "Installation stopped at line $LINENO. Resolve the error before rerunning." >&2' ERR

if [[ $# -ne 1 || $EUID -ne 0 ]]; then
    echo 'Usage: sudo bash deploy/install-ubuntu.sh PUBLIC_IPV4' >&2
    exit 2
fi
PUBLIC_IP="$1"
python3 - "$PUBLIC_IP" <<'PY'
import ipaddress, sys
address = ipaddress.ip_address(sys.argv[1])
if address.version != 4 or not address.is_global:
    raise SystemExit('Supply the server public IPv4, without http:// or a port.')
PY
. /etc/os-release
if [[ "$ID" != ubuntu || "$VERSION_ID" != 24.04 || $(uname -m) != x86_64 ]]; then
    echo 'This installer targets Ubuntu 24.04 x86_64 only.' >&2
    exit 2
fi
SOURCE=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
APP=/opt/costume-verifier
MARKER="$APP/.installed-by-costume-deploy"
if [[ "$SOURCE" == "$APP" ]]; then
    echo 'Run from the extracted release in your home folder, not /opt/costume-verifier.' >&2
    exit 2
fi
python3 "$SOURCE/deploy/preflight.py" --assets-only
if [[ -e "$APP" && ! -f "$MARKER" ]]; then
    echo "$APP already exists and is not managed by this installer; stopping." >&2
    exit 2
fi
if [[ ! -f "$MARKER" && -e /etc/nginx/nginx.conf ]]; then
    echo 'Existing Nginx installation detected. This installer expects a fresh server.' >&2
    echo 'Review existing sites and integrate the templates manually to preserve them.' >&2
    exit 2
fi
echo '[1/6] Installing Ubuntu packages...'
# This marker records a started install, including failure during apt or pip.
install -d -m 755 "$APP"
touch "$MARKER"
apt-get update
apt-get install -y python3-venv python3-pip nginx curl rsync ca-certificates cron
if ! id costume >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$APP" --no-create-home --shell /usr/sbin/nologin costume
fi
if systemctl cat costume-verifier.service >/dev/null 2>&1; then
    systemctl stop costume-verifier
fi
if [[ -f "$APP/data/costume.db" && -f "$APP/data/accounts.db" && -f "$APP/data/review_history.db" ]]; then
    python3 "$SOURCE/deploy/backup.py" --data-dir "$APP/data" --output /var/backups/costume-verifier-before-install
fi
echo '[2/6] Copying runtime files (existing databases are preserved)...'
# Never overwrite server databases when resuming an interrupted installation.
rsync -a --exclude '.venv/' --exclude '__pycache__/' --exclude 'dist/' \
    --exclude 'data/*.db' --exclude 'data/*.db-*' "$SOURCE/" "$APP/"
if [[ ! -e "$APP/data/costume.db" ]]; then
    install -m 600 "$SOURCE/data/costume.db" "$APP/data/costume.db"
fi
chown -R root:root "$APP"
# Never grant temporary group/world access to existing account or history DBs.
find "$APP" -type d -exec chmod 755 {} +
find "$APP" -type f ! -path "$APP/data/*.db" ! -path "$APP/data/*.db-*" -exec chmod u=rwX,go=rX {} +
chown -R costume:costume "$APP/data"
chmod 750 "$APP/data"
find "$APP/data" -maxdepth 1 -type f -name '*.db*' -exec chmod 600 {} +
echo '[3/6] Installing CPU-only Python dependencies...'
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/python" -m pip install --upgrade pip
"$APP/.venv/bin/python" -m pip install --no-cache-dir torch==2.7.0 --index-url https://download.pytorch.org/whl/cpu
"$APP/.venv/bin/python" -m pip install --no-cache-dir -r "$APP/deploy/requirements.txt"
"$APP/.venv/bin/python" -m pip check
runuser -u costume -- env PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 "$APP/.venv/bin/python" "$APP/deploy/preflight.py" --model
echo '[4/6] Installing service and Nginx configuration...'
if [[ ! -e /etc/costume-verifier.env ]]; then
    printf 'COSTUME_PUBLIC_ORIGIN=http://%s\nCOSTUME_SECURE_COOKIES=0\n' "$PUBLIC_IP" > /etc/costume-verifier.env
    chmod 640 /etc/costume-verifier.env
fi
install -m 644 "$APP/deploy/costume-verifier.service" /etc/systemd/system/costume-verifier.service
install -d -m 755 /etc/nginx/snippets
install -m 644 "$APP/deploy/nginx-proxy.inc" /etc/nginx/snippets/costume-proxy.conf
sed "s/__PUBLIC_IP__/$PUBLIC_IP/g" "$APP/deploy/nginx-http.conf.template" > /etc/nginx/sites-available/costume-verifier
if [[ -L /etc/nginx/sites-enabled/default ]]; then
    unlink /etc/nginx/sites-enabled/default
elif [[ -e /etc/nginx/sites-enabled/default ]]; then
    echo 'The enabled default site is a regular file; inspect it manually before proceeding.' >&2
    exit 2
fi
ln -sfn /etc/nginx/sites-available/costume-verifier /etc/nginx/sites-enabled/costume-verifier
nginx -t
systemctl daemon-reload
systemctl enable costume-verifier
systemctl restart costume-verifier
echo '[5/6] Waiting for the model and database to become ready...'
ready=0
for attempt in $(seq 1 90); do
    if curl --noproxy '*' --fail --silent --max-time 5 http://127.0.0.1:5173/api/sources > /dev/null; then
        ready=1
        break
    fi
    sleep 2
done
if [[ "$ready" != 1 ]]; then
    journalctl -u costume-verifier -n 60 --no-pager
    exit 1
fi
systemctl enable nginx
systemctl restart nginx
curl --noproxy '*' --fail --silent --max-time 10 -H "Host: $PUBLIC_IP" http://127.0.0.1/api/sources > /dev/null
echo '[6/6] Installing daily database backups...'
install -d -m 700 /var/backups/costume-verifier
printf '%s\n' '17 3 * * * root /opt/costume-verifier/.venv/bin/python /opt/costume-verifier/deploy/backup.py >> /var/log/costume-backup.log 2>&1' > /etc/cron.d/costume-verifier-backup
chmod 644 /etc/cron.d/costume-verifier-backup
systemctl enable --now cron
"$APP/.venv/bin/python" "$APP/deploy/backup.py"
echo "READY: http://$PUBLIC_IP/library.html"
echo 'HTTP temporary test only: use disposable credentials and sample documents.'
echo 'Tencent firewall must permit TCP 80. Do not expose port 5173.'
echo 'No cloud firewall or UFW rules were changed by this script.'
systemctl --no-pager --full status costume-verifier | head -n 18 || true
