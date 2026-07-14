import crypto from 'crypto';
import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import {
  msisdnHash,
  normalizeMsisdn,
  parseCallDate,
  type IStatementUsageRow,
  type MtsExpenseCategory,
} from './mts-business-cdr.service.js';

// Полные строки выписки (Bills/BillingStatementExtdByMSISDN) — ВСЕ категории
// (звонки/СМС/интернет/прочее), а не только голос как mts_business_cdr.
// Пишутся ночным «Обновить всё» (шаг detalization → syncMsisdnStatement),
// читаются вкладкой «Использование» админки и ЛК сотрудника «Моя SIM» —
// потребители МТС живьём не дергают (таблица — миграция 217).
// ПДн (номер собеседника) — шифром peer_enc; числа/даты/категории plain,
// по ним SQL-агрегируется дневная статистика.

export type StatementRowsSource = 'nightly' | 'manual' | 'backfill' | 'rolling';

/**
 * Потолок строк детализации в ответе (список событий). Сводки (getUsageTotals,
 * getDailyStats) считаются в SQL по всем строкам — cap на них не влияет.
 */
export const USAGE_ROWS_LIMIT = 3000;

export interface IStoredUsageRow extends IStatementUsageRow {
  peerHash: string | null;
}

export interface IUsageDayStat {
  date: string; // YYYY-MM-DD
  events: number;
  calls: number;
  callsSeconds: number;
  smsCount: number;
  internetBytes: number;
  amount: number; // ₽ за день (topups исключены ещё при парсинге выписки)
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

/**
 * Дедуп-ключи строк выписки. База — все значимые поля строки; occurrence —
 * порядковый номер идентичного кортежа внутри батча: две легитимно одинаковые
 * строки (две СМС в одну секунду одному адресату) не схлопываются, а повторный
 * re-fetch того же окна остаётся идемпотентным — нумерация 1..k стабильна,
 * множество строк за прошедшие дни у МТС только растёт.
 */
export const buildStatementDedupKeys = (msisdnHashValue: string, rows: IStatementUsageRow[]): string[] => {
  const seen = new Map<string, number>();
  return rows.map(r => {
    const base = [
      msisdnHashValue,
      r.date ?? '',
      r.networkEvent ?? '',
      r.direction ?? '',
      normalizeMsisdn(r.peer) ?? r.peer ?? '',
      r.units ?? '',
      r.unitCode ?? '',
      r.amount.toFixed(2),
      r.label ?? '',
    ].join('|');
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return sha256(`${base}|${occurrence}`);
  });
};

/** Хэш собеседника — только для валидных телефонов (резолв имён коллег по базе). */
export const statementPeerHash = (peer: string | null): string | null => {
  const norm = normalizeMsisdn(peer);
  return norm && /^7\d{10}$/.test(norm) ? sha256(norm) : null;
};

export interface IUsagePeriod {
  dateFrom: string;
  dateTo: string;
  period: string; // YYYY-MM либо YYYY-MM-DD — эхо в ответ
}

/** Группа сводки использования: те же 4 группы, что и на фронте (usageSummary.ts). */
export type UsageGroupKey = 'calls' | 'internet' | 'sms' | 'other';

export interface IUsageGroupTotal {
  key: UsageGroupKey;
  count: number;
  seconds: number;
  bytes: number;
  amount: number;
  /** Разбивка по направлению — только для звонков. */
  inCount: number;
  inSeconds: number;
  outCount: number;
  outSeconds: number;
}

export interface IUsageTotals {
  groups: IUsageGroupTotal[];
  /** Итог расходов за период (₽) — сумма всех групп. */
  total: number;
}

/**
 * Категории строк выписки (`category`) → 4 группы сводки. Держать в одном
 * порядке с USAGE_GROUP_OF на фронте (fot-app/src/pages/mts-business/usageSummary.ts).
 * Параметр — имя колонки: в запросах с JOIN нужен префикс таблицы.
 */
export const groupOfCategorySql = (column = 'category'): string => `
  CASE ${column}
    WHEN 'calls' THEN 'calls'
    WHEN 'internet' THEN 'internet'
    WHEN 'sms' THEN 'sms'
    ELSE 'other'
  END`;

const GROUP_OF_CATEGORY_SQL = groupOfCategorySql();

/** Порядок групп в ответе — фронт рендерит как пришло, пустые не скрывает сам. */
export const USAGE_GROUP_ORDER: UsageGroupKey[] = ['calls', 'internet', 'sms', 'other'];

const emptyGroup = (key: UsageGroupKey): IUsageGroupTotal => ({
  key, count: 0, seconds: 0, bytes: 0, amount: 0, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0,
});

/** Период выписки из query-параметров: ?date=YYYY-MM-DD (день) или ?month=YYYY-MM. */
export const parseUsagePeriod = (month: string, date: string): IUsagePeriod | null => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { dateFrom: date, dateTo: date, period: date };
  }
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return null;
  const lastDay = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { dateFrom: `${month}-01`, dateTo: `${month}-${String(lastDay).padStart(2, '0')}`, period: month };
};

class MtsBusinessStatementRowsService {
  /** Персист строк выписки батчами с дедупом по dedup_hash (паттерн storeCalls). */
  async storeRows(
    accountId: string | null,
    msisdn: string,
    rows: IStatementUsageRow[],
    source: StatementRowsSource,
  ): Promise<{ inserted: number; skipped: number; noDate: number }> {
    const mHash = msisdnHash(msisdn);
    if (!mHash || rows.length === 0) return { inserted: 0, skipped: 0, noDate: 0 };
    const keys = buildStatementDedupKeys(mHash, rows);

    let inserted = 0;
    let stored = 0;
    let noDate = 0;
    const CHUNK = 400;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: string[] = [];
      const params: unknown[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const r = chunk[j];
        // Дата обязательна (агрегаты по дням); по живым probe она есть всегда.
        const usageDate = r.date && /^\d{4}-\d{2}-\d{2}/.test(r.date) ? r.date.slice(0, 10) : null;
        if (!usageDate) {
          noDate++;
          continue;
        }
        params.push(
          keys[i + j],
          accountId,
          mHash,
          usageDate,
          parseCallDate(r.date),
          r.category,
          r.networkEvent,
          r.direction,
          r.label,
          statementPeerHash(r.peer),
          encryptionService.encryptField(r.peer),
          r.units,
          r.unitCode,
          r.amount,
          source,
        );
        const b = params.length;
        values.push(
          `($${b - 14}, $${b - 13}, $${b - 12}, $${b - 11}, $${b - 10}, $${b - 9}, $${b - 8}, $${b - 7}, $${b - 6}, $${b - 5}, $${b - 4}, $${b - 3}, $${b - 2}, $${b - 1}, $${b})`,
        );
      }
      if (values.length === 0) continue;
      stored += values.length;
      inserted += await execute(
        `INSERT INTO mts_business_statement_rows
           (dedup_hash, account_id, msisdn_hash, usage_date, event_at, category, network_event,
            direction, label, peer_hash, peer_enc, units, unit_code, amount, source)
         VALUES ${values.join(', ')}
         ON CONFLICT (dedup_hash) DO NOTHING`,
        params,
      );
    }
    if (noDate > 0) console.warn(`[mts-biz-stmt-rows] строк без даты пропущено: ${noDate}`);
    return { inserted, skipped: stored - inserted, noDate };
  }

  /** Строки за период [dateFrom..dateTo] (usage_date, включительно), свежие сверху. */
  async getUsageRows(
    msisdnHashValue: string,
    dateFrom: string,
    dateTo: string,
    limit = USAGE_ROWS_LIMIT,
  ): Promise<IStoredUsageRow[]> {
    const rows = await query<{
      usage_date: string;
      event_at: string | Date | null;
      category: string;
      network_event: string | null;
      direction: string | null;
      label: string | null;
      peer_hash: string | null;
      peer_enc: string | null;
      units: string | null;
      unit_code: string | null;
      amount: string;
    }>(
      `SELECT usage_date::text AS usage_date, event_at, category, network_event, direction,
              label, peer_hash, peer_enc, units::text AS units, unit_code, amount::text AS amount
         FROM mts_business_statement_rows
        WHERE msisdn_hash = $1 AND usage_date BETWEEN $2 AND $3
        ORDER BY event_at DESC NULLS LAST, id DESC
        LIMIT $4`,
      [msisdnHashValue, dateFrom, dateTo, limit],
    );
    return rows.map(r => ({
      date: r.event_at != null ? new Date(r.event_at).toISOString() : r.usage_date,
      category: r.category as MtsExpenseCategory,
      label: r.label,
      networkEvent: r.network_event,
      direction: r.direction === 'in' || r.direction === 'out' ? r.direction : null,
      peer: encryptionService.decryptField(r.peer_enc),
      units: r.units != null ? Number(r.units) : null,
      unitCode: r.unit_code,
      amount: r.amount != null ? Number(r.amount) : 0,
      peerHash: r.peer_hash,
    }));
  }

  /**
   * ЕДИНЫЙ источник сводки использования за период: SQL-агрегат по группам
   * (звонки/интернет/СМС/прочее). Считается по ВСЕМ строкам периода, без cap'а
   * getUsageRows — поэтому «Статистика» в панели абонента, плитки «Использования»
   * и ЛК «Моя SIM» показывают одни и те же числа. Единицы сырые: секунды (звонки),
   * байты (интернет), штуки (СМС), рубли (amount).
   */
  async getUsageTotals(msisdnHashValue: string, dateFrom: string, dateTo: string): Promise<IUsageTotals> {
    const rows = await query<{
      grp: string;
      count: string;
      seconds: string;
      bytes: string;
      amount: string;
      in_count: string;
      in_seconds: string;
      out_count: string;
      out_seconds: string;
    }>(
      `SELECT ${GROUP_OF_CATEGORY_SQL} AS grp,
              COUNT(*)::text AS count,
              COALESCE(SUM(units) FILTER (WHERE unit_code = 'SECOND'), 0)::text AS seconds,
              COALESCE(SUM(units) FILTER (WHERE unit_code = 'BYTE'), 0)::text   AS bytes,
              COALESCE(SUM(amount), 0)::text AS amount,
              COUNT(*) FILTER (WHERE direction = 'in')::text  AS in_count,
              COALESCE(SUM(units) FILTER (WHERE direction = 'in'  AND unit_code = 'SECOND'), 0)::text AS in_seconds,
              COUNT(*) FILTER (WHERE direction = 'out')::text AS out_count,
              COALESCE(SUM(units) FILTER (WHERE direction = 'out' AND unit_code = 'SECOND'), 0)::text AS out_seconds
         FROM mts_business_statement_rows
        WHERE msisdn_hash = $1 AND usage_date BETWEEN $2 AND $3
        GROUP BY 1`,
      [msisdnHashValue, dateFrom, dateTo],
    );

    const byKey = new Map<UsageGroupKey, IUsageGroupTotal>();
    for (const r of rows) {
      const key = r.grp as UsageGroupKey;
      byKey.set(key, {
        key,
        count: Number(r.count),
        seconds: Number(r.seconds),
        bytes: Number(r.bytes),
        amount: Number(r.amount),
        inCount: Number(r.in_count),
        inSeconds: Number(r.in_seconds),
        outCount: Number(r.out_count),
        outSeconds: Number(r.out_seconds),
      });
    }
    const groups: IUsageGroupTotal[] = USAGE_GROUP_ORDER.map(k => byKey.get(k) ?? emptyGroup(k));
    return { groups, total: groups.reduce((sum, g) => sum + g.amount, 0) };
  }

  /**
   * Итоги по КАТЕГОРИЯМ выписки (calls/sms/internet/periodic/oneTime/other) —
   * SQL-агрегат по всем строкам периода. Источник сводки расходов карточки
   * (getExpenses): та же таблица, что у «Использования», без живых вызовов МТС.
   */
  async getCategoryTotals(
    msisdnHashValue: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<Map<MtsExpenseCategory, { count: number; amount: number }>> {
    const rows = await query<{ category: string; count: string; amount: string }>(
      `SELECT category, COUNT(*)::text AS count, COALESCE(SUM(amount), 0)::text AS amount
         FROM mts_business_statement_rows
        WHERE msisdn_hash = $1 AND usage_date BETWEEN $2 AND $3
        GROUP BY category`,
      [msisdnHashValue, dateFrom, dateTo],
    );
    return new Map(rows.map(r => [
      r.category as MtsExpenseCategory,
      { count: Number(r.count), amount: Number(r.amount) },
    ]));
  }

  /** Дневная статистика за период — SQL-агрегат (отдельной таблицы агрегатов нет). */
  async getDailyStats(msisdnHashValue: string, dateFrom: string, dateTo: string): Promise<IUsageDayStat[]> {
    const rows = await query<{
      date: string;
      events: string;
      calls: string;
      calls_seconds: string;
      sms_count: string;
      internet_bytes: string;
      amount: string;
    }>(
      `SELECT usage_date::text AS date,
              COUNT(*)::text AS events,
              COUNT(*) FILTER (WHERE category = 'calls')::text AS calls,
              COALESCE(SUM(units) FILTER (WHERE category = 'calls' AND unit_code = 'SECOND'), 0)::text AS calls_seconds,
              COUNT(*) FILTER (WHERE category = 'sms')::text AS sms_count,
              COALESCE(SUM(units) FILTER (WHERE category = 'internet' AND unit_code = 'BYTE'), 0)::text AS internet_bytes,
              COALESCE(SUM(amount), 0)::text AS amount
         FROM mts_business_statement_rows
        WHERE msisdn_hash = $1 AND usage_date BETWEEN $2 AND $3
        GROUP BY usage_date
        ORDER BY usage_date`,
      [msisdnHashValue, dateFrom, dateTo],
    );
    return rows.map(r => ({
      date: r.date,
      events: Number(r.events),
      calls: Number(r.calls),
      callsSeconds: Number(r.calls_seconds),
      smsCount: Number(r.sms_count),
      internetBytes: Number(r.internet_bytes),
      amount: Number(r.amount),
    }));
  }

  /** Месяцы, за которые есть строки (селектор месяцев в ЛК), свежие сверху. */
  async getMonthsWithData(msisdnHashValue: string): Promise<string[]> {
    const rows = await query<{ month: string }>(
      `SELECT DISTINCT to_char(usage_date, 'YYYY-MM') AS month
         FROM mts_business_statement_rows
        WHERE msisdn_hash = $1
        ORDER BY month DESC`,
      [msisdnHashValue],
    );
    return rows.map(r => r.month);
  }
}

export const mtsBusinessStatementRowsService = new MtsBusinessStatementRowsService();
