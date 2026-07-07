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
  chargesAmount: number;
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
 * Загрузить выписку по номеру: звонки → mts_business_cdr, расходы →
 * metric_daily.charges_amount ПО ДНЯМ (captured_date = день расхода). Это
 * ПЕРВИЧНЫЙ (и единственный) источник начислений на номер:
 * CheckCharges.remainedAmount — остаток по ЛС, а не начисление номера.
 *
 * Окно запроса расширяется до min(dateFrom, 1-е число месяца dateTo) — так
 * ежедневный прогон (dateTo = вчера) каждый день переписывает весь текущий
 * месяц, и сумма «за период» по умолчанию (с 1-го числа) всегда свежая.
 * Старые строки окна удаляются; дни без расходов остаются без строк (= 0).
 */
export async function syncMsisdnStatement(
  accountId: string,
  msisdn: string,
  dateFrom: string,
  dateTo: string,
  sourceMessageId: string | null = null,
): Promise<ISyncMsisdnStatementResult> {
  const monthStart = `${dateTo.slice(0, 7)}-01`;
  const chargesFrom = dateFrom < monthStart ? dateFrom : monthStart;
  const resp = await mtsBusinessDataService.getBillingStatementExtdByMsisdn(accountId, { msisdn, dateFrom: chargesFrom, dateTo });
  const calls = mtsBusinessCdrService.parseBillingStatementResponse(resp, msisdn);
  let callsInserted = 0;
  if (calls.length > 0) {
    const stored = await mtsBusinessCdrService.storeCalls(calls, sourceMessageId, accountId);
    callsInserted = stored.inserted;
  }
  const perDay = mtsBusinessCdrService.sumStatementChargesByDay(resp, chargesFrom, dateTo);
  await mtsBusinessMetricsStoreService.replaceMsisdnDailyCharges(accountId, msisdn, chargesFrom, dateTo, perDay);
  const chargesAmount = [...perDay.values()].reduce((sum, v) => sum + v, 0);
  return {
    callsParsed: calls.length,
    callsInserted,
    chargesAmount,
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
