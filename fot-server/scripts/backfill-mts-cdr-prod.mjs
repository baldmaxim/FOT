/**
 * Одноразовый бэкафилл CDR на проде через УЖЕ задеплоенный dist (без statement-sync).
 * Загрузить на сервер и: node backfill-mts-cdr-prod.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/srv/sites/fot.su10.ru/fot-server/.env' });

const DIST = '/srv/sites/fot.su10.ru/fot-server/dist/services';
const dateFrom = process.env.MTS_BF_FROM || '2026-06-01';
const dateTo = process.env.MTS_BF_TO || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
const POOL = 3;

const { mtsBusinessAccountsService } = await import(`${DIST}/mts-business-accounts.service.js`);
const { mtsBusinessMappingService } = await import(`${DIST}/mts-business-mapping.service.js`);
const { mtsBusinessDataService } = await import(`${DIST}/mts-business-data.service.js`);
const { mtsBusinessCdrService } = await import(`${DIST}/mts-business-cdr.service.js`);
const { queryOne } = await import('/srv/sites/fot.su10.ru/fot-server/dist/config/postgres.js');

const runPool = async (items, limit, worker) => {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  }));
};

const countCdr = async () => {
  const r = await queryOne('SELECT count(*)::text AS c FROM mts_business_cdr');
  return Number(r?.c ?? 0);
};

const before = await countCdr();
console.log(`CDR backfill ${dateFrom}..${dateTo}, before=${before}`);

const accounts = (await mtsBusinessAccountsService.list()).filter(a => a.isActive);
for (const account of accounts) {
  const msisdns = await mtsBusinessMappingService.getAllKnownMsisdnsByAccount(account.id);
  console.log(`[${account.label}] numbers=${msisdns.length}`);
  const allCalls = [];
  let failed = 0;
  await runPool(msisdns, POOL, async msisdn => {
    try {
      const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(account.id, { msisdn, dateFrom, dateTo });
      allCalls.push(...mtsBusinessCdrService.parseBillingStatementResponse(resp, msisdn));
    } catch {
      failed++;
    }
  });
  const { inserted } = allCalls.length > 0
    ? await mtsBusinessCdrService.storeCalls(allCalls, null, account.id)
    : { inserted: 0 };
  console.log(`[${account.label}] parsed=${allCalls.length} inserted=${inserted} failed=${failed}`);
}

const after = await countCdr();
console.log(`CDR after=${after} (+${after - before})`);
