/**
 * Бэкфилл CDR и начислений МТС Бизнес из Bills/BillingStatementExtdByMSISDN.
 *
 * Заполняет mts_business_cdr и metric_daily.charges_amount (fallback без CheckCharges).
 *
 * По умолчанию — DRY-RUN (только подсчёт номеров/окна). Запись — --apply.
 * --cleanup-metrics — удалить ложные balance по номерам (scope=msisdn).
 *
 * Запуск на проде:
 *   cd /opt/fot-build/fot-server && npx tsx scripts/backfill-mts-cdr.ts --from=2026-06-01 --to=2026-07-06
 *   cd /opt/fot-build/fot-server && npx tsx scripts/backfill-mts-cdr.ts --from=2026-06-01 --to=2026-07-06 --apply
 *   cd /opt/fot-build/fot-server && npx tsx scripts/backfill-mts-cdr.ts --cleanup-metrics --apply
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[env] загружен ${envPath}`);
} else {
  console.warn('[env] .env не найден');
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const CLEANUP = args.includes('--cleanup-metrics');
const fromArg = args.find(a => a.startsWith('--from='))?.slice(7);
const toArg = args.find(a => a.startsWith('--to='))?.slice(5);
const accountArg = args.find(a => a.startsWith('--account='))?.slice(10);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const main = async (): Promise<void> => {
  const { query, execute } = await import('../src/config/postgres.js');
  const { mtsBusinessAccountsService } = await import('../src/services/mts-business-accounts.service.js');
  const { mtsBusinessMappingService } = await import('../src/services/mts-business-mapping.service.js');
  const {
    countCdrByAccount,
    countCdrTotal,
    syncMsisdnStatement,
    verifyCdrStore,
  } = await import('../src/services/mts-business-statement-sync.service.js');
  const { runPool } = await import('../src/services/mts-business-subscriber-sync.service.js');

  console.log(`Бэкфилл CDR МТС Бизнес — ${APPLY ? 'APPLY' : 'DRY-RUN'}${CLEANUP ? ' + cleanup' : ''}`);

  if (CLEANUP) {
    const [{ n }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM mts_business_metric_daily WHERE scope = 'msisdn' AND metric = 'balance'`,
    );
    console.log(`[cleanup] ложных balance (msisdn): ${n}`);
    if (APPLY && n > 0) {
      const deleted = await execute(
        `DELETE FROM mts_business_metric_daily WHERE scope = 'msisdn' AND metric = 'balance'`,
      );
      console.log(`[cleanup] удалено строк: ${deleted}`);
    }
  }

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
  const dateTo = toArg && DATE_RE.test(toArg) ? toArg : today;
  const dateFrom = fromArg && DATE_RE.test(fromArg)
    ? fromArg
    : (() => {
        const d = new Date(`${dateTo}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - 30);
        return d.toISOString().slice(0, 10);
      })();

  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    console.error('Некорректные даты. Используйте --from=YYYY-MM-DD --to=YYYY-MM-DD');
    process.exit(1);
  }

  const accounts = (await mtsBusinessAccountsService.list()).filter(a => a.isActive && (!accountArg || a.id === accountArg));
  if (accounts.length === 0) {
    console.error('Нет активных аккаунтов');
    process.exit(1);
  }

  const cdrBefore = await countCdrTotal();
  console.log(`Период: ${dateFrom}..${dateTo}, ЛС: ${accounts.length}, CDR до: ${cdrBefore}`);

  for (const account of accounts) {
    const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(account.id);
    console.log(`[${account.label}] номеров: ${msisdns.length}`);
    if (!APPLY || msisdns.length === 0) continue;

    const dbBefore = await countCdrByAccount(account.id);
    let inserted = 0;
    let failed = 0;
    let charges = 0;

    await runPool(msisdns, 3, async msisdn => {
      try {
        const res = await syncMsisdnStatement(account.id, msisdn, dateFrom, dateTo);
        inserted += res.callsInserted;
        if (res.chargesAmount != null) charges++;
      } catch {
        failed++;
      }
    });

    await verifyCdrStore(account.id, inserted, dbBefore);
    const dbAfter = await countCdrByAccount(account.id);
    console.log(`[${account.label}] inserted=${inserted} charges=${charges} failed=${failed} cdr=${dbBefore}->${dbAfter}`);
  }

  const cdrAfter = await countCdrTotal();
  console.log(`CDR после: ${cdrAfter} (+${cdrAfter - cdrBefore})`);
};

main().catch(err => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
