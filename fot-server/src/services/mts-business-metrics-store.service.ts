import { execute, query, queryOne, withTransaction } from '../config/postgres.js';
import { msisdnHash } from './mts-business-cdr.service.js';
import { extractTariffNameFromServices } from './mts-business-catalog.service.js';

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

export type MtsBusinessSnapshotMetric =
  | 'validity_info'
  | 'bill_plan'
  | 'product_services'
  | 'hierarchy'
  | 'budget_rules'
  // Полный профиль абонента (вкладка «Абоненты», scope='msisdn'):
  | 'connected_blocks'  // подключённые блокировки (IMtsService[])
  | 'tariff_fee'        // абонплата по тарифу (IMtsTariffFee)
  | 'forwarding'        // правила переадресации (IMtsForwardingRule[])
  | 'roaming'           // текущая локация SIM (IMtsRoaming)
  | 'delivery_method'   // способ доставки счетов (IMtsDeliveryMethod[])
  | 'payments'          // пополнения за 30 дней (IMtsPaymentEntry[])
  | 'validity_msisdn';  // остатки пакетов по номеру (IMtsPackageCounter[])

export interface ISnapshotUpsert {
  accountId: string;
  scope: 'account' | 'msisdn';
  accountNo?: string | null;
  msisdn?: string | null; // сырой номер — хэшируется внутри, не хранится здесь
  metric: MtsBusinessSnapshotMetric;
  payload: unknown;
}

export interface IEmployeeCatalogRow {
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  tariffName: string | null;
  servicesCount: number;
  servicesMonthlyTotal: number;
  capturedAt: string | null;
}

export interface IAccountPackagesRow {
  accountId: string;
  label: string;
  accountNumber: string | null;
  packages: { unitOfMeasure: string | null; quota: number | null; remainder: number | null }[];
  capturedAt: string | null;
}

class MtsBusinessMetricsStoreService {
  async upsertDaily(input: IMetricDailyUpsert): Promise<void> {
    if (!Number.isFinite(input.amount)) return;
    const hash = input.msisdn ? msisdnHash(input.msisdn) : null;
    await execute(
      `INSERT INTO mts_business_metric_daily
         (account_id, scope, account_no, msisdn_hash, metric, amount, currency_code, valid_from, valid_to, captured_date, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, NOW())
       ON CONFLICT (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, captured_date)
       DO UPDATE SET amount = EXCLUDED.amount, currency_code = EXCLUDED.currency_code,
         valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to, captured_date = CURRENT_DATE, captured_at = NOW()`,
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

  /**
   * По-дневные начисления номера за окно [fromYmd..toYmd]: старые строки окна
   * удаляются, дни с расходами вставляются заново. captured_date = ДЕНЬ РАСХОДА
   * из выписки (не день снятия) — сумма за произвольный период считается как
   * SUM(amount) по captured_date. Дни без расходов строк не имеют (= 0).
   */
  async replaceMsisdnDailyCharges(
    accountId: string,
    rawMsisdn: string,
    fromYmd: string,
    toYmd: string,
    perDay: Map<string, number>,
  ): Promise<void> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return;
    // Дни за пределами окна прижимаются к границе (иначе потеряем сумму при
    // расхождении дат выписки с запрошенным окном), затем ре-агрегация.
    const normalized = new Map<string, number>();
    for (const [day, amount] of perDay) {
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const clamped = day < fromYmd ? fromYmd : day > toYmd ? toYmd : day;
      normalized.set(clamped, (normalized.get(clamped) ?? 0) + amount);
    }
    await withTransaction(async client => {
      await client.query(
        `DELETE FROM mts_business_metric_daily
          WHERE scope = 'msisdn' AND metric = 'charges_amount' AND msisdn_hash = $1
            AND captured_date >= $2::date AND captured_date <= $3::date`,
        [hash, fromYmd, toYmd],
      );
      if (normalized.size === 0) return;
      const values: string[] = [];
      const params: unknown[] = [accountId, hash];
      for (const [day, amount] of normalized) {
        const dayIdx = params.push(day);
        const amountIdx = params.push(amount);
        values.push(`($1, 'msisdn', $2, 'charges_amount', $${amountIdx}, $${dayIdx}::date, $${dayIdx}::date, $${dayIdx}::date, NOW())`);
      }
      // ON CONFLICT — на случай параллельного синка того же номера (refresh-all
      // и «Обновить данные» из карточки не делят один lease).
      await client.query(
        `INSERT INTO mts_business_metric_daily
           (account_id, scope, msisdn_hash, metric, amount, captured_date, valid_from, valid_to, captured_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, captured_date)
         DO UPDATE SET amount = EXCLUDED.amount, valid_from = EXCLUDED.valid_from,
           valid_to = EXCLUDED.valid_to, captured_at = NOW()`,
        params,
      );
    });
  }

  /** Сумма начислений номера за период (по-дневные строки charges_amount). */
  async getMsisdnChargesForPeriod(
    rawMsisdn: string,
    fromYmd: string,
    toYmd: string,
  ): Promise<{ amount: number; capturedAt: string | null } | null> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return null;
    const row = await queryOne<{ amount: string | null; captured_at: string | null }>(
      `SELECT SUM(amount)::text AS amount, MAX(captured_at) AS captured_at
         FROM mts_business_metric_daily
        WHERE scope = 'msisdn' AND metric = 'charges_amount' AND msisdn_hash = $1
          AND captured_date >= $2::date AND captured_date <= $3::date`,
      [hash, fromYmd, toYmd],
    );
    return row?.amount != null ? { amount: Number(row.amount), capturedAt: row.captured_at } : null;
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

  /** Сумма начислений за период [fromYmd..toYmd] по каждому привязанному к сотруднику номеру. */
  async getEmployeesSummary(
    accountId: string | null | undefined,
    fromYmd: string,
    toYmd: string,
  ): Promise<IEmployeeMetricsSummaryRow[]> {
    const rows = await query<{
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      balance: string | null;
      charges_amount: string | null;
      captured_at: string | null;
    }>(
      `WITH period AS (
         SELECT msisdn_hash, SUM(amount) AS amount, MAX(captured_at) AS captured_at
           FROM mts_business_metric_daily
          WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
            AND metric = 'charges_amount'
            AND captured_date >= $2::date AND captured_date <= $3::date
            AND ($1::uuid IS NULL OR account_id = $1::uuid)
          GROUP BY msisdn_hash
       )
       SELECT nm.employee_id, e.full_name, e.tab_number,
              NULL::text AS balance,
              SUM(l.amount)::text AS charges_amount,
              MAX(l.captured_at) AS captured_at
         FROM mts_business_number_map nm
         LEFT JOIN period l ON l.msisdn_hash = nm.msisdn_hash
         LEFT JOIN employees e ON e.id = nm.employee_id
        WHERE ($1::uuid IS NULL OR nm.account_id = $1)
        GROUP BY nm.employee_id, e.full_name, e.tab_number
        ORDER BY e.full_name NULLS LAST`,
      [accountId ?? null, fromYmd, toYmd],
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

  /** Тренд метрики по дням: по конкретному ЛС (accountId) или сумма по всем активным ЛС.
   *  charges_amount хранится per-номер (scope='msisdn', день расхода) — для него
   *  тренд = сумма расходов всех номеров ЛС за день. */
  async getAccountMetricTrend(
    metric: MtsBusinessDailyMetric,
    accountId: string | null,
    from: string,
    to: string,
  ): Promise<IMetricTrendPoint[]> {
    const scope = metric === 'charges_amount' ? 'msisdn' : 'account';
    const rows = await query<{ date: string; amount: string }>(
      `SELECT captured_date::text AS date, SUM(amount)::text AS amount
         FROM mts_business_metric_daily
        WHERE scope = $5 AND metric = $1
          AND captured_date >= $2::date AND captured_date <= $3::date
          AND ($4::uuid IS NULL OR account_id = $4::uuid)
        GROUP BY captured_date
        ORDER BY captured_date`,
      [metric, from, to, accountId ?? null, scope],
    );
    return rows.map(r => ({ date: r.date, amount: Number(r.amount) }));
  }

  /** Один ряд/сутки/метрику/цель — как upsertDaily, но для JSONB-структур (тариф/услуги/пакеты/иерархия). */
  async upsertSnapshot(input: ISnapshotUpsert): Promise<void> {
    const hash = input.msisdn ? msisdnHash(input.msisdn) : null;
    await execute(
      `INSERT INTO mts_business_metric_snapshot
         (account_id, scope, account_no, msisdn_hash, metric, payload, captured_date, captured_at)
       VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, NOW())
       ON CONFLICT (scope, COALESCE(account_no, ''), COALESCE(msisdn_hash, ''), metric, captured_date)
       DO UPDATE SET payload = EXCLUDED.payload, captured_date = CURRENT_DATE, captured_at = NOW()`,
      [input.accountId, input.scope, input.accountNo ?? null, hash, input.metric, JSON.stringify(input.payload)],
    );
  }

  /** Последний снапшот структуры абонента по аккаунту (для идентификации в карточке). */
  async getLatestHierarchyForAccount(accountId: string): Promise<{ payload: unknown; capturedAt: string } | null> {
    const row = await queryOne<{ payload: unknown; captured_at: string }>(
      `SELECT payload, captured_at
         FROM mts_business_metric_snapshot
        WHERE scope = 'account' AND metric = 'hierarchy' AND account_id = $1
        ORDER BY captured_at DESC
        LIMIT 1`,
      [accountId],
    );
    return row ? { payload: row.payload, capturedAt: row.captured_at } : null;
  }

  /** Последний снапшот произвольной метрики по номеру (bill_plan/product_services и т.п.). */
  async getLatestSnapshotForMsisdn(
    rawMsisdn: string,
    metric: MtsBusinessSnapshotMetric,
  ): Promise<{ payload: unknown; capturedAt: string } | null> {
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return null;
    const row = await queryOne<{ payload: unknown; captured_at: string }>(
      `SELECT payload, captured_at
         FROM mts_business_metric_snapshot
        WHERE scope = 'msisdn' AND metric = $2 AND msisdn_hash = $1
        ORDER BY captured_at DESC
        LIMIT 1`,
      [hash, metric],
    );
    return row ? { payload: row.payload, capturedAt: row.captured_at } : null;
  }

  /** Последние снапшоты набора метрик по одному номеру (для деталей абонента, 0 живых вызовов). */
  async getLatestSnapshotsForMsisdn(
    rawMsisdn: string,
    metrics: MtsBusinessSnapshotMetric[],
  ): Promise<Map<MtsBusinessSnapshotMetric, { payload: unknown; capturedAt: string }>> {
    const out = new Map<MtsBusinessSnapshotMetric, { payload: unknown; capturedAt: string }>();
    const hash = msisdnHash(rawMsisdn);
    if (!hash || metrics.length === 0) return out;
    const rows = await query<{ metric: MtsBusinessSnapshotMetric; payload: unknown; captured_at: string }>(
      `SELECT DISTINCT ON (metric) metric, payload, captured_at
         FROM mts_business_metric_snapshot
        WHERE scope = 'msisdn' AND msisdn_hash = $1 AND metric = ANY($2::text[])
        ORDER BY metric, captured_at DESC`,
      [hash, metrics],
    );
    for (const r of rows) out.set(r.metric, { payload: r.payload, capturedAt: r.captured_at });
    return out;
  }

  /** Последние скалярные метрики по одному номеру (баланс/начисления) — для деталей абонента. */
  async getLatestDailyForMsisdn(
    rawMsisdn: string,
  ): Promise<Map<MtsBusinessDailyMetric, { amount: number; capturedAt: string; validFrom: string | null; validTo: string | null }>> {
    const out = new Map<MtsBusinessDailyMetric, { amount: number; capturedAt: string; validFrom: string | null; validTo: string | null }>();
    const hash = msisdnHash(rawMsisdn);
    if (!hash) return out;
    const rows = await query<{ metric: MtsBusinessDailyMetric; amount: string; captured_at: string; valid_from: string | null; valid_to: string | null }>(
      `SELECT DISTINCT ON (metric) metric, amount::text AS amount, captured_at, valid_from, valid_to
         FROM mts_business_metric_daily
        WHERE scope = 'msisdn' AND msisdn_hash = $1
        ORDER BY metric, captured_at DESC`,
      [hash],
    );
    for (const r of rows) out.set(r.metric, { amount: Number(r.amount), capturedAt: r.captured_at, validFrom: r.valid_from, validTo: r.valid_to });
    return out;
  }

  /** Обогащённая таблица «по сотрудникам»: тариф, кол-во/сумма платных услуг (per-номер метрики). */
  async getEmployeesCatalogSummary(accountId?: string | null): Promise<IEmployeeCatalogRow[]> {
    const rows = await query<{
      msisdn_hash: string;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      metric: MtsBusinessSnapshotMetric;
      payload: unknown;
      captured_at: string;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (msisdn_hash, metric) msisdn_hash, metric, payload, captured_at
           FROM mts_business_metric_snapshot
          WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
            AND metric IN ('bill_plan', 'product_services')
            AND ($1::uuid IS NULL OR account_id = $1::uuid)
          ORDER BY msisdn_hash, metric, captured_at DESC
       )
       SELECT nm.msisdn_hash, nm.employee_id, e.full_name, e.tab_number, l.metric, l.payload, l.captured_at
         FROM mts_business_number_map nm
         JOIN latest l ON l.msisdn_hash = nm.msisdn_hash
         LEFT JOIN employees e ON e.id = nm.employee_id
        ORDER BY e.full_name NULLS LAST, nm.msisdn_hash`,
      [accountId ?? null],
    );

    const byNumber = new Map<string, IEmployeeCatalogRow>();
    for (const r of rows) {
      let g = byNumber.get(r.msisdn_hash);
      if (!g) {
        g = {
          employeeId: r.employee_id,
          employeeFullName: r.full_name,
          employeeTabNumber: r.tab_number,
          tariffName: null,
          servicesCount: 0,
          servicesMonthlyTotal: 0,
          capturedAt: null,
        };
        byNumber.set(r.msisdn_hash, g);
      }
      if (!g.capturedAt || r.captured_at > g.capturedAt) g.capturedAt = r.captured_at;
      if (r.metric === 'bill_plan') {
        const p = r.payload as { tariffName?: string | null };
        // bill_plan приоритетнее, но почти всегда пуст — не затираем имя из услуг.
        g.tariffName = p?.tariffName ?? g.tariffName;
      } else if (r.metric === 'product_services') {
        const services = Array.isArray(r.payload) ? (r.payload as { name?: string | null; monthlyAmount?: number | null }[]) : [];
        g.servicesCount = services.length;
        g.servicesMonthlyTotal = services.reduce((a, s) => a + (s.monthlyAmount ?? 0), 0);
        // Фолбэк имени тарифа: строка «Ежемесячная плата <Тариф>» в услугах.
        g.tariffName = g.tariffName ?? extractTariffNameFromServices(services);
      }
    }
    return [...byNumber.values()];
  }

  /** Остатки пакетов минут/SMS/интернета по каждому активному ЛС (metric='validity_info', scope='account'). */
  async getAccountsPackagesSummary(): Promise<IAccountPackagesRow[]> {
    const rows = await query<{
      account_id: string;
      label: string;
      account_number: string | null;
      payload: unknown;
      captured_at: string | null;
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (account_id) account_id, payload, captured_at
           FROM mts_business_metric_snapshot
          WHERE scope = 'account' AND metric = 'validity_info' AND account_id IS NOT NULL
          ORDER BY account_id, captured_at DESC
       )
       SELECT a.id AS account_id, a.label, a.account_number, l.payload, l.captured_at
         FROM mts_business_accounts a
         LEFT JOIN latest l ON l.account_id = a.id
        WHERE a.is_active
        ORDER BY a.label`,
    );
    return rows.map(r => ({
      accountId: r.account_id,
      label: r.label,
      accountNumber: r.account_number,
      packages: Array.isArray(r.payload)
        ? (r.payload as { unitOfMeasure?: string | null; quota?: number | null; remainder?: number | null }[]).map(p => ({
            unitOfMeasure: p.unitOfMeasure ?? null,
            quota: p.quota ?? null,
            remainder: p.remainder ?? null,
          }))
        : [],
      capturedAt: r.captured_at,
    }));
  }
}

export const mtsBusinessMetricsStoreService = new MtsBusinessMetricsStoreService();
