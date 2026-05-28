// Восстановление имён документов, испорченных кодировкой multer (latin1 vs utf8).
//
// До фикса (коммит de3ca17) кириллические имена прикреплённых файлов сохранялись
// в БД как мусор вида «Ð_Ð_Ñ_Ð¾Ð²Ð_Ð_µ.jpeg». Причина: multer/busboy декодирует
// filename в multipart как latin1, а sanitizeFileName потом заменяет
// non-ascii control-байты на «_». Восстановить исходные русские буквы из такого
// мусора нельзя (continuation-байты UTF-8 уже потеряны → underscore).
//
// Скрипт находит все documents с признаками double-encoding (Ð/Ñ/¾/¶/µ/… или
// длинные серии «_») и переименовывает их в детерминированное «Документ_{id}.{ext}».
// Это убирает иероглифы из БД, UI и ContentDisposition при скачивании.
//
// БД и CA берёт из fot-server/.env и .migration/yandex-ca.pem (как fix-orphan-approved-users.mjs).
//
// По умолчанию --dry-run. Реальная запись — флаг --apply. Идемпотентен.
//
// Usage:
//   node fot-server/scripts/backfill-broken-document-filenames.mjs            # dry-run
//   node fot-server/scripts/backfill-broken-document-filenames.mjs --apply    # запись

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

const REPO_ROOT = process.env.FOT_REPO_ROOT || 'C:/Users/Usrr/VSCode/Odintsov/FOT';
const ENV_PATH = path.resolve(REPO_ROOT, 'fot-server/.env');
const CA_PATH = path.resolve(REPO_ROOT, '.migration/yandex-ca.pem');

const APPLY = process.argv.includes('--apply');

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    out[k] = v;
  }
  return out;
}

const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const dbUrl = env.DATABASE_URL;
if (!dbUrl) { console.error('Missing DATABASE_URL in fot-server/.env'); process.exit(2); }
const ca = fs.readFileSync(CA_PATH, 'utf8');

let connStr = dbUrl;
let sanitizedHost = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

// Признаки double-encoded UTF-8→latin1: характерные «Ð»/«Ñ»/«µ»/… в верхнем
// диапазоне 0xC0–0xFF + длинные серии подчёркиваний (≥3 подряд).
const BROKEN_CHARS_RE = /[À-ÿ]{2,}/;
const LONG_UNDERSCORES_RE = /_{3,}/;

function isBrokenName(name) {
  if (!name || typeof name !== 'string') return false;
  if (BROKEN_CHARS_RE.test(name)) return true;
  if (LONG_UNDERSCORES_RE.test(name)) return true;
  return false;
}

function buildRecoveryName(id, oldName) {
  const ext = (() => {
    const e = path.extname(oldName || '');
    if (!e || e.length > 10) return '';
    return e.replace(/[^a-zA-Z0-9.]/g, '');
  })();
  return `Документ_${id}${ext || ''}`;
}

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`Режим: ${APPLY ? 'APPLY (запись в БД)' : 'DRY-RUN (только отчёт)'}\n`);

  const rows = (await client.query(
    `SELECT id, file_name FROM documents WHERE file_name IS NOT NULL ORDER BY id`,
  )).rows;
  console.log(`Всего documents: ${rows.length}`);

  const broken = rows.filter(r => isBrokenName(r.file_name));
  console.log(`С признаками битой кодировки: ${broken.length}\n`);

  if (broken.length === 0) {
    console.log('Битых имён не найдено — нечего делать.');
    return;
  }

  const previewLimit = Math.min(broken.length, 20);
  console.log(`Превью первых ${previewLimit}:`);
  for (let i = 0; i < previewLimit; i++) {
    const r = broken[i];
    const next = buildRecoveryName(r.id, r.file_name);
    console.log(`  #${r.id}: «${r.file_name}» → «${next}»`);
  }
  if (broken.length > previewLimit) {
    console.log(`  … и ещё ${broken.length - previewLimit}`);
  }

  if (!APPLY) {
    console.log('\n--apply не передан, запись пропущена. Перезапуск с --apply применит изменения.');
    return;
  }

  console.log('\nПрименяю UPDATE…');
  let updated = 0;
  for (const r of broken) {
    const next = buildRecoveryName(r.id, r.file_name);
    await client.query(`UPDATE documents SET file_name = $1 WHERE id = $2`, [next, r.id]);
    updated++;
  }
  console.log(`Обновлено строк: ${updated}`);
}

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });
client.connect()
  .then(() => run(client))
  .catch((err) => { console.error('Ошибка:', err.message); process.exitCode = 1; })
  .finally(() => client.end().catch(() => {}));
