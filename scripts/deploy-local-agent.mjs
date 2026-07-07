#!/usr/bin/env node
/**
 * Локальный деплой-агент FOT:
 *   1. git pull (personal/main или origin/main)
 *   2. миграции БД на сервере (SSH)
 *   3. сборка fot-app локально (prod VITE_* с сервера)
 *   4. загрузка dist на сервер (tar + SFTP + атомарный swap)
 *
 * Usage:
 *   node scripts/deploy-local-agent.mjs
 *   node scripts/deploy-local-agent.mjs --skip-migrate
 *   node scripts/deploy-local-agent.mjs --migrate-only
 *   node scripts/deploy-local-agent.mjs --migrate-dry-run
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAuto, exec, fastPut, sftp } from './fot-ssh/client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const APP_DIR = join(REPO_ROOT, 'fot-app');
const DIST_DIR = join(APP_DIR, 'dist');

const SITE_FRONTEND = '/srv/sites/fot.su10.ru/fot-app';
const BUILD_DIR = '/opt/fot-build';
const FOT_BRANCH = process.env.FOT_BRANCH || 'main';
const FOT_REMOTE = process.env.FOT_REMOTE || detectGitRemote();

const args = new Set(process.argv.slice(2));
const SKIP_PULL = args.has('--skip-pull');
const SKIP_MIGRATE = args.has('--skip-migrate');
const SKIP_BUILD = args.has('--skip-build');
const MIGRATE_ONLY = args.has('--migrate-only');
const MIGRATE_DRY_RUN = args.has('--migrate-dry-run');

function log(msg) {
  console.log(`→ ${msg}`);
}

function die(msg, code = 1) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function run(cmd, opts = {}) {
  const result = spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    die(`команда завершилась с кодом ${result.status ?? 1}: ${cmd}`);
  }
}

function runCapture(cmd, opts = {}) {
  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    cwd: opts.cwd ?? REPO_ROOT,
    env: { ...process.env, ...opts.env },
  });
  if (result.status !== 0) {
    die(`команда завершилась с кодом ${result.status ?? 1}: ${cmd}\n${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

function detectGitRemote() {
  const remotes = runCapture('git remote');
  if (remotes.split(/\s+/).includes('personal')) return 'personal';
  if (remotes.split(/\s+/).includes('origin')) return 'origin';
  die('не найден git remote personal или origin');
}

function usage() {
  console.log(`Usage:
  node scripts/deploy-local-agent.mjs [options]

Полный цикл: pull → migrate → build → upload.

Options:
  --skip-pull         не делать git pull
  --skip-migrate      пропустить миграции
  --skip-build        не собирать (залить существующий dist/)
  --migrate-only      только миграции (с синхронизацией git на сервере)
  --migrate-dry-run   миграции: только отчёт, без наката
  -h, --help          эта справка

Env:
  FOT_REMOTE=personal|origin   (auto)
  FOT_BRANCH=main
`);
}

if (args.has('-h') || args.has('--help')) {
  usage();
  process.exit(0);
}

async function gitPull() {
  log(`Подтягиваю ${FOT_REMOTE}/${FOT_BRANCH}...`);
  run(`git fetch ${FOT_REMOTE} ${FOT_BRANCH} --prune`);
  const before = runCapture('git rev-parse --short HEAD');
  run(`git checkout -B ${FOT_BRANCH} ${FOT_REMOTE}/${FOT_BRANCH}`);
  run(`git reset --hard ${FOT_REMOTE}/${FOT_BRANCH}`);
  const after = runCapture('git rev-parse --short HEAD');
  console.log(`✓ git: ${before} -> ${after}`);
  return after;
}

async function remoteMigrate() {
  const migrateArgs = MIGRATE_DRY_RUN ? ' --dry-run' : '';
  const cmd = [
    `cd ${BUILD_DIR}`,
    `bash scripts/deploy-server.sh migrate${migrateArgs}`,
  ].join(' && ');

  log('Миграции на сервере...');
  const conn = await connectAuto();
  try {
    const r = await exec(conn, cmd);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code !== 0) die(`миграции завершились с кодом ${r.code}`);
  } finally {
    conn.end();
  }
}

async function fetchProdViteEnv() {
  log('Читаю prod VITE_* с сервера...');
  const conn = await connectAuto();
  try {
    const r = await exec(
      conn,
      `grep -E '^(VITE_|SENTRY_)' ${SITE_FRONTEND}/.env || true`,
    );
    if (r.code !== 0) die(`не удалось прочитать ${SITE_FRONTEND}/.env`);
    const env = {};
    for (const line of r.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    if (!env.VITE_API_URL) {
      die(`VITE_API_URL не найден в ${SITE_FRONTEND}/.env`);
    }
    return env;
  } finally {
    conn.end();
  }
}

function frontendDepsStale() {
  const lock = join(APP_DIR, 'package-lock.json');
  const sentinel = join(APP_DIR, 'node_modules', '.package-lock.hash');
  if (!existsSync(join(APP_DIR, 'node_modules', '.bin', 'vite'))) return true;
  if (!existsSync(sentinel)) return true;
  try {
    const current = runCapture(`node -e "console.log(require('crypto').createHash('sha256').update(require('fs').readFileSync('package-lock.json')).digest('hex'))"`, { cwd: APP_DIR });
    const saved = runCapture(`type "${sentinel}"`, { cwd: APP_DIR });
    return current !== saved.trim();
  } catch {
    return true;
  }
}

function ensureFrontendDeps() {
  if (!frontendDepsStale()) return;
  log('npm ci в fot-app...');
  run('npm ci --include=dev', { cwd: APP_DIR, env: { npm_config_production: 'false' } });
  run(`node -e "const fs=require('fs'),c=require('crypto');fs.writeFileSync('node_modules/.package-lock.hash',c.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))"`, { cwd: APP_DIR });
}

async function buildFrontend(release) {
  log('Собираю fot-app локально...');
  ensureFrontendDeps();

  const prodEnv = await fetchProdViteEnv();
  const buildEnv = {
    ...prodEnv,
    VITE_SENTRY_RELEASE: release,
    SENTRY_RELEASE: release,
    NODE_OPTIONS: '--max-old-space-size=2048',
  };

  run('npx tsc -b', { cwd: APP_DIR, env: buildEnv });
  run('npx vite build --outDir dist.new', { cwd: APP_DIR, env: buildEnv });

  const indexPath = join(APP_DIR, 'dist.new', 'index.html');
  if (!existsSync(indexPath)) die('сборка не создала dist.new/index.html');

  run('node -e "const fs=require(\'fs\'),p=require(\'path\');function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(f.endsWith(\'.map\'))fs.unlinkSync(f);}}w(process.argv[1])" dist.new', {
    cwd: APP_DIR,
  });

  rmSync(DIST_DIR, { recursive: true, force: true });
  run('node -e "require(\'fs\').renameSync(\'dist.new\',\'dist\')"', { cwd: APP_DIR });
  console.log(`✓ frontend build: ${release}`);
}

async function uploadDist() {
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    die(`нет ${DIST_DIR}/index.html — сначала соберите фронт`);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'fot-dist-'));
  const tarball = join(tmpDir, 'dist.tar.gz');
  const remoteTar = '/tmp/fot-dist-upload.tar.gz';

  log('Упаковываю dist...');
  run(`tar -czf "${tarball}" -C dist .`, { cwd: APP_DIR });

  log('Загружаю на сервер...');
  const conn = await connectAuto();
  try {
    const client = await sftp(conn);
    await fastPut(client, tarball, remoteTar);

    const publishScript = `
set -euo pipefail
SITE="${SITE_FRONTEND}"
TMP="$(mktemp -d /tmp/fot-dist-XXXXXX)"
trap 'rm -rf "$TMP" "${remoteTar}"' EXIT
tar -xzf "${remoteTar}" -C "$TMP"
test -f "$TMP/index.html"
rm -rf "$SITE/dist.new"
cp -a "$TMP" "$SITE/dist.new"
rm -rf "$SITE/dist.old"
[ -d "$SITE/dist" ] && mv "$SITE/dist" "$SITE/dist.old"
mv "$SITE/dist.new" "$SITE/dist"
rm -rf "$SITE/dist.old"
find "$SITE/dist" -type d -exec chmod 755 {} \\;
find "$SITE/dist" -type f -exec chmod 644 {} \\;
echo "✓ frontend опубликован в $SITE/dist"
`.trim();

    const r = await exec(conn, publishScript);
    process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    if (r.code !== 0) die(`публикация dist завершилась с кодом ${r.code}`);
  } finally {
    conn.end();
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  log(`Деплой-агент (remote=${FOT_REMOTE}, branch=${FOT_BRANCH})`);

  let release = runCapture('git rev-parse --short HEAD');

  if (!SKIP_PULL) {
    release = await gitPull();
  }

  if (!SKIP_MIGRATE || MIGRATE_ONLY) {
    await remoteMigrate();
  }

  if (MIGRATE_ONLY) {
    log('Готово (--migrate-only).');
    return;
  }

  if (!SKIP_BUILD) {
    await buildFrontend(release);
  }

  await uploadDist();
  log(`Готово. Коммит ${release}. На фронте — hard refresh (Ctrl+Shift+R).`);
}

main().catch((e) => {
  console.error(`deploy-local-agent: ${e.message}`);
  process.exit(1);
});
