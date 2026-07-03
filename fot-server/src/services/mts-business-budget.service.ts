import { MtsBusinessServiceBase } from './mts-business-base.service.js';

// Корпоративный бюджет (лимиты списания по номеру/лицевому счёту) — read по
// support.mts.ru подтверждён частично: ProvidedRulesByMSISDN и ByAccount
// возвращают ПОХОЖУЮ, но не идентичную структуру (у ByAccount поля лежат
// внутри ruleInformation.{code,technicalName,description}, у ByMSISDN —
// плоско productCode/productName/title/subTitle) — парсинг терпим к обеим
// формам. Add/RemoveChargeRule* и статус операции (Operations/GetStatus,
// ОТДЕЛЬНЫЙ от Product/CheckRequestStatus{,ByUUID}, используемых в
// mts-business-data/-catalog) — НЕ проверены живым вызовом, перед боевым
// использованием сверить с логом сырого payload.

export interface IMtsBudgetRule {
  productCode: string | null;
  productVersionId: string | null;
  title: string | null;
  subTitle: string | null;
  limitValue: string | null;
  activeFrom: string | null;
  activeTo: string | null;
}

export interface IMtsAvailableBudgetRule {
  productCode: string | null;
  productName: string | null;
  title: string | null;
  subTitle: string | null;
  productVersionId: string | null;
  availableLimitValues: boolean;
}

export type MtsOperationStatus = 'completed' | 'in_progress' | 'faulted' | 'unknown';

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const parseBudgetRules = (resp: unknown): IMtsBudgetRule[] => {
  const items = Array.isArray(resp) ? resp : [];
  return items.map(raw => {
    const r = raw as Record<string, unknown>;
    const info = r.ruleInformation as Record<string, unknown> | undefined;
    const remainder = r.remainder as Record<string, unknown> | undefined;
    return {
      productCode: asString(r.productCode) ?? asString(info?.code),
      productVersionId: asString(r.ruleProductVersionId) ?? asString(r.productVersionId) ?? asString(info?.technicalName),
      title: asString(r.title) ?? asString(info?.description),
      subTitle: asString(r.subTitle),
      limitValue: asString(r.formattedValue) ?? asString(remainder?.formattedValue),
      activeFrom: asString(r.activeFrom),
      activeTo: asString(r.activeTo),
    };
  });
};

const parseEventId = (resp: unknown): { eventId: string } => {
  const r = (resp ?? {}) as Record<string, unknown>;
  const eventId = asString(r.eventId) ?? asString(r.eventID);
  if (!eventId) throw new Error('МТС Бизнес: ответ без eventId');
  return { eventId };
};

const normalizeStatus = (raw: string | null): MtsOperationStatus => {
  const s = (raw || '').toLowerCase();
  if (s.includes('complet')) return 'completed';
  if (s.includes('progress')) return 'in_progress';
  if (s.includes('fault')) return 'faulted';
  return 'unknown';
};

class MtsBusinessBudgetService extends MtsBusinessServiceBase {
  async getProvidedRulesByMsisdn(accountId: string, msisdn: string): Promise<IMtsBudgetRule[]> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/ProvidedRulesByMSISDN', {
      accountId,
      data: { msisdn, language: 'Ru' },
    });
    return parseBudgetRules(resp);
  }

  async getProvidedRulesByAccount(accountId: string, accountNo: string): Promise<IMtsBudgetRule[]> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/ProvidedRulesByAccount', {
      accountId,
      data: { personalAccountNumber: accountNo, language: 'Ru' },
    });
    return parseBudgetRules(resp);
  }

  async getAvailableRulesByAccount(accountId: string, accountNo: string): Promise<IMtsAvailableBudgetRule[]> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/AvailableRulesByAccount', {
      accountId,
      data: { personalAccountNumber: accountNo },
    });
    const items = Array.isArray(resp) ? resp : [];
    return items.map(raw => {
      const r = raw as Record<string, unknown>;
      return {
        productCode: asString(r.productCode),
        productName: asString(r.productName),
        title: asString(r.title),
        subTitle: asString(r.subtitle) ?? asString(r.subTitle),
        productVersionId: asString(r.productVersionId),
        availableLimitValues: Boolean(r.availableLimitValues),
      };
    });
  }

  async addBudgetRuleByMsisdn(accountId: string, msisdn: string, productCode: string, productVersionId: string, limitValue?: string): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/AddChargeRuleByMSISDN', {
      accountId,
      data: { msisdn, productCode, productVersionId, ...(limitValue ? { limitValue } : {}) },
    });
    return parseEventId(resp);
  }

  async addBudgetRuleByAccount(accountId: string, accountNo: string, productCode: string, productVersionId: string, limitValue?: string): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/AddChargeRuleByAccount', {
      accountId,
      data: { personalAccountNumber: accountNo, productCode, productVersionId, ...(limitValue ? { limitValue } : {}) },
    });
    return parseEventId(resp);
  }

  async removeBudgetRuleByMsisdn(accountId: string, msisdn: string, productCode: string, productVersionId: string, allDuplicates = true): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/RemoveChargeRuleByMSISDN', {
      accountId,
      data: { msisdn, productCode, productVersionId, allDuplicates },
    });
    return parseEventId(resp);
  }

  async removeBudgetRuleByAccount(accountId: string, accountNo: string, productCode: string, productVersionId: string, allDuplicates = true): Promise<{ eventId: string }> {
    const resp = await this.request<unknown>('post', '/CorporateBudget/RemoveChargeRuleByAccount', {
      accountId,
      data: { personalAccountNumber: accountNo, productCode, productVersionId, allDuplicates },
    });
    return parseEventId(resp);
  }

  /** Статус операции по замене SIM / изменению правил корп.бюджета (Operations/GetStatus — НЕ Product/CheckRequestStatus). */
  async checkOperationStatus(accountId: string, eventId: string): Promise<{ status: MtsOperationStatus; raw: string | null }> {
    const resp = await this.request<unknown>('post', '/Operations/GetStatus', {
      accountId,
      data: { eventId },
    });
    const r = (resp ?? {}) as Record<string, unknown>;
    const raw = asString(r.operationStatusCode);
    return { status: normalizeStatus(raw), raw };
  }
}

export const mtsBusinessBudgetService = new MtsBusinessBudgetService();
