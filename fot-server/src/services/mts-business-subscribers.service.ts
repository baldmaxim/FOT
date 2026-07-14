import { query } from '../config/postgres.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { encryptionService } from './encryption.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { mtsBusinessPersonalDataService, type IMtsPersonalDataFull } from './mts-business-personal-data.service.js';
import { extractTariffNameFromServices } from './mts-business-catalog.service.js';
import type { IMtsService, IMtsTariff, IMtsForwardingRule, IMtsRoaming } from './mts-business-catalog.service.js';
import type { IMtsTariffFee, IMtsPaymentEntry, IMtsDeliveryMethod, IMtsPackageCounter } from './mts-business-billing.service.js';

// Вкладка «Абоненты»: сборка списка и деталей ИЗ БД (0 живых вызовов МТС) —
// number_map (инвентарь/ФИО/привязка) + агрегат CDR + дневные метрики
// (баланс/начисления) + снапшоты (тариф/услуги/…). Живые вызовы — только в
// syncSubscriberFull (кнопки «Обновить») и в /available (каталог подключаемого).
// pd_data_enc (паспорт/ДР) расшифровывается в getSubscriberDetails для карточки
// абонента (под гардом страницы /mts-business); в список и в логи не идёт.

export interface IMtsSubscriberRow {
  msisdn: string | null;
  accountId: string | null;
  accountLabel: string | null;
  mtsFio: string | null;
  mtsComment: string | null;
  pdStatus: string | null;
  pdSyncedAt: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  departmentId: string | null;
  departmentName: string | null;
  calls: number;
  totalSeconds: number;
  lastCallAt: string | null;
  balance: number | null;
  chargesAmount: number | null;
  tariffName: string | null;
  servicesCount: number;
  servicesMonthlyTotal: number;
  capturedAt: string | null;
}

export interface IMtsSubscriberDetails {
  msisdn: string;
  accountId: string;
  balance: { amount: number; capturedAt: string } | null;
  charges: { amount: number; capturedAt: string | null } | null; // сумма за текущий месяц МСК
  tariff: { name: string | null; fee: IMtsTariffFee | null };
  services: IMtsService[];
  blocks: IMtsService[];
  forwarding: IMtsForwardingRule[];
  roaming: IMtsRoaming | null;
  deliveryMethod: IMtsDeliveryMethod[];
  payments: IMtsPaymentEntry[];
  packages: IMtsPackageCounter[];
  personalData: IMtsPersonalDataFull | null; // расшифровка pd_data_enc (ФИО/ДР/паспорт)
  capturedAt: string | null; // самый свежий из снапшотов
}

/**
 * Данные SIM для ЛК сотрудника — только тариф/абонплата/начисления:
 * БЕЗ personalData (pd_data_enc не читается вовсе), БЕЗ баланса (это остаток
 * лицевого счёта КОМПАНИИ, не номера), БЕЗ услуг/блокировок/пакетов/платежей.
 */
export interface IMySimNumber {
  msisdn: string;
  tariff: { name: string | null; fee: IMtsTariffFee | null };
  charges: { amount: number; capturedAt: string | null } | null; // начисления номера за текущий месяц МСК
  capturedAt: string | null;
}

class MtsBusinessSubscribersService {
  /** Список абонентов для таблицы — всё из БД одним заходом. */
  async listSubscribers(): Promise<IMtsSubscriberRow[]> {
    const rows = await query<{
      msisdn_enc: string | null;
      calls: string;
      total_sec: string;
      last_call_at: string | null;
      account_id: string | null;
      account_label: string | null;
      mts_fio: string | null;
      mts_comment: string | null;
      pd_status: string | null;
      pd_synced_at: string | null;
      employee_id: number | null;
      full_name: string | null;
      tab_number: string | null;
      department_id: string | null;
      department_name: string | null;
      balance: string | null;
      charges_amount: string | null;
      bill_plan: unknown;
      product_services: unknown;
      captured_at: string | null;
    }>(
      // Агрегат звонков берём из роллапа (materialized view, ~700 строк), а не
      // полным сканом mts_business_cdr (267k строк) — см. миграцию 214.
      // Обновляется ночным синком CDR и «Обновить всё» (refreshCdrRollup).
      `WITH cdr AS (
         SELECT msisdn_hash, msisdn_enc, calls, total_sec, last_call_at, account_id
           FROM mts_business_cdr_rollup
       ),
       metrics AS (
         SELECT msisdn_hash,
                MAX(amount) FILTER (WHERE metric = 'balance') AS balance,
                MAX(captured_at) AS captured_at
           FROM (
             SELECT DISTINCT ON (msisdn_hash, metric) msisdn_hash, metric, amount, captured_at
               FROM mts_business_metric_daily
              WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
                AND metric <> 'charges_amount'
              ORDER BY msisdn_hash, metric, captured_at DESC
           ) t
          GROUP BY msisdn_hash
       ),
       -- Начисления по дням (captured_date = день расхода) → сумма за текущий месяц МСК.
       charges AS (
         SELECT msisdn_hash, SUM(amount) AS charges_amount, MAX(captured_at) AS captured_at
           FROM mts_business_metric_daily
          WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
            AND metric = 'charges_amount'
            AND captured_date >= date_trunc('month', (NOW() AT TIME ZONE 'Europe/Moscow'))::date
          GROUP BY msisdn_hash
       ),
       snaps AS (
         SELECT msisdn_hash,
                MAX(payload::text) FILTER (WHERE metric = 'bill_plan') AS bill_plan,
                MAX(payload::text) FILTER (WHERE metric = 'product_services') AS product_services,
                MAX(captured_at) AS captured_at
           FROM (
             SELECT DISTINCT ON (msisdn_hash, metric) msisdn_hash, metric, payload, captured_at
               FROM mts_business_metric_snapshot
              WHERE scope = 'msisdn' AND msisdn_hash IS NOT NULL
                AND metric IN ('bill_plan', 'product_services')
              ORDER BY msisdn_hash, metric, captured_at DESC
           ) t
          GROUP BY msisdn_hash
       )
       SELECT COALESCE(m.msisdn_enc, c.msisdn_enc) AS msisdn_enc,
              COALESCE(c.calls, 0)::text AS calls,
              COALESCE(c.total_sec, 0)::text AS total_sec,
              c.last_call_at,
              COALESCE(m.account_id::text, c.account_id) AS account_id,
              a.label AS account_label,
              m.mts_fio,
              m.mts_comment,
              m.pd_status,
              m.pd_synced_at,
              m.employee_id,
              e.full_name,
              e.tab_number,
              e.org_department_id::text AS department_id,
              od.name AS department_name,
              mt.balance::text AS balance,
              ch.charges_amount::text AS charges_amount,
              s.bill_plan,
              s.product_services,
              GREATEST(mt.captured_at, ch.captured_at, s.captured_at) AS captured_at
         FROM mts_business_number_map m
         FULL OUTER JOIN cdr c ON c.msisdn_hash = m.msisdn_hash
         LEFT JOIN metrics mt ON mt.msisdn_hash = COALESCE(m.msisdn_hash, c.msisdn_hash)
         LEFT JOIN charges ch ON ch.msisdn_hash = COALESCE(m.msisdn_hash, c.msisdn_hash)
         LEFT JOIN snaps s ON s.msisdn_hash = COALESCE(m.msisdn_hash, c.msisdn_hash)
         LEFT JOIN employees e ON e.id = m.employee_id
         LEFT JOIN org_departments od ON od.id = e.org_department_id
         LEFT JOIN mts_business_accounts a ON a.id = COALESCE(m.account_id::text, c.account_id)::uuid
        ORDER BY e.full_name NULLS LAST, COALESCE(c.total_sec, 0) DESC`,
    );

    let fallbackAccount: { id: string; label: string } | null = null;
    if (rows.some(r => r.account_id == null)) {
      const active = await query<{ id: string; label: string }>(
        `SELECT id, label FROM mts_business_accounts WHERE is_active`,
      );
      if (active.length === 1) fallbackAccount = active[0];
    }

    return rows.map(r => {
      const billPlan = this.parseJson<IMtsTariff>(r.bill_plan);
      const services = this.parseJson<Array<{ name?: string | null; monthlyAmount?: number | null }>>(r.product_services);
      const list = Array.isArray(services) ? services : [];
      return {
        msisdn: encryptionService.decryptField(r.msisdn_enc),
        accountId: r.account_id ?? fallbackAccount?.id ?? null,
        accountLabel: r.account_label ?? (r.account_id == null ? fallbackAccount?.label ?? null : null),
        mtsFio: r.mts_fio,
        mtsComment: r.mts_comment,
        pdStatus: r.pd_status,
        pdSyncedAt: r.pd_synced_at,
        employeeId: r.employee_id,
        employeeFullName: r.full_name,
        employeeTabNumber: r.tab_number,
        departmentId: r.department_id,
        departmentName: r.department_name,
        calls: Number(r.calls),
        totalSeconds: Number(r.total_sec),
        lastCallAt: r.last_call_at,
        balance: r.balance != null ? Number(r.balance) : null,
        chargesAmount: r.charges_amount != null ? Number(r.charges_amount) : null,
        tariffName: billPlan?.tariffName ?? extractTariffNameFromServices(list),
        servicesCount: list.length,
        servicesMonthlyTotal: list.reduce((a, s) => a + (s.monthlyAmount ?? 0), 0),
        capturedAt: r.captured_at,
      };
    });
  }

  /** Детали абонента для боковой панели — из сохранённых снапшотов/метрик. */
  async getSubscriberDetails(rawMsisdn: string): Promise<IMtsSubscriberDetails | null> {
    const ctx = await mtsBusinessMappingService.getSubscriberContext(rawMsisdn);
    if (!ctx) return null;

    const monthTo = moscowTodayIso();
    const monthFrom = `${monthTo.slice(0, 7)}-01`;
    const [snaps, daily, charges, personalData] = await Promise.all([
      mtsBusinessMetricsStoreService.getLatestSnapshotsForMsisdn(rawMsisdn, [
        'bill_plan', 'tariff_fee', 'product_services', 'connected_blocks',
        'forwarding', 'roaming', 'delivery_method', 'payments', 'validity_msisdn',
      ]),
      mtsBusinessMetricsStoreService.getLatestDailyForMsisdn(rawMsisdn),
      mtsBusinessMetricsStoreService.getMsisdnChargesForPeriod(rawMsisdn, monthFrom, monthTo),
      mtsBusinessPersonalDataService.getStoredFull(rawMsisdn),
    ]);

    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const services = arr<IMtsService>(snaps.get('product_services')?.payload);
    const balance = daily.get('balance');
    const capturedAt = [...snaps.values()].reduce<string | null>(
      (max, s) => (max == null || s.capturedAt > max ? s.capturedAt : max),
      null,
    );

    return {
      msisdn: rawMsisdn,
      accountId: ctx.accountId,
      balance: balance ? { amount: balance.amount, capturedAt: balance.capturedAt } : null,
      charges: charges ? { amount: charges.amount, capturedAt: charges.capturedAt } : null,
      tariff: {
        name: (snaps.get('bill_plan')?.payload as IMtsTariff | undefined)?.tariffName
          ?? extractTariffNameFromServices(services),
        fee: (snaps.get('tariff_fee')?.payload as IMtsTariffFee | undefined) ?? null,
      },
      services,
      blocks: arr<IMtsService>(snaps.get('connected_blocks')?.payload),
      forwarding: arr<IMtsForwardingRule>(snaps.get('forwarding')?.payload),
      roaming: (snaps.get('roaming')?.payload as IMtsRoaming | undefined) ?? null,
      deliveryMethod: arr<IMtsDeliveryMethod>(snaps.get('delivery_method')?.payload),
      payments: arr<IMtsPaymentEntry>(snaps.get('payments')?.payload),
      packages: arr<IMtsPackageCounter>(snaps.get('validity_msisdn')?.payload),
      personalData,
      capturedAt,
    };
  }

  /**
   * Данные SIM для ЛК сотрудника — из тех же снапшотов, что карточка абонента,
   * но только «безопасные» секции (см. IMySimNumber). product_services читается
   * лишь для fallback-имени тарифа (BillPlanInfo бывает пуст — тогда тариф
   * берётся из услуги «Ежемесячная плата»), сам список наружу не отдаётся.
   * ПДн-поля не читаются.
   */
  async getMySimSummary(rawMsisdn: string): Promise<IMySimNumber | null> {
    const monthTo = moscowTodayIso();
    const monthFrom = `${monthTo.slice(0, 7)}-01`;
    const [snaps, charges] = await Promise.all([
      mtsBusinessMetricsStoreService.getLatestSnapshotsForMsisdn(rawMsisdn, [
        'bill_plan', 'tariff_fee', 'product_services',
      ]),
      mtsBusinessMetricsStoreService.getMsisdnChargesForPeriod(rawMsisdn, monthFrom, monthTo),
    ]);

    const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    const services = arr<IMtsService>(snaps.get('product_services')?.payload);
    const capturedAt = [...snaps.values()].reduce<string | null>(
      (max, s) => (max == null || s.capturedAt > max ? s.capturedAt : max),
      null,
    );

    return {
      msisdn: rawMsisdn,
      tariff: {
        name: (snaps.get('bill_plan')?.payload as IMtsTariff | undefined)?.tariffName
          ?? extractTariffNameFromServices(services),
        fee: (snaps.get('tariff_fee')?.payload as IMtsTariffFee | undefined) ?? null,
      },
      charges: charges ? { amount: charges.amount, capturedAt: charges.capturedAt } : null,
      capturedAt,
    };
  }

  private parseJson<T>(v: unknown): T | null {
    if (v == null) return null;
    if (typeof v === 'object') return v as T;
    if (typeof v === 'string') {
      try { return JSON.parse(v) as T; } catch { return null; }
    }
    return null;
  }
}

export const mtsBusinessSubscribersService = new MtsBusinessSubscribersService();
