// Восстановление имён файлов заявок на подбор (hiring_request_files),
// испорченных кодировкой multer (latin1 vs utf8).
//
// До фикса uploadFile сохранял req.file.originalname НАПРЯМУЮ, без
// decodeMulterFilename и без sanitizeFileName. multer/busboy декодирует
// filename в multipart как latin1, поэтому UTF-8 байты русского имени
// осели в БД как мусор вида «Ð¡Ð°Ð¼Ð¾Ð»Ð¾Ð²….doc».
//
// В ОТЛИЧИЕ от documents здесь санитизация НЕ применялась — исходные
// continuation-байты UTF-8 сохранены, значит восстановление обратимо:
//   Buffer.from(name, 'latin1').toString('utf8')
// Берём только строки, где это безопасно (все коды ≤ 0xFF, результат
// меняется и валиден — без символа замены U+FFFD), затем sanitizeFileName.
//
// БД и CA берёт из fot-server/.env и .migration/yandex-ca.pem.
//
// По умолчанию --dry-run. Реальная запись — флаг --apply. Идемпотентен.
//
// Usage:
//   node fot-server/scripts/fix-hiring-file-names-encoding.mjs            # dry-run
//   node fot-server/scripts/fix-hiring-file-names-encoding.mjs --apply    # запись

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

// Копия sanitizeFileName из src/utils/file-validation.utils.ts (паритет с upload).
function sanitizeFileName(name, maxLength = 200) {
  const base = name.replace(/^.*[\\/]/, '').replace(/[\x00-\x1f\x7f]/g, '');
  let cleaned = base.replace(/[^\p{L}\p{N}.\-_ ()+№]/gu, '_').slice(0, maxLength);
  if (/^[=+\-@\t\r]/.test(cleaned)) cleaned = `'${cleaned}`;
  return cleaned || 'file';
}

// Возвращает восстановленное имя, либо null если строку трогать нельзя.
function recoverName(name) {
  if (!name || typeof name !== 'string') return null;
  // только latin1-mojibake: все коды символов ≤ 0xFF (иначе уже не latin1).
  for (let i = 0; i < name.length; i++) {
    if (name.charCodeAt(i) > 0xff) return null;
  }
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  if (decoded === name) return null;            // pure-ASCII → нечего восстанавливать
  if (decoded.includes('�')) return null;  // не валидный UTF-8 → не трогаем
  const clean = sanitizeFileName(decoded);
  return clean === name ? null : clean;
}

async function run(client) {
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`Режим: ${APPLY ? 'APPLY (запись в БД)' : 'DRY-RUN (только отчёт)'}\n`);

  const rows = (await client.query(
    `SELECT id, file_name FROM hiring_request_files WHERE file_name IS NOT NULL ORDER BY id`,
  )).rows;
  console.log(`Всего hiring_request_files: ${rows.length}`);

  const fixable = [];
  for (const r of rows) {
    const next = recoverName(r.file_name);
    if (next) fixable.push({ id: r.id, old: r.file_name, next });
  }
  console.log(`К восстановлению: ${fixable.length}\n`);

  if (fixable.length === 0) {
    console.log('Битых имён не найдено — нечего делать.');
    return;
  }

  const previewLimit = Math.min(fixable.length, 30);
  console.log(`Превью первых ${previewLimit}:`);
  for (let i = 0; i < previewLimit; i++) {
    const r = fixable[i];
    console.log(`  #${r.id}: «${r.old}» → «${r.next}»`);
  }
  if (fixable.length > previewLimit) {
    console.log(`  … и ещё ${fixable.length - previewLimit}`);
  }

  if (!APPLY) {
    console.log('\n--apply не передан, запись пропущена. Перезапуск с --apply применит изменения.');
    return;
  }

  console.log('\nПрименяю UPDATE…');
  let updated = 0;
  for (const r of fixable) {
    await client.query(`UPDATE hiring_request_files SET file_name = $1 WHERE id = $2`, [r.next, r.id]);
    updated++;
  }
  console.log(`Обновлено строк: ${updated}`);
}

const client = new Client({ connectionString: connStr, ssl: { ca, rejectUnauthorized: true } });
client.connect()
  .then(() => run(client))
  .catch((err) => { console.error('Ошибка:', err.message); process.exitCode = 1; })
  .finally(() => client.end().catch(() => {}));
