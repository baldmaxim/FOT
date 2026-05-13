// assert-env.ts
//
// Pre-flight: проверяет что окружение готово к cutover.
// Read-only — никаких DDL/DML, только SELECT version()/current_database()/
// pg_is_in_recovery() на target.
//
// Запуск (после source .migration/yandex.env):
//   npm run migrate:yandex:assert-env
//
// Exit codes:
//   0 — все проверки passed
//   1 — есть critical fail (см. вывод)
//   2 — нештатное падение

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

interface ICheck {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

function mask(url: string | undefined): string {
  if (!url) return '(unset)';
  return url.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@');
}

function checkEnvPresent(name: string, required: boolean): ICheck {
  const v = process.env[name];
  if (v && v.length > 0) {
    let detail = `set (${v.length} chars)`;
    if (name.endsWith('URL') || name === 'TARGET_DATABASE_URL') {
      detail = `set: ${mask(v)}`;
    }
    return { name, status: 'ok', detail };
  }
  return { name, status: required ? 'fail' : 'warn', detail: 'not set' };
}

function checkFileExists(name: string, p: string | undefined): ICheck {
  if (!p) return { name, status: 'fail', detail: 'path not set' };
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return { name, status: 'fail', detail: `file missing at ${abs}` };
  const sz = fs.statSync(abs).size;
  return { name, status: 'ok', detail: `${abs} (${sz} bytes)` };
}

function checkTargetIsYandex(url: string | undefined): ICheck {
  if (!url) return { name: 'target_is_yandex', status: 'fail', detail: 'TARGET_DATABASE_URL not set' };
  const u = url.toLowerCase();
  if (u.includes('supabase.com') || u.includes('supabase.co')) {
    return { name: 'target_is_yandex', status: 'fail', detail: 'URL похож на Supabase — это НЕ target для cutover' };
  }
  if (!u.includes('yandexcloud.net') && !u.includes('mdb.yandex')) {
    return { name: 'target_is_yandex', status: 'warn', detail: 'URL не содержит yandexcloud.net (если это не Yandex — abort)' };
  }
  return { name: 'target_is_yandex', status: 'ok', detail: 'выглядит как Yandex Managed PG' };
}

async function checkTargetConnect(url: string | undefined, caPath: string | undefined): Promise<ICheck> {
  if (!url) return { name: 'target_connect', status: 'fail', detail: 'TARGET_DATABASE_URL not set' };
  const opts: ConstructorParameters<typeof Client>[0] = { connectionString: url };
  if (caPath && fs.existsSync(caPath)) {
    opts.ssl = { ca: fs.readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  const client = new Client(opts);
  try {
    await client.connect();
    const r = await client.query<{
      version: string;
      db: string;
      usr: string;
      is_replica: boolean;
    }>('SELECT version() AS version, current_database() AS db, current_user AS usr, pg_is_in_recovery() AS is_replica');
    const row = r.rows[0];
    await client.end();
    if (!row) return { name: 'target_connect', status: 'fail', detail: 'no row from SELECT version()' };
    if (row.is_replica) {
      return { name: 'target_connect', status: 'fail', detail: `${row.db}@${row.usr} — это REPLICA, не primary! Использовать primary host.` };
    }
    return {
      name: 'target_connect',
      status: 'ok',
      detail: `${row.db}@${row.usr} | ${row.version.slice(0, 60)} | primary`,
    };
  } catch (err) {
    try { await client.end(); } catch {}
    return { name: 'target_connect', status: 'fail', detail: `connect/query failed: ${(err as Error).message}` };
  }
}

async function checkSourceConnect(url: string | undefined): Promise<ICheck> {
  if (!url) return { name: 'source_connect', status: 'warn', detail: 'SOURCE_DATABASE_URL not set (cutover finale needs source — set if doing dump)' };
  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    const r = await client.query<{ version: string }>('SELECT version() AS version');
    await client.end();
    return { name: 'source_connect', status: 'ok', detail: `connected | ${r.rows[0]?.version?.slice(0, 60) ?? ''}` };
  } catch (err) {
    try { await client.end(); } catch {}
    return { name: 'source_connect', status: 'warn', detail: `not reachable: ${(err as Error).message}` };
  }
}

function checkEnvLooksLikeCutoverFinale(): ICheck {
  // SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY НЕ должны быть в shell после переключения.
  // На pre-flight (когда ещё качаем с Supabase) — могут быть. Поэтому это warn, не fail.
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl || supaKey) {
    return {
      name: 'supabase_env_residue',
      status: 'warn',
      detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY всё ещё в shell env. До cutover это OK; после cutover убрать.',
    };
  }
  return { name: 'supabase_env_residue', status: 'ok', detail: 'no Supabase env vars in shell' };
}

function checkSkudEventsMode(): ICheck {
  const mode = process.env.SKUD_EVENTS_MIGRATION_MODE;
  const confirm = process.env.CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL;
  if (mode === 'sigur_api_manual' && confirm === 'true') {
    return { name: 'skud_events_mode', status: 'ok', detail: 'manual Sigur API backfill accepted (production-path)' };
  }
  if (mode === 'sigur_api_manual' && confirm !== 'true') {
    return { name: 'skud_events_mode', status: 'warn', detail: 'mode set, но CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL != true — verify-public exit будет 1' };
  }
  return { name: 'skud_events_mode', status: 'warn', detail: 'не задан — verify-public-data вернёт exit 1 на skud_events* (что норм до cutover; перед запуском verify выставить оба флага)' };
}

async function main(): Promise<void> {
  const checks: ICheck[] = [];

  checks.push(checkEnvPresent('TARGET_DATABASE_URL', true));
  checks.push(checkEnvPresent('SOURCE_DATABASE_URL', false));
  checks.push(checkEnvPresent('SOURCE_DATABASE_URL_NODE', false));
  checks.push(checkEnvPresent('TARGET_SSL_CA_PATH', false));
  checks.push(checkFileExists('target_ca_file', process.env.TARGET_SSL_CA_PATH));
  checks.push(checkTargetIsYandex(process.env.TARGET_DATABASE_URL));
  checks.push(checkEnvLooksLikeCutoverFinale());
  checks.push(checkSkudEventsMode());

  // Storage migration env (optional на pre-flight; обязательно для шага 19)
  checks.push(checkEnvPresent('SOURCE_SUPABASE_URL', false));
  checks.push(checkEnvPresent('SOURCE_SUPABASE_SERVICE_ROLE_KEY', false));
  checks.push(checkEnvPresent('TARGET_OBJECT_STORAGE_ENDPOINT', false));
  checks.push(checkEnvPresent('TARGET_BUCKET', false));

  // Connectivity
  console.log('Probing TARGET connection...');
  checks.push(await checkTargetConnect(process.env.TARGET_DATABASE_URL, process.env.TARGET_SSL_CA_PATH));

  if (process.env.SOURCE_DATABASE_URL || process.env.SOURCE_DATABASE_URL_NODE) {
    console.log('Probing SOURCE connection (libpq URL)...');
    checks.push(await checkSourceConnect(process.env.SOURCE_DATABASE_URL));
  }

  // Render
  console.log('');
  console.log('─── assert-env summary ───');
  for (const c of checks) {
    const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
    console.log(`  ${icon}  ${c.name.padEnd(32)} ${c.detail}`);
  }
  const fails = checks.filter(c => c.status === 'fail').length;
  const warns = checks.filter(c => c.status === 'warn').length;
  console.log('');
  console.log(`ok=${checks.length - fails - warns}  warn=${warns}  fail=${fails}`);

  if (fails > 0) {
    console.log('');
    console.log('❌ Critical failures present. Не запускать cutover до устранения.');
    process.exit(1);
  }
  console.log('✅ Pre-flight env OK. Можно идти по RUNBOOK.md.');
  process.exit(0);
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
