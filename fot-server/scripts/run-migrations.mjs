// Раннер SQL-миграций из docs/migrations/.
//
// Учитывает уже применённые миграции (таблица public.schema_migrations),
// накатывает только новые, печатает отчёт (старых / новых / результат каждой).
// При 0 новых — рапортует и ничего не запускает.
//
// Подключение как у диагностических скриптов: DATABASE_URL берётся из
// fot-server/.env, CA — из .migration/yandex-ca.pem. ssl*-параметры вычищаются
// из URL (там линуксовый путь к CA, локально его нет), CA подаётся явно.
// DATABASE_URL и параметры запросов НЕ логируются.
//
// Usage:
//   node fot-server/scripts/run-migrations.mjs [--dry-run] [--baseline] [--init]
//        [--env PATH] [--ca PATH] [--dir PATH]
//
//   (без флагов)  apply: накатить новые миграции и записать их.
//   --dry-run     только read-only self-test (Фаза 0): отчёт, без записи.
//   --baseline    пометить ВСЕ текущие файлы как применённые БЕЗ выполнения
//                 (однократно на БД, которая уже накатана вручную).
//   --init        разрешить реальный накат на первом запуске (пустая/свежая БД).
//
// Без --baseline/--init первый запуск (таблицы учёта ещё нет) строго read-only:
// печатает отчёт и выходит, ничего не накатывая.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.FOT_REPO_ROOT || path.resolve(__dirname, '../..');

// --- аргументы ---------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dryRun: false, baseline: false, init: false, env: null, ca: null, dir: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--dry-run': opts.dryRun = true; break;
      case '--baseline': opts.baseline = true; break;
      case '--init': opts.init = true; break;
      case '--env': opts.env = argv[++i]; break;
      case '--ca': opts.ca = argv[++i]; break;
      case '--dir': opts.dir = argv[++i]; break;
      case '-h':
      case '--help':
        console.log('Usage: node run-migrations.mjs [--dry-run] [--baseline] [--init] [--env PATH] [--ca PATH] [--dir PATH]');
        process.exit(0);
        break;
      default:
        console.error(`Неизвестный аргумент: ${a}`);
        process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const ENV_PATH = path.resolve(opts.env || path.join(REPO_ROOT, 'fot-server/.env'));
const CA_PATH = path.resolve(opts.ca || path.join(REPO_ROOT, '.migration/yandex-ca.pem'));
const MIGRATIONS_DIR = path.resolve(opts.dir || path.join(REPO_ROOT, 'docs/migrations'));

// --- env / подключение -------------------------------------------------------

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

if (!fs.existsSync(ENV_PATH)) {
  console.error(`Не найден env-файл: ${ENV_PATH}`);
  process.exit(2);
}
const env = parseEnv(fs.readFileSync(ENV_PATH, 'utf8'));
const dbUrl = env.DATABASE_URL;
if (!dbUrl) { console.error(`Missing DATABASE_URL in ${ENV_PATH}`); process.exit(2); }

const sslDisabled = String(env.DATABASE_SSL ?? 'true').toLowerCase() === 'false';
let ca = null;
if (!sslDisabled && fs.existsSync(CA_PATH)) ca = fs.readFileSync(CA_PATH, 'utf8');
const ssl = sslDisabled ? false : (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true });

// Чистим ssl*-параметры: pg-connection-string иначе readFileSync(sslrootcert)
// по линуксовому пути прода, которого локально нет. CA подаём через ssl.
let connStr = dbUrl;
let sanitizedHost = '<unknown>';
try {
  const u = new URL(dbUrl);
  for (const p of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(p);
  connStr = u.toString();
  sanitizedHost = `${u.hostname}:${u.port || '5432'} / db=${u.pathname.replace(/^\//, '')}`;
} catch { /* ignore */ }

// --- миграции на диске -------------------------------------------------------

if (!fs.existsSync(MIGRATIONS_DIR) || !fs.statSync(MIGRATIONS_DIR).isDirectory()) {
  console.error(`Каталог миграций не найден: ${MIGRATIONS_DIR}`);
  process.exit(2);
}

// Сортировка по имени файла. Нумерация NNN_ с ведущими нулями даёт верный
// числовой порядок; файлы с одинаковым номером — по алфавиту (байтовый порядок).
const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
const onDisk = files.map(name => {
  const text = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  const checksum = crypto.createHash('sha256').update(text).digest('hex');
  return { name, text, checksum, empty: text.trim().length === 0 };
});

// Определяет, управляет ли файл транзакцией сам (первый значимый токен — BEGIN).
function startsWithBegin(sql) {
  for (const raw of sql.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('--')) continue;
    return /^BEGIN\b/i.test(t) || /^START\s+TRANSACTION\b/i.test(t);
  }
  return false;
}

// CONCURRENTLY / VACUUM нельзя выполнять внутри транзакции. node-postgres шлёт
// многооператорный текст одной simple-query, а PostgreSQL оборачивает её в
// НЕЯВНУЮ транзакцию — поэтому такие файлы нельзя ни оборачивать, ни слать целиком:
// их операторы выполняем по одному (каждый в autocommit, как делает psql -f).
function needsAutocommit(sql) {
  return /\bCONCURRENTLY\b/i.test(sql) || /\bVACUUM\b/i.test(sql);
}

// Разбивает SQL на операторы по top-level `;`, корректно пропуская строковые/
// идентификаторные/dollar-quoted литералы и комментарии.
function splitSqlStatements(sql) {
  const stmts = [];
  let buf = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl;
      buf += sql.slice(i, end); i = end; continue;
    }
    if (two === '/*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      buf += sql.slice(i, end); i = end; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch && sql[j + 1] === ch) { j += 2; continue; }
        if (sql[j] === ch) { j += 1; break; }
        j += 1;
      }
      buf += sql.slice(i, j); i = j; continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += sql.slice(i, end); i = end; continue;
      }
    }
    if (ch === ';') {
      if (buf.trim()) stmts.push(buf.trim());
      buf = ''; i += 1; continue;
    }
    buf += ch; i += 1;
  }
  if (buf.trim()) stmts.push(buf.trim());
  return stmts;
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text
);`;

async function ensureTable(client) { await client.query(CREATE_TABLE_SQL); }

async function recordApplied(client, m, by) {
  await client.query(
    `INSERT INTO public.schema_migrations(filename, checksum, applied_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (filename) DO UPDATE
       SET checksum = EXCLUDED.checksum, applied_at = now(), applied_by = EXCLUDED.applied_by`,
    [m.name, m.checksum, by],
  );
}

// --- основной поток ----------------------------------------------------------

const client = new Client({
  connectionString: connStr,
  ssl,
  connectionTimeoutMillis: 10000,
  statement_timeout: 600000, // тяжёлые миграции (напр. 020) не должны упереться в дефолт
});

async function main() {
  await client.connect();
  const isReplica = (await client.query('SELECT pg_is_in_recovery() AS r')).rows[0].r;
  const tableExists =
    (await client.query("SELECT to_regclass('public.schema_migrations') AS t")).rows[0].t !== null;

  let appliedMap = new Map();
  if (tableExists) {
    const rows = (await client.query('SELECT filename, checksum FROM public.schema_migrations')).rows;
    for (const r of rows) appliedMap.set(r.filename, r.checksum);
  }

  const pending = onDisk.filter(m => !appliedMap.has(m.name));

  // --- Фаза 0: read-only self-test + отчёт ---
  console.log('=== Миграции: self-test (read-only) ===');
  console.log(`БД host: ${sanitizedHost}`);
  console.log(`connected (${isReplica ? 'replica' : 'PRIMARY'})`);
  console.log(`Каталог: ${MIGRATIONS_DIR}`);
  console.log(`Таблица учёта: ${tableExists ? 'есть' : 'отсутствует'}`);
  console.log(`Файлов на диске: ${onDisk.length}`);
  console.log(`Применено ранее (старых): ${appliedMap.size}`);
  console.log(`Новых (pending): ${pending.length}`);

  for (const m of onDisk) {
    if (m.empty) console.warn(`  ⚠ пустой файл миграции: ${m.name}`);
    const recorded = appliedMap.get(m.name);
    if (recorded && recorded !== m.checksum) {
      console.warn(`  ⚠ дрейф: ${m.name} изменён после применения (checksum не совпадает) — повторно НЕ накатывается`);
    }
  }
  if (pending.length > 0) {
    console.log('Новые миграции:');
    for (const m of pending) console.log(`  - ${m.name}`);
  }

  // --- --baseline: пометить всё применённым без выполнения ---
  if (opts.baseline) {
    if (isReplica) throw new Error('подключение к реплике — запись невозможна (нужен PRIMARY)');
    await ensureTable(client);
    let marked = 0;
    for (const m of onDisk) {
      const res = await client.query(
        `INSERT INTO public.schema_migrations(filename, checksum, applied_by)
         VALUES ($1, $2, 'baseline') ON CONFLICT (filename) DO NOTHING`,
        [m.name, m.checksum],
      );
      marked += res.rowCount;
    }
    console.log(`\n✓ Baseline: помечено как применённые ${marked} (всего на диске ${onDisk.length}).`);
    return 0;
  }

  // --- --dry-run: только отчёт ---
  if (opts.dryRun) {
    console.log('\n(--dry-run: ничего не применялось)');
    return 0;
  }

  // --- first-run guard: нет таблицы учёта и нет явного разрешения ---
  if (!tableExists && !opts.init) {
    console.log('\nТаблица учёта отсутствует. Это первый запуск — выполните единожды одно из:');
    console.log('  --baseline   пометить текущие миграции применёнными (БД уже накатана вручную)');
    console.log('  --init       реально накатить все миграции (пустая/свежая БД)');
    console.log('Сейчас ничего не выполнено (read-only).');
    return 0;
  }

  // --- 0 новых ---
  if (pending.length === 0) {
    console.log('\n✓ Новых миграций нет — ничего не запускаю.');
    return 0;
  }

  // --- Фаза 1: apply ---
  if (isReplica) throw new Error('подключение к реплике — запись невозможна (нужен PRIMARY)');
  await ensureTable(client);

  console.log('\n=== Применение миграций ===');
  let okCount = 0;
  let failed = null;
  for (const m of pending) {
    if (m.empty) {
      console.error(`  ✗ ${m.name}: файл пуст`);
      failed = m.name;
      break;
    }
    process.stdout.write(`→ ${m.name} ... `);
    try {
      if (startsWithBegin(m.text)) {
        // Файл содержит собственные BEGIN/COMMIT — выполняем как есть, запись отдельно.
        await client.query(m.text);
        await recordApplied(client, m, 'runner');
      } else if (needsAutocommit(m.text)) {
        // CONCURRENTLY/VACUUM — по одному оператору в autocommit, без обёртки.
        for (const stmt of splitSqlStatements(m.text)) await client.query(stmt);
        await recordApplied(client, m, 'runner');
      } else {
        // Нет транзакции — оборачиваем, чтобы применение и запись были атомарны.
        await client.query('BEGIN');
        await client.query(m.text);
        await recordApplied(client, m, 'runner');
        await client.query('COMMIT');
      }
      okCount++;
      console.log('ok');
    } catch (err) {
      console.log('ОШИБКА');
      await client.query('ROLLBACK').catch(() => {});
      console.error(`  ✗ ${m.name}: ${err?.message ?? err}`);
      failed = m.name;
      break; // ON_ERROR_STOP: дальше не идём
    }
  }

  console.log(`\nИтог: применено ${okCount} из ${pending.length}.`);
  if (failed) {
    console.error(`Остановлено на ${failed}. Последующие миграции не применялись.`);
    return 1;
  }
  console.log('✓ Все новые миграции применены.');
  return 0;
}

try {
  const code = await main();
  await client.end();
  process.exit(code);
} catch (err) {
  console.error(`\nОшибка раннера: ${err?.message ?? err}`);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
}
