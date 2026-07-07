import * as Sentry from '@sentry/node';
import { queryOne } from '../config/postgres.js';
import { mtsBusinessDataService } from './mts-business-data.service.js';
import { mtsBusinessCdrService } from './mts-business-cdr.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';

// Синхронная выписка Bills/BillingStatementExtdByMSISDN → CDR + начисления.
// Единая точка для cdr-daily, refresh-all и backfill-скрипта.

export interface ISyncMsisdnStatementResult {
  callsParsed: number;
  callsInserted: number;
  chargesAmount: number | null;
}

/** Количество строк CDR по лицевому счёту (для верификации после storeCalls). */
export async function countCdrByAccount(accountId: string): Promise<number> {
  const row = await queryOne<{ c: string }>(
    'SELECT count(*)::text AS c FROM mts_business_cdr WHERE account_id = $1',
    [accountId],
  );
  return Number(row?.c ?? 0);
}

/** Глобальное количество строк CDR (для catchup-окна планировщика). */
export async function countCdrTotal(): Promise<number> {
  const row = await queryOne<{ c: string }>('SELECT count(*)::text AS c FROM mts_business_cdr');
  return Number(row?.c ?? 0);
}

/**
 * Загрузить выписку по номеру: звонки → mts_business_cdr, сумма расходов →
 * metric_daily.charges_amount. Это ПЕРВИЧНЫЙ (и единственный) источник начислений
 * на номер: CheckCharges.remainedAmount — остаток по ЛС, а не начисление номера.
 */
export async function syncMsisdnStatement(
  accountId: string,
  msisdn: string,
  dateFrom: string,
  dateTo: string,
  sourceMessageId: string | null = null,
): Promise<ISyncMsisdnStatementResult> {
  const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(accountId, { msisdn, dateFrom, dateTo });
  const calls = mtsBusinessCdrService.parseBillingStatementResponse(resp, msisdn);
  let callsInserted = 0;
  if (calls.length > 0) {
    const stored = await mtsBusinessCdrService.storeCalls(calls, sourceMessageId, accountId);
    callsInserted = stored.inserted;
  }
  const chargesAmount = mtsBusinessCdrService.sumStatementCharges(resp);
  if (chargesAmount > 0) {
    await mtsBusinessMetricsStoreService.upsertDaily({
      accountId,
      scope: 'msisdn',
      msisdn,
      metric: 'charges_amount',
      amount: chargesAmount,
      validFrom: dateFrom,
      validTo: dateTo,
    });
  }
  return {
    callsParsed: calls.length,
    callsInserted,
    chargesAmount: chargesAmount > 0 ? chargesAmount : null,
  };
}

/** Если storeCalls сообщил о вставках, но счётчик в БД не вырос — алерт. */
export async function verifyCdrStore(
  accountId: string,
  reportedInserted: number,
  dbTotalBefore: number,
): Promise<void> {
  if (reportedInserted <= 0) return;
  const dbTotalAfter = await countCdrByAccount(accountId);
  if (dbTotalAfter <= dbTotalBefore) {
    const msg = `[mts-biz-cdr] storeCalls reported inserted=${reportedInserted} but db count ${dbTotalBefore}->${dbTotalAfter} account=${accountId}`;
    console.error(msg);
    Sentry.captureMessage(msg, { level: 'error', tags: { module: 'mts-business-cdr' } });
  }
}
