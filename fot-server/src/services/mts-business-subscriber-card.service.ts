import {
  mtsBusinessBillingService,
  type IMtsBalance,
  type IMtsCharge,
  type IMtsTariffFee,
  type IMtsDeliveryMethod,
  type IMtsPaymentEntry,
} from './mts-business-billing.service.js';
import {
  mtsBusinessCatalogService,
  findSubscriberInHierarchy,
  type IMtsService,
  type IMtsTariff,
  type IMtsHierarchy,
  type IMtsForwardingRule,
  type IMtsRoaming,
} from './mts-business-catalog.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import { mtsBusinessDataService } from './mts-business-data.service.js';
import { mtsBusinessMappingService } from './mts-business-mapping.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { mtsBusinessCdrService, normalizeMsisdn, type IStatementUsageEvent } from './mts-business-cdr.service.js';
import { summarizeMonthExpenses, type IMonthExpenseSummary } from './mts-business-expenses.service.js';
import { isFeatureUnavailable, MtsBusinessApiError } from './mts-business-base.service.js';

// Оркестратор «карточки номера» (read-only). Собирает по одному MSISDN всё, что
// спека МТС Business API просит показать. Идентификация/подключённые услуги/имя
// тарифа берутся из недельного снапшота (0 живых вызовов), быстро меняющееся —
// живьём с отказоустойчивой обёрткой (одна упавшая секция не роняет карточку).
// История расходов — отдельный ленивый метод getExpenses.

/** Секция карточки: данные / «нет в тарифе» / ошибка. */
export type Section<T> = { data: T } | { unavailable: true; reason: 'MTS_FEATURE_NOT_CONNECTED' } | { error: string };

export interface ISubscriberIdentity {
  msisdn: string;
  fio: string | null;
  employeeId: number | null;
  employeeFullName: string | null;
  employeeTabNumber: string | null;
  accountNo: string | null;
  contractId: string | null;
  organizationName: string | null;
  region: string | null;
  imsi: string | null;
  sim: string | null;
  iccid: string | null;
  inn: string | null;
  kpp: string | null;
  stale: boolean; // снапшот структуры отсутствует / номер в ней не найден
  capturedAt: string | null;
}

export interface ISubscriberTariff {
  name: string | null;
  fee: IMtsTariffFee | null;
}

export interface ISubscriberCard {
  identity: ISubscriberIdentity;
  balance: Section<IMtsBalance>;
  tariff: Section<ISubscriberTariff>;
  connectedServices: Section<IMtsService[]>;
  availableServices: Section<IMtsService[]>;
  connectedBlocks: Section<IMtsService[]>;
  availableBlocks: Section<IMtsService[]>;
  forwarding: Section<IMtsForwardingRule[]>;
  roaming: Section<IMtsRoaming>;
  deliveryMethod: Section<IMtsDeliveryMethod[]>;
  currentCharges: Section<IMtsCharge | null>;
}

/** Номер не привязан к аккаунту — единственная жёсткая ошибка карточки (→ 404). */
export class SubscriberNotLinkedError extends Error {
  constructor() {
    super('МТС Бизнес: номер не найден или не привязан к аккаунту');
    this.name = 'SubscriberNotLinkedError';
  }
}

/** Обёртка секции: 403/1010 → «нет в тарифе», прочее → ошибка; никогда не реджектит. */
const settleSection = async <T>(fn: () => Promise<T>): Promise<Section<T>> => {
  try {
    return { data: await fn() };
  } catch (e) {
    if (isFeatureUnavailable(e)) return { unavailable: true, reason: 'MTS_FEATURE_NOT_CONNECTED' };
    // Без ПДн: только http/код.
    console.warn(`[mts-biz-card] секция пропущена: ${e instanceof MtsBusinessApiError ? `http=${e.status} code=${e.code ?? '-'}` : 'ошибка'}`);
    return { error: e instanceof MtsBusinessApiError ? `МТС ${e.status}` : 'ошибка' };
  }
};

const monthRange = (month: string): { from: string; to: string } => {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('МТС Бизнес: месяц должен быть в формате YYYY-MM');
  const lastDay = new Date(Number(m[1]), Number(m[2]), 0).getDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(lastDay).padStart(2, '0')}` };
};

class MtsBusinessSubscriberCardService {
  async getCard(msisdn: string): Promise<ISubscriberCard> {
    const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
    if (!ctx) throw new SubscriberNotLinkedError();
    const { accountId } = ctx;

    // ФИО: сотрудник/mts_fio из справочника; если ни того ни другого — живьём
    // PersonalDataInfo (тот же источник, что у планировщика; парсим ТОЛЬКО ФИО,
    // ничего не логируем). Так карточка не остаётся «цифрами без ФИО».
    let fio = ctx.fio;
    if (!fio) {
      try {
        fio = await mtsBusinessCatalogService.getPersonalDataFio(accountId, msisdn);
      } catch {
        /* best-effort: ПДн не логируем, карточку не роняем */
      }
    }

    // Идентификация — из снапшота структуры абонента (без живого вызова).
    const hierSnap = await mtsBusinessMetricsStoreService.getLatestHierarchyForAccount(accountId);
    const hierarchy = (hierSnap?.payload ?? null) as IMtsHierarchy | null;
    const node = findSubscriberInHierarchy(hierarchy, msisdn);
    const identity: ISubscriberIdentity = {
      msisdn: normalizeMsisdn(msisdn) ?? msisdn,
      fio,
      employeeId: ctx.employeeId,
      employeeFullName: ctx.employeeFullName,
      employeeTabNumber: ctx.employeeTabNumber,
      accountNo: node?.accountNo ?? ctx.accountNo,
      contractId: hierarchy?.contractId ?? null,
      organizationName: hierarchy?.organizationName ?? null,
      region: node?.region ?? null,
      imsi: node?.imsi ?? null,
      sim: node?.sim ?? null,
      iccid: node?.iccid ?? null,
      inn: hierarchy?.inn ?? null,
      kpp: hierarchy?.kpp ?? null,
      stale: !node,
      capturedAt: hierSnap?.capturedAt ?? null,
    };

    // Снапшот-секции: подключённые услуги + имя тарифа.
    const servicesSnap = await mtsBusinessMetricsStoreService.getLatestSnapshotForMsisdn(msisdn, 'product_services');
    const connectedServices: Section<IMtsService[]> = { data: (servicesSnap?.payload as IMtsService[] | undefined) ?? [] };
    const billPlanSnap = await mtsBusinessMetricsStoreService.getLatestSnapshotForMsisdn(msisdn, 'bill_plan');
    const tariffName = (billPlanSnap?.payload as IMtsTariff | undefined)?.tariffName ?? null;

    // Начисления берём из сохранённой выписки (metric_daily, по-дневные строки),
    // а НЕ живым CheckCharges: его remainedAmount — остаток по лицевому счёту
    // (сотни тысяч ₽), а не начисление на номер. Пишет их syncMsisdnStatement;
    // здесь — сумма за текущий месяц МСК.
    const chargesTo = moscowTodayIso();
    const chargesFrom = `${chargesTo.slice(0, 7)}-01`;
    const monthCharges = await mtsBusinessMetricsStoreService.getMsisdnChargesForPeriod(msisdn, chargesFrom, chargesTo);
    const currentCharges: Section<IMtsCharge | null> = {
      data: monthCharges
        ? { msisdn, amount: monthCharges.amount, periodStart: chargesFrom, periodEnd: chargesTo }
        : null,
    };

    // Живые секции — параллельно, каждая отказоустойчива.
    const [balance, feeSec, availableServices, connectedBlocks, availableBlocks, forwarding, roaming, deliveryMethod] =
      await Promise.all([
        settleSection(() => mtsBusinessBillingService.checkBalanceByMsisdn(accountId, msisdn)),
        settleSection(() => mtsBusinessBillingService.getTariffRental(accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getAvailableServices(accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getConnectedBlocks(accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getAvailableBlocks(accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getCallForwarding(accountId, msisdn)),
        settleSection(() => mtsBusinessCatalogService.getCurrentSubscriberLocation(accountId, msisdn)),
        settleSection(() => mtsBusinessBillingService.getDocumentDeliveryMethod(accountId, msisdn)),
      ]);

    const tariff: Section<ISubscriberTariff> = {
      data: { name: tariffName, fee: 'data' in feeSec ? feeSec.data : null },
    };

    return {
      identity,
      balance,
      tariff,
      connectedServices,
      availableServices,
      connectedBlocks,
      availableBlocks,
      forwarding,
      roaming,
      deliveryMethod,
      currentCharges,
    };
  }

  /** Ленивая сводка расходов за месяц (YYYY-MM): выписка + пополнения → категории. */
  async getExpenses(msisdn: string, month: string): Promise<{ month: string; summary: IMonthExpenseSummary }> {
    const ctx = await mtsBusinessMappingService.getSubscriberContext(msisdn);
    if (!ctx) throw new SubscriberNotLinkedError();
    const { accountId } = ctx;
    const { from, to } = monthRange(month);

    let usages: IStatementUsageEvent[] = [];
    let payments: IMtsPaymentEntry[] = [];
    try {
      const stmt = await mtsBusinessDataService.getBillingStatementByMsisdn(accountId, { msisdn, dateFrom: from, dateTo: to });
      usages = mtsBusinessCdrService.parseStatementUsages(stmt);
    } catch (e) {
      if (!isFeatureUnavailable(e)) console.warn('[mts-biz-card] выписка расходов недоступна');
    }
    try {
      payments = await mtsBusinessBillingService.getPaymentHistoryByMsisdn(accountId, msisdn, from, to);
    } catch (e) {
      if (!isFeatureUnavailable(e)) console.warn('[mts-biz-card] история платежей недоступна');
    }

    return { month, summary: summarizeMonthExpenses(usages, payments) };
  }
}

export const mtsBusinessSubscriberCardService = new MtsBusinessSubscriberCardService();
