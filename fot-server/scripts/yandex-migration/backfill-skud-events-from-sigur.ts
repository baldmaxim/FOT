// backfill-skud-events-from-sigur.ts
//
// Production backfill `public.skud_events` через Sigur API после Yandex
// cutover. Тонкая CLI-обёртка над `syncEventsLogic` из
// `services/sigur-sync-events.service.ts` — той же логики, которой
// пользуется admin-кнопка «Sync events» в UI.
//
// Запуск:
//   npm run migrate:yandex:backfill-skud-events -- --help
//   npm run migrate:yandex:backfill-skud-events -- --dry-run --from=2026-05-12 --to=2026-05-12
//   npm run migrate:yandex:backfill-skud-events -- --apply  --from=2026-05-01 --to=2026-05-12
//
// ENV (из .migration/yandex.env):
//   DATABASE_URL                 target Yandex Managed PG (НЕ Supabase)
//   DATABASE_SSL / DATABASE_SSL_CA_PATH
//   SIGUR_INTERNAL_URL / SIGUR_INTERNAL_USERNAME / SIGUR_INTERNAL_PASSWORD
//   (или SIGUR_EXTERNAL_*)
//
// Safety: pre-flight проверка, что DATABASE_URL указывает на Yandex
// (хост содержит "yandexcloud" или хотя бы НЕ "supabase"). Без --force
// скрипт откажется работать если хост не похож на Yandex.
//
// Dry-run: не пишет в target. Запрашивает события из Sigur и печатает
// статистику по дням: pass/failures count, distinct dedup_hash.
//
// Apply: вызывает syncEventsLogic за весь диапазон, она пишет в target
// через ON CONFLICT (dedup_hash, event_date) DO NOTHING — повторный запуск
// безопасен.

import { sigurService } from '../../src/services/sigur.service.js';
import { syncEventsLogic } from '../../src/services/sigur-sync-events.service.js';
import { query, queryOne } from '../../src/config/postgres.js';
import { buildInclusiveDateRange } from '../../src/utils/date.utils.js';

const HELP = `backfill-skud-events-from-sigur — production backfill skud_events

Usage:
  npm run migrate:yandex:backfill-skud-events -- [--dry-run|--apply] --from=YYYY-MM-DD --to=YYYY-MM-DD [options]

Options:
  --dry-run         только показать сколько событий было бы импортировано (default)
  --apply           реально импортировать в target
  --from=DATE       начало диапазона (YYYY-MM-DD, включительно)
  --to=DATE         конец диапазона (YYYY-MM-DD, включительно)
  --connection=internal|external   какой Sigur endpoint использовать (default: автовыбор)
  --rate-limit-ms=N задержка между днями в ms (default: 1000)
  --force           обойти проверку «target должен быть Yandex»
  --help, -h        эта справка.

ENV:
  DATABASE_URL                 target Yandex PG (читается через config/postgres.js).
                               НЕ должен указывать на Supabase.
  SIGUR_INTERNAL_URL / SIGUR_INTERNAL_USERNAME / SIGUR_INTERNAL_PASSWORD
  (или SIGUR_EXTERNAL_*)       Sigur API creds.

Что делает (apply):
  Для каждого дня в [from..to]:
    1. sigurService.getEventsWithFailures(start, end) — pass + failures.
    2. syncEventsLogic мапит и INSERT'ит в skud_events + skud_event_failures
       с ON CONFLICT (dedup_hash, event_date) DO NOTHING.
    3. Промежуточный stat по каждому дню; финальный итог.
  После всех дней:
    4. Соберите distinct (employee_id, event_date) и вызовите
       SELECT public.batch_recalculate_skud_daily_summary(...) — это шаг
       НЕ автоматический, оператор делает вручную после verify
       (см. docs/yandex-postgres-migration/09_skud_events_migration.md
       § Verification).

Что делает (dry-run):
  Для каждого дня:
    1. sigurService.getEventsWithFailures(start, end) — без записей.
    2. Печатает: дата, pass-count, failures-count, distinct_pass_hash,
       distinct_failure_hash.

Exit codes:
  0 — все дни обработаны (или dry-run печать ok)
  1 — есть ошибки (см. report)
  2 — fatal: ENV / safety / коннект
`;

interface ICli {
  dryRun: boolean;
  from: string | null;
  to: string | null;
  connection: 'internal' | 'external' | null;
  rateLimitMs: number;
  force: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): ICli {
  const out: ICli = {
    dryRun: true,
    from: null,
    to: null,
    connection: null,
    rateLimitMs: 1000,
    force: false,
    help: false,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply') out.dryRun = false;
    else if (a === '--force') out.force = true;
    else if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a.startsWith('--connection=')) {
      const v = a.slice(13);
      if (v !== 'internal' && v !== 'external') throw new Error(`--connection должен быть internal|external, получено: ${v}`);
      out.connection = v;
    }
    else if (a.startsWith('--rate-limit-ms=')) {
      const n = Number.parseInt(a.slice(16), 10);
      if (Number.isFinite(n) && n >= 0) out.rateLimitMs = n;
    }
    else throw new Error(`Неизвестный аргумент: ${a}`);
  }
  if (!out.help) {
    if (!out.from || !out.to) throw new Error('--from и --to обязательны (YYYY-MM-DD)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from)) throw new Error(`--from неверный: ${out.from}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.to)) throw new Error(`--to неверный: ${out.to}`);
  }
  return out;
}

async function safetyCheckTargetIsYandex(force: boolean): Promise<void> {
  // Запрашиваем у target свой identity. Если DATABASE_URL указывает на
  // Supabase pooler — точно ошибочное использование backfill.
  const r = await queryOne<{ db: string; usr: string; addr: string | null }>(
    `SELECT current_database() AS db,
            current_user AS usr,
            inet_server_addr()::text AS addr`,
  );
  const url = (process.env.DATABASE_URL || '').toLowerCase();
  const looksLikeYandex = url.includes('yandexcloud.net') || url.includes('mdb.yandex');
  const looksLikeSupabase = url.includes('supabase.com') || url.includes('supabase.co') || url.includes('pooler.supabase');

  console.log(`target: db=${r?.db} user=${r?.usr} url-hint=${url.replace(/:[^:@]+@/, ':***@').slice(0, 80)}...`);

  if (looksLikeSupabase && !force) {
    console.error('ABORT: DATABASE_URL похоже на Supabase. Backfill пишет skud_events на TARGET, не на source.');
    console.error('       Если вы намеренно запускаете на Supabase — добавьте --force, но обычно вы этого НЕ хотите.');
    process.exit(2);
  }
  if (!looksLikeYandex && !force) {
    console.error('ABORT: DATABASE_URL не похож на Yandex Managed PG (нет yandexcloud.net).');
    console.error('       Если это корректный target — добавьте --force.');
    process.exit(2);
  }
}

async function dryRunDay(date: string, connection: 'internal' | 'external' | null): Promise<{
  pass: number;
  failures: number;
  distinctPassHashes: number;
  distinctFailureHashes: number;
}> {
  const startTime = `${date}T00:00:00`;
  const endTime = `${date}T23:59:59`;
  const result = await sigurService.getEventsWithFailures(startTime, endTime, connection ?? undefined);
  const passEvents = (result.pass ?? []) as Array<Record<string, unknown>>;
  const failureEvents = (result.failures ?? []) as Array<Record<string, unknown>>;

  // computeDedupHash требует физического имени + даты + времени; в raw
  // событиях имя — `physical_person` field. Мы не имитируем mapping и
  // dedup точно (это делает syncEventsLogic), а оцениваем приблизительно
  // — для dry-run этого достаточно.
  const passIds = new Set<string>();
  for (const e of passEvents) {
    const id = String(e['id'] ?? `${e['eventDate'] ?? ''}|${e['eventTime'] ?? ''}|${e['physical_person'] ?? ''}`);
    passIds.add(id);
  }
  const failIds = new Set<string>();
  for (const e of failureEvents) {
    const id = String(e['id'] ?? `${e['eventDate'] ?? ''}|${e['eventTime'] ?? ''}|${e['physical_person'] ?? ''}`);
    failIds.add(id);
  }
  return {
    pass: passEvents.length,
    failures: failureEvents.length,
    distinctPassHashes: passIds.size,
    distinctFailureHashes: failIds.size,
  };
}

async function main(): Promise<void> {
  let cli: ICli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error('\n' + HELP);
    process.exit(2);
  }
  if (cli.help) {
    console.log(HELP);
    return;
  }

  if (!(await sigurService.isConfigured())) {
    console.error('ERROR: Sigur не настроен (SIGUR_INTERNAL_URL/EXTERNAL_URL + creds)');
    process.exit(2);
  }

  await safetyCheckTargetIsYandex(cli.force);

  const days = buildInclusiveDateRange(cli.from!, cli.to!);
  console.log(`mode: ${cli.dryRun ? 'dry-run' : 'APPLY'}`);
  console.log(`range: ${cli.from} ... ${cli.to} (${days.length} day(s))`);
  console.log(`connection: ${cli.connection ?? 'auto'}`);
  console.log(`rate-limit between days: ${cli.rateLimitMs}ms`);
  console.log('');

  let totalPass = 0;
  let totalFailures = 0;
  let totalImported = 0;
  let totalFailuresImported = 0;
  const errors: string[] = [];

  if (cli.dryRun) {
    for (const day of days) {
      process.stdout.write(`  ${day} ... `);
      try {
        const r = await dryRunDay(day, cli.connection);
        totalPass += r.pass;
        totalFailures += r.failures;
        console.log(`pass=${r.pass} (distinct~${r.distinctPassHashes}) failures=${r.failures} (distinct~${r.distinctFailureHashes})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${day}: ${msg}`);
        console.log(`ERROR: ${msg.slice(0, 160)}`);
      }
      if (cli.rateLimitMs > 0) await new Promise(r => setTimeout(r, cli.rateLimitMs));
    }
    console.log('');
    console.log(`─── dry-run summary ───`);
    console.log(`pass total:     ${totalPass}`);
    console.log(`failures total: ${totalFailures}`);
    console.log(`errors:         ${errors.length}`);
    if (errors.length > 0) {
      for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
      process.exit(1);
    }
    console.log('');
    console.log('Для apply: добавьте --apply (ON CONFLICT DO NOTHING защищает от дублей).');
    process.exit(0);
  }

  // APPLY: вызываем syncEventsLogic за весь диапазон одним заходом — она
  // сама пагинирует по дням и делает INSERT'ы.
  console.log('Calling syncEventsLogic for the whole range (it iterates internally over days)...');
  const result = await syncEventsLogic(
    cli.from!,
    cli.to!,
    cli.connection ?? undefined,
    (event) => {
      // Прогресс-событий очень много — фильтруем только day-summary
      if (event['type'] === 'events_day_done' || event['type'] === 'day_imported') {
        const d = event['date'] ?? event['day'] ?? '?';
        const im = event['imported'] ?? event['matched'] ?? '?';
        console.log(`  ${d}: imported=${im}`);
      }
    },
  );

  totalPass = result.matched ?? 0;
  totalImported = result.imported ?? 0;
  totalFailures = result.failuresFetched ?? 0;
  totalFailuresImported = result.failuresImported ?? 0;
  errors.push(...result.errors);

  console.log('');
  console.log(`─── apply summary ───`);
  console.log(`sigur total events:  ${result.sigurTotal}`);
  console.log(`matched (mapped):    ${totalPass}`);
  console.log(`imported (inserted): ${totalImported}`);
  console.log(`skipped (dup/conflict): ${result.skipped}`);
  console.log(`failures fetched:    ${totalFailures}`);
  console.log(`failures imported:   ${totalFailuresImported}`);
  console.log(`errors:              ${errors.length}`);
  if (errors.length > 0) {
    for (const e of errors.slice(0, 5)) console.log(`  - ${e}`);
  }

  // Подсказка по recalculate
  console.log('');
  console.log('NEXT (вручную, читать 09_skud_events_migration.md § Verification):');
  console.log('  1. SELECT count(*) per event_date — компарировать ожиданиям.');
  console.log('  2. SELECT public.batch_recalculate_skud_daily_summary(...) для (employee_id, event_date) пар.');
  console.log('  3. Sample check 3-5 случайных дат × сотрудников.');

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('FATAL:', err instanceof Error ? err.stack : err);
  process.exit(2);
});
