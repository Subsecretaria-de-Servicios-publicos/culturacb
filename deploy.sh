#!/usr/bin/env bash
# Deploy culturacb → userdes@172.17.32.106
# Uso: ./deploy.sh [--setup-apache]   (--setup-apache solo la primera vez)

set -euo pipefail

SERVER="userdes@172.17.32.106"
REMOTE_DIR="/home/userdes/culturacb"
LOCAL_DIR="$(cd "$(dirname "$0")" && pwd)"

# ─── 1. Verificar JWT_SECRET ─────────────────────────────────────────────────
if grep -q "cambiar-esta-clave-larga-en-produccion" "$LOCAL_DIR/.env"; then
  echo "⚠  JWT_SECRET no está configurado. Generando uno seguro..."
  JWT_NEW=$(openssl rand -hex 48)
  # Reemplazar en .env
  sed -i "s|JWT_SECRET=cambiar-esta-clave-larga-en-produccion|JWT_SECRET=$JWT_NEW|g" "$LOCAL_DIR/.env"
  echo "✓  JWT_SECRET actualizado en .env"
fi

# ─── 2. Ajustar VITE_API_URL para producción ─────────────────────────────────
# El frontend debe llamar al proxy Apache, no a localhost
PROD_API_URL="http://172.17.32.106:8200"
if grep -q "VITE_API_URL=http://localhost" "$LOCAL_DIR/.env"; then
  sed -i "s|VITE_API_URL=http://localhost:4108|VITE_API_URL=$PROD_API_URL|g" "$LOCAL_DIR/.env"
  echo "✓  VITE_API_URL → $PROD_API_URL"
fi

# ─── 3. Build del frontend ────────────────────────────────────────────────────
echo ""
echo "▶ Instalando dependencias locales..."
cd "$LOCAL_DIR"
npm install

echo ""
echo "▶ Compilando frontend (tsc + vite build)..."
npm run build

echo "✓  Build generado en dist/"

# ─── 4. Transferir archivos al servidor ──────────────────────────────────────
echo ""
echo "▶ Transfiriendo archivos a $SERVER:$REMOTE_DIR ..."

# Crear directorio destino si no existe
ssh "$SERVER" "mkdir -p $REMOTE_DIR"

# Sincronizar: dist/, server/, package files, ecosystem, .env
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'deploy.sh' \
  dist/ "$SERVER:$REMOTE_DIR/dist/"

rsync -avz --progress \
  server/ "$SERVER:$REMOTE_DIR/server/"

rsync -avz \
  package.json \
  package-lock.json \
  ecosystem.config.cjs \
  .env \
  "$SERVER:$REMOTE_DIR/"

echo "✓  Archivos transferidos"

# ─── 5. Instalar dependencias y reiniciar PM2 ─────────────────────────────────
echo ""
echo "▶ Instalando dependencias en el servidor y reiniciando PM2..."

ssh "$SERVER" bash << 'REMOTE'
set -e
cd /home/userdes/culturacb

echo "  → npm install (producción)..."
npm install

echo "  → PM2: iniciar o reiniciar culturacb-api..."
if pm2 list | grep -q "culturacb-api"; then
  pm2 restart culturacb-api --update-env
else
  pm2 start ecosystem.config.cjs
fi

pm2 save
echo "  ✓ PM2 listo"
REMOTE

# ─── 6. Apache (solo primera vez con --setup-apache) ─────────────────────────
if [[ "${1:-}" == "--setup-apache" ]]; then
  echo ""
  echo "▶ Configurando Apache en el servidor..."

  rsync -avz culturacb.apache.conf "$SERVER:/tmp/culturacb.apache.conf"

  ssh "$SERVER" bash << 'APACHE'
set -e
echo "  → Copiando config Apache..."
sudo cp /tmp/culturacb.apache.conf /etc/apache2/sites-available/culturacb.conf

echo "  → Habilitando módulos necesarios..."
sudo a2enmod proxy proxy_http headers

echo "  → Habilitando sitio culturacb..."
sudo a2ensite culturacb

echo "  → Verificando sintaxis Apache..."
sudo apachectl configtest

echo "  → Reiniciando Apache..."
sudo systemctl restart apache2

echo "  ✓ Apache configurado y activo"
APACHE

fi

# ─── 7. Verificación final ────────────────────────────────────────────────────
echo ""
echo "▶ Verificando servicios en el servidor..."
ssh "$SERVER" bash << 'CHECK'
echo "--- PM2 ---"
pm2 list
echo ""
echo "--- Apache ---"
sudo systemctl status apache2 --no-pager -l | head -10
echo ""
echo "--- Puerto 4108 (API) ---"
ss -tlnp | grep 4108 || echo "  (no escuchando aún, esperá unos segundos)"
CHECK

echo ""
echo "✅ Deploy completado."
echo "   Frontend: http://172.17.32.106:8200"
echo "   API:      http://172.17.32.106:8200/api/"
