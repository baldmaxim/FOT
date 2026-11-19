/**
 * Физлица 1С (выгрузка «ФизЛица») → «Реквизиты» работающих сотрудников. Логика —
 * src/services/hr-1c-persons/*, план: только пустые поля, расхождения — в отчёт.
 *
 * Запуск на hub из /opt/fot-build/fot-server (ключ шифрования — из прод-.env, локально не нужен):
 *   npx tsx scripts/import-1c-persons.ts --preview  --file ~/fiz.xlsx --as-of 2026-11-19 --out ~/fiz-preview.xlsx
 *   HR_IMPORT_USER_ID=<user_profiles.id> npx tsx scripts/import-1c-persons.ts --apply \
 *       --file ~/fiz.xlsx --as-of 2026-11-19 --report ~/fiz-preview.xlsx --journal ~/fiz-apply.jsonl
 *   npx tsx scripts/import-1c-persons.ts --verify   --file ~/fiz.xlsx --journal ~/fiz-apply.jsonl
 *   HR_IMPORT_USER_ID=<…> npx tsx scripts/import-1c-persons.ts --rollback --file ~/fiz.xlsx --journal ~/fiz-apply.jsonl
 *
 * --env <путь к .env> (по умолчанию /srv/sites/fot.su10.ru/fot-server/.env), --ca <yandex-ca.pem>.
 * --preview и --verify работают в сессии только для чтения и проверяют это до первого запроса.
 * В консоль и журнал не попадают значения ПДн — только счётчики и номера карточек.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const flag = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const expand = (p: string): string => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
const required = (name: string): string => {
  const v = flag(name);
  if (!v) throw new Error(`Не указан ${name}`);
  return v;
};

const MODES = ['--preview', '--apply', '--verify', '--rollback'].filter(has);
const SITE_DIR = '/srv/sites/fot.su10.ru';

const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const firstExisting = (paths: Array<string | null | undefined>): string | null =>
  paths.find(p => p && fs.existsSync(p)) ?? null;

/** Env до импорта модулей приложения: config/env.ts читает его при загрузке. */
const prepareEnv = (readOnly: boolean): void => {
  process.env.NODE_ENV = 'test'; // dotenv из cwd не перетирает выбранный .env
  const envPath = firstExisting([flag('--env') ? expand(flag('--env')!) : null, path.join(SITE_DIR, 'fot-server/.env')]);
  if (!envPath) throw new Error('Не найден .env — укажите --env');
  const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
  for (const [k, v] of Object.entries(env)) if (k !== 'NODE_ENV') process.env[k] = v;
  const url = new URL(env.DATABASE_URL ?? '');
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl', 'options']) url.searchParams.delete(k);
  if (readOnly) url.searchParams.set('options', '-c default_transaction_read_only=on');
  process.env.DATABASE_URL = url.toString();
  process.env.DATABASE_POOL_MAX = '3';
  // Прод — всегда SSL с CA; DATABASE_SSL=false в .env — только для тестовой базы.
  process.env.DATABASE_SSL = env.DATABASE_SSL === 'false' ? 'false' : 'true';
  if (process.env.DATABASE_SSL === 'false') return;
  const ca = firstExisting([flag('--ca') ? expand(flag('--ca')!) : null, env.DATABASE_SSL_CA_PATH, path.join(SITE_DIR, '.migration/yandex-ca.pem')]);
  if (!ca) throw new Error('Не найден CA (yandex-ca.pem) — укажите --ca');
  process.env.DATABASE_SSL_CA_PATH = ca;
};

const printStats = (title: string, stats: Map<string, number> | Array<[string, number | string]>): void => {
  console.log(`[1c-persons] ${title}`);
  for (const [k, v] of stats) console.log(`  ${k}: ${v}`);
};

const main = async (): Promise<void> => {
  if (MODES.length !== 1) throw new Error('Укажите один режим: --preview | --apply | --verify | --rollback');
  const mode = MODES[0];
  const readOnly = mode === '--preview' || mode === '--verify';
  prepareEnv(readOnly);

  const { query, closeDb } = await import('../src/config/postgres.js');
  const { isHrCryptoConfigured } = await import('../src/services/hr-crypto.service.js');
  try {
    if (!isHrCryptoConfigured()) throw new Error('Ключ шифрования HR не настроен (ENCRYPTION_KEY)');
    const ro = (await query<{ transaction_read_only: string }>('SHOW transaction_read_only'))[0]?.transaction_read_only;
    if (readOnly && ro !== 'on') throw new Error('Сессия не только для чтения — предпросмотр/сверка остановлены');
    if (!readOnly && ro === 'on') throw new Error('Сессия только для чтения — запись невозможна');
    const userId = (): string => {
      const v = process.env.HR_IMPORT_USER_ID;
      if (!v) throw new Error('Не задан HR_IMPORT_USER_ID (user_profiles.id того, кто запускает)');
      return v;
    };
    const run = await import('../src/services/hr-1c-persons/run.js');
    const audit = await import('../src/services/hr-1c-persons/audit.js');
    const file = expand(required('--file'));

    if (mode === '--preview') {
      const out = expand(required('--out'));
      printStats('Предпросмотр', await run.runPreview({ file, asOf: required('--as-of'), out }));
      console.log(`[1c-persons] Отчёт (права 600): ${out}`);
    } else if (mode === '--apply') {
      const stats = await run.runApply({
        file, asOf: required('--as-of'), report: expand(required('--report')), journal: expand(required('--journal')), userId: userId(),
      });
      printStats('Запись', stats);
    } else {
      const journal = expand(required('--journal'));
      const res = mode === '--verify' ? await audit.runVerify({ file, journal }) : await audit.runRollback({ file, journal, userId: userId() });
      printStats(mode === '--verify' ? 'Сверка' : 'Откат', res.counts);
      for (const p of res.problems) console.log(`  ! ${p}`);
      if (res.problems.length > 0) process.exitCode = 1;
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
};

main().catch(err => {
  console.error('[1c-persons] ошибка:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
