#!/usr/bin/env node
/** Деплой unpushed коммитов через git bundle (когда push недоступен). */
import { readFileSync } from 'node:fs';
import { connectAuto, exec, fastPut, sftp } from './fot-ssh/client.mjs';

const bundlePath = process.argv[2];
if (!bundlePath) {
  console.error('Usage: node scripts/deploy-bundle-backend.mjs <path-to.bundle>');
  process.exit(1);
}

const remoteBundle = '/tmp/fot-hotfix.bundle';
const BUILD_DIR = '/opt/fot-build';
const SITE_DIR = '/srv/sites/fot.su10.ru';

const conn = await connectAuto();
try {
  console.log('→ Загружаю bundle...');
  const client = await sftp(conn);
  await fastPut(client, bundlePath, remoteBundle);

  const script = `
set -euo pipefail
BUILD_DIR=${BUILD_DIR}
SITE_DIR=${SITE_DIR}
cd "$BUILD_DIR"
git pull ${remoteBundle} HEAD
AFTER=$(git rev-parse --short HEAD)
app_dir="$BUILD_DIR/fot-server"
site_dir="$SITE_DIR/fot-server"
echo "→ BUILD_DIR на $AFTER"
cd "$app_dir"
test -x ./node_modules/.bin/tsc || npm ci --include=dev
rm -rf dist.new
npm run build -- --outDir dist.new
test -f dist.new/index.js
rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv dist.new dist
rm -rf dist.old
cp "$app_dir/package.json" "$site_dir/package.json"
cp "$app_dir/package-lock.json" "$site_dir/package-lock.json"
cp "$app_dir/ecosystem.config.cjs" "$site_dir/ecosystem.config.cjs"
rm -rf "$site_dir/dist.new"
cp -a "$app_dir/dist" "$site_dir/dist.new"
rm -rf "$site_dir/dist.old"
[ -d "$site_dir/dist" ] && mv "$site_dir/dist" "$site_dir/dist.old"
mv "$site_dir/dist.new" "$site_dir/dist"
rm -rf "$site_dir/dist.old"
printf '%s\\n' "$AFTER" > "$site_dir/dist/.deployed_commit"
pm2 startOrReload "$site_dir/ecosystem.config.cjs" --update-env
pm2 save
echo "→ Бэкафилл CDR в фоне..."
cd "$app_dir"
nohup npx tsx scripts/backfill-mts-cdr.ts --from=2026-06-01 --cleanup-metrics --apply > /tmp/mts-cdr-backfill.log 2>&1 &
echo "✓ backend $AFTER, backfill pid=$!"
`.trim();

  console.log('→ Деплой backend + бэкафилл...');
  const r = await exec(conn, script);
  process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code !== 0) process.exit(r.code);
} finally {
  conn.end();
}
