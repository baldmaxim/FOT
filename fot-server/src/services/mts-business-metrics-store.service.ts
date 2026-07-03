import { execute, query } from '../config/postgres.js';
import { msisdnHash } from './mts-business-cdr.service.js';

// Персист и чтение скалярных дневных метрик МТС «Бизнес» (mts_business_metric_daily).
// Один ряд/сутки/метрику/цель (идемпотентный upsert) — вызывается и из
// ежедневного планировщика, и из контроллера при открытии вкладки «Финансы»
// (on-demand snapshot), поэтому вынесен в отдельный сервис от billing.service.ts
// (тот делает только HTTP-вызовы к МТС, этот — только БД).

export type MtsBusinessDailyMetric = 'balance' | 'credit_limit' | 'unpaid_amount' | 'charges_amount';

export interface IMetricDailyUpsert {
  accountId: string;
  scope: 'account' | 'msisdn';
  accountNo?: string | null;
  msisdn?: string | null; // сырой номер — хэшируется внутри, не хранится здесь
  metric: MtsBusinessDailyMetric;
  amount: number;
  currencyCode?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface IAccountMetricsSummaryRow {
  accountId: string;
  label: string;
  accountNumber: string | null;
  balance: number | null;
  creditLimit: number | null;
  unpaidAmount: number | null;
  capturedAt: string | null;
}

export interface IEmployeeMetricsSummaryRow {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  balance: number | null;
  chargesAmount: number | null;
  capturedAt: string | null;
}

export interface IMetricTrendPoint {
  date: string;
  amount: number;
}

class MtsBusinessMetricsStoreService {
  async upsertDaily(input: IMetricDailyUpsert): Promise<void> {
    if (!Number.isFinite(input.amount)) return;
    const hash = input.msisdn ? msisdnHash(input.msisdn) : null;
    await execute(
      `INSERT INTO mts_business_metric_daily
         (account_id, scope, account_no, msisdn_hash, metric, amount, currency_code, valid_from, valid_to, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, (captured_at::date))
       DO UPDATE SET amount = EXCLUDED.amount, currency_code = EXCLUDED.currency_code,
         valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, captured_at = NOW()`,
      [
        input.accountId,
        input.scope,
        input.accountNo ?? null,
        hash,
        input.metric,
        input.amount,
        input.currencyCode ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
      ],
    );
  }

  /** Последний известный срез по каждому активному ЛС (баланс/кредитный лимит/неоплаченные). */
  async getAccountsSummary(): Promise<IAccountMetricsSummaryRow[]> {
    const rows = await query<{
      account_id: string;
      label: string;
      account_number: string | null;
      balance: string | null;
      credit_limit: string | null;
      unpaid_amount: string | null;
      captured_at: string | null;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (account_id, metric) account_id, metric, amount, captured_at
           FROM mts_business_metric_daily
          WHERE scope = 'account' AND account_id IS NOT NULL
          ORDER BY account_id, metric, captured_at DESC
       )
       SELECT a.id AS account_id, a.label, a.account_number,
              MAX(l.amount) FILTER (WHERE l.metric = 'balance')::text AS balance,
              MAX(l.amount) FILTER (WHERE l.metric = 'credit_limit')::text AS credit_limit,
              MAX(l.amount) FILTER (WHERE l.metric = 'unpaid_amount')::text AS unpaid_amount,
              MAX(l.captured_at) AS captured_at
         FROM mts_business_accounts a
         LEFT JOIN latest l ON l.account_id = a.id
        WHERE a.is_active
        GROUP BY a.id, a.label, a.account_number
        ORDER BY a.label`,
    );
    return rows.map(r => ({
      accountId: r.account_id,
      label: r.label,
      accountNumber: r.account_number,
      balance: r.balance != null ? Number(r.balance) : null,
      creditLimit: r.credit_limit != null ? Number(r.credit_limit) : null,
      unpaidAmount: r.unpaid_amount != null ? Number(r.unpaid_amount) : null,
      capturedAt: r.captured_at,
    }));
  }

  /** Последний известный срез по каждому привязанному к сотруднику номеру (баланс/начисления). */
  async getEmployeesSummary(accountId?: string | null): Promise<IEmployeeMetricsSummaryRow[]> {
    const rows = await query<{
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      balance: string | null;
      charges_amount: string | null;
      captured_at: string | null;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (msisdn_hash, metric) msisdn_hash, metric, amount, captured_at
           FROM mts_business_metric_daily
          WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
            AND ($1::uuid IS NULL OR account_id = $1::uuid)
          ORDER BY msisdn_hash, metric, captured_at DESC
       )
       SELECT nm.employee_id, e.full_name, e.tab_number,
              MAX(l.amount) FILTER (WHERE l.metric = 'balance')::text AS balance,
              MAX(l.amount) FILTER (WHERE l.metric = 'charges_amount')::text AS charges_amount,
              MAX(l.captured_at) AS captured_at
         FROM mts_business_number_map nm
         JOIN latest l ON l.msisdn_hash = nm.msisdn_hash
         LEFT JOIN employees e ON e.id = nm.employee_id
        GROUP BY nm.employee_id, e.full_name, e.tab_number
        ORDER BY e.full_name NULLS LAST`,
      [accountId ?? null],
    );
    return rows.map(r => ({
      employeeId: r.employee_id,
      employeeFullName: r.full_name,
      employeeTabNumber: r.tab_number,
      balance: r.balance != null ? Number(r.balance) : null,
      chargesAmount: r.charges_amount != null ? Number(r.charges_amount) : null,
      capturedAt: r.captured_at,
    }));
  }

  /** Тренд метрики по дням: по конкретному ЛС (accountId) или сумма по всем активным ЛС. */
  async getAccountMetricTrend(
    metric: MtsBusinessDailyMetric,
    accountId: string | null,
    from: string,
    to: string,
  ): Promise<IMetricTrendPoint[]> {
    const rows = await query<{ date: string; amount: string }>(
      `SELECT (captured_at::date)::text AS date, SUM(amount)::text AS amount
         FROM mts_business_metric_daily
        WHERE scope = 'account' AND metric = $1
          AND captured_at::date >= $2::date AND captured_at::date <= $3::date
          AND ($4::uuid IS NULL OR account_id = $4::uuid)
        GROUP BY captured_at::date
        ORDER BY captured_at::date`,
      [metric, from, to, accountId ?? null],
    );
    return rows.map(r => ({ date: r.date, amount: Number(r.amount) }));
  }
}

export const mtsBusinessMetricsStoreService = new MtsBusinessMetricsStoreService();
