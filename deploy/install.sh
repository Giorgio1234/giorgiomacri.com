#!/usr/bin/env bash
# Instalación única en el VPS: conecta /var/www/giorgiomacri.com con el repo de GitHub.
# Uso (como root):  bash install.sh
set -euo pipefail

REPO_SSH="git@github-giorgiomacri:Giorgio1234/giorgiomacri.com.git"
REPO_DIR=/opt/giorgiomacri-repo
KEY=/root/.ssh/giorgiomacri_deploy

[ "$(id -u)" = "0" ] || { echo "Corré este script como root."; exit 1; }

echo "== 1/5 Paquetes"
apt-get update -qq
apt-get install -y -qq git rsync sqlite3 >/dev/null

echo "== 2/5 Clave de solo lectura para GitHub"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "vps-giorgiomacri-deploy" -f "$KEY" >/dev/null
fi
if ! grep -q "Host github-giorgiomacri" /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<EOF

Host github-giorgiomacri
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 /root/.ssh/config
fi
ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
sort -u -o /root/.ssh/known_hosts /root/.ssh/known_hosts

echo
echo "Copiá esta línea completa:"
echo
cat "$KEY.pub"
echo
echo "y agregala en GitHub: repo giorgiomacri.com -> Settings -> Deploy keys -> Add deploy key"
echo "(título: VPS, NO marques 'Allow write access')."
read -r -p "Cuando la hayas agregado, apretá Enter... " _

# GitHub responde "successfully authenticated" pero sale con código 1 (no da shell): se mira el texto, no el código
github_ok() { local out; out=$(ssh -o BatchMode=yes -o ConnectTimeout=10 -T github-giorgiomacri 2>&1 || true); echo "$out" | grep -q "successfully authenticated"; }
until github_ok; do
  echo "Respuesta de GitHub:"; ssh -o BatchMode=yes -o ConnectTimeout=10 -T github-giorgiomacri 2>&1 | sed 's/^/  /' || true
  read -r -p "GitHub todavía no acepta la clave. Revisá que esté agregada y apretá Enter para reintentar... " _
done
echo "GitHub OK."

echo "== 3/5 Repo"
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" fetch --quiet origin main && git -C "$REPO_DIR" reset --quiet --hard origin/main
else
  git clone --quiet "$REPO_SSH" "$REPO_DIR"
fi

echo "== 4/5 Primera publicación"
rsync -a --exclude '.well-known' "$REPO_DIR/site/" /var/www/giorgiomacri.com/
chown -R www-data:www-data /var/www/giorgiomacri.com
mkdir -p /opt/sudoku-torneo
rsync -a --exclude '*.db' --exclude '*.db-*' "$REPO_DIR/server/" /opt/sudoku-torneo/
mkdir -p /var/lib/giorgiomacri-deploy && date +%s > /var/lib/giorgiomacri-deploy/restart-pending
git -C "$REPO_DIR" rev-parse HEAD > /var/lib/giorgiomacri-deploy/deployed-commit

echo "== 5/5 Actualización automática cada minuto"
cat > /etc/systemd/system/giorgiomacri-sync.service <<EOF
[Unit]
Description=Actualiza giorgiomacri.com desde GitHub
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $REPO_DIR/deploy/sync.sh
EOF
cat > /etc/systemd/system/giorgiomacri-sync.timer <<EOF
[Unit]
Description=Revisa GitHub cada minuto

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now giorgiomacri-sync.timer
systemctl start giorgiomacri-sync.service || true

echo
echo "Listo. Para ver qué hizo cada actualización:"
echo "  journalctl -u giorgiomacri-sync -n 30 --no-pager"
