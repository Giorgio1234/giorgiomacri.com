#!/usr/bin/env bash
# Actualiza giorgiomacri.com desde GitHub. Lo corre el timer giorgiomacri-sync cada minuto.
#  - site/   -> /var/www/giorgiomacri.com  (al instante)
#  - server/ -> /opt/sudoku-torneo         (con backup de la base y reinicio cuando nadie está jugando)
set -euo pipefail

REPO=${REPO:-/opt/giorgiomacri-repo}
WEB=${WEB:-/var/www/giorgiomacri.com}
APP=${APP:-/opt/sudoku-torneo}
DB=${DB:-/var/lib/sudoku-torneo/torneo.db}
STATE=${STATE:-/var/lib/giorgiomacri-deploy}
WEB_OWNER=${WEB_OWNER:-www-data:www-data}
PENDING=$STATE/restart-pending
MAX_WAIT_MIN=${MAX_WAIT_MIN:-0}   # minutos que espera si hay tableros en juego; 0 = reinicia apenas llega el cambio (el reinicio tarda ~1 s y las partidas no se pierden)

mkdir -p "$STATE"
# Correr desde una copia: este mismo archivo se actualiza con git reset más abajo
if [ -z "${SYNC_FROM_COPY:-}" ]; then
  cp "$0" "$STATE/sync-running.sh"
  SYNC_FROM_COPY=1 exec bash "$STATE/sync-running.sh" "$@"
fi
cd "$REPO"

DEPLOYED=$STATE/deployed-commit   # última versión publicada con éxito

git fetch --quiet origin main
after=$(git rev-parse origin/main)
before=$(cat "$DEPLOYED" 2>/dev/null || true)
git cat-file -e "${before:-x}^{commit}" 2>/dev/null || before=""   # sin registro válido: se publica todo

if [ "$before" != "$after" ]; then
  git reset --quiet --hard "$after"
  if [ -n "$before" ]; then changed=$(git diff --name-only "$before" "$after"); else changed=$(git ls-files); fi
  echo "Actualizando ${before:-(primera vez)} -> $after"

  if echo "$changed" | grep -q '^site/'; then
    rsync -a --exclude '.well-known' site/ "$WEB/"
    chown -R "$WEB_OWNER" "$WEB"
    echo "Páginas publicadas."
  fi

  if echo "$changed" | grep -q '^server/'; then
    if [ -f "$DB" ]; then
      mkdir -p "$STATE/backups"
      stamp=$(date +%F-%H%M%S)
      if command -v sqlite3 >/dev/null; then sqlite3 "$DB" ".backup '$STATE/backups/torneo-$stamp.db'"; else cp "$DB" "$STATE/backups/torneo-$stamp.db"; fi
      ls -1t "$STATE"/backups/torneo-*.db | tail -n +31 | xargs -r rm -f   # guarda los últimos 30
      echo "Backup de la base: torneo-$stamp.db"
    fi
    rsync -a --exclude '*.db' --exclude '*.db-*' server/ "$APP/"
    date +%s > "$PENDING"
    echo "Servidor copiado; reinicio pendiente."
  fi

  if echo "$changed" | grep -q '^deploy/'; then
    echo "Cambió deploy/ (servicio o Nginx): esos archivos se aplican a mano, ver README."
  fi

  # Solo si todo lo anterior salió bien (set -e corta antes si algo falla y se reintenta en el próximo minuto)
  echo "$after" > "$DEPLOYED"
fi

# Emulador de Flash (Ruffle) servido desde el sitio, no desde un CDN: se baja una vez y se verifica el hash
RUFFLE_VER=0.7.1
RUFFLE_SHA512='6ZWxx/cfX3RoNyQ1AVimECSae4gKqMxdPimOD+chiIcOFiJS0ATGKcjkretxNT03lqNUpiSyJjF55AuvvZ+QeA=='
RUFFLE_DIR="$WEB/vendor/ruffle-$RUFFLE_VER"
if [ ! -f "$RUFFLE_DIR/ruffle.js" ]; then
  tmp=$(mktemp -d)
  if curl -fsSL --max-time 120 -o "$tmp/r.tgz" "https://registry.npmjs.org/@ruffle-rs/ruffle/-/ruffle-$RUFFLE_VER.tgz"; then
    got=$(node -e "process.stdout.write(require('crypto').createHash('sha512').update(require('fs').readFileSync(process.argv[1])).digest('base64'))" "$tmp/r.tgz")
    if [ "$got" = "$RUFFLE_SHA512" ]; then
      tar -xzf "$tmp/r.tgz" -C "$tmp" && mkdir -p "$RUFFLE_DIR" && cp -r "$tmp/package/." "$RUFFLE_DIR/" && chown -R "$WEB_OWNER" "$WEB/vendor"
      echo "Ruffle $RUFFLE_VER instalado en $RUFFLE_DIR."
    else
      echo "Ruffle: el hash no coincide, no se instala (esperado $RUFFLE_SHA512, llegó $got)."
    fi
  else
    echo "Ruffle: no se pudo descargar; reintento en la próxima pasada."
  fi
  rm -rf "$tmp"
fi

# Reinicio del torneo cuando no hay tableros corriendo (en pausa no cuentan)
if [ -f "$PENDING" ]; then
  since=$(cat "$PENDING"); now=$(date +%s)
  playing=0
  if [ -f "$DB" ]; then
    playing=$(node --no-warnings -e "
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      let n = 0;
      try { n = db.prepare(\"SELECT COUNT(*) AS n FROM attempts WHERE status = 'playing' AND paused_at IS NULL AND started_at > ?\").get(Date.now() - 31 * 60000).n; }
      catch (e) { n = db.prepare(\"SELECT COUNT(*) AS n FROM attempts WHERE status = 'playing' AND started_at > ?\").get(Date.now() - 31 * 60000).n; }
      console.log(n);
    " "$DB" 2>/dev/null || echo 0)
  fi
  if [ "$playing" = "0" ] || [ $(( (now - since) / 60 )) -ge $MAX_WAIT_MIN ]; then
    systemctl restart sudoku-torneo
    rm -f "$PENDING"
    echo "Torneo reiniciado con la versión nueva (jugando: $playing)."
  else
    echo "Hay $playing tablero(s) en juego; el reinicio espera."
  fi
fi
