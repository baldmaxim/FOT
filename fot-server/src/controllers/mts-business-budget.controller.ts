import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessBudgetService } from '../services/mts-business-budget.service.js';
import { mtsBusinessMetricsStoreService } from '../services/mts-business-metrics-store.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';

// Корпоративный бюджет (лимиты списания по номеру) — read живой (для принятия
// решения нужны свежие данные, не история), add/remove — асинхронно через
// eventId + статус-поллер (mts-business-status-poller.service.ts).

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-budget] upstream error: http=${error.status}`);
    Sentry.captureException(error, { tags: { module: 'mts-business-budget', kind: 'upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-budget] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business-budget', kind: 'generic' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

export const mtsBusinessBudgetController = {
  /** Подключённые правила списания на номере — живой вызов (данные для принятия решения). */
  async getRulesByMsisdn(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, msisdn } = req.query as { accountId?: string; msisdn?: string };
      if (!accountId || !msisdn) {
        res.status(400).json({ success: false, error: 'Укажите accountId и msisdn' });
        return;
      }
      const rules = await mtsBusinessBudgetService.getProvidedRulesByMsisdn(accountId, msisdn);
      await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId, scope: 'msisdn', msisdn, metric: 'budget_rules', payload: rules });
      res.json({ success: true, data: rules });
    } catch (error) {
      fail(res, error, 'Ошибка получения правил корп.бюджета');
    }
  },

  /** Доступные для подключения правила (по лицевому счёту, к которому привязан номер). */
  async getAvailableRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, accountNo } = req.query as { accountId?: string; accountNo?: string };
      if (!accountId || !accountNo) {
        res.status(400).json({ success: false, error: 'Укажите accountId и accountNo' });
        return;
      }
      const rules = await mtsBusinessBudgetService.getAvailableRulesByAccount(accountId, accountNo);
      res.json({ success: true, data: rules });
    } catch (error) {
      fail(res, error, 'Ошибка получения доступных правил корп.бюджета');
    }
  },

  async addRule(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, msisdn, productCode, productVersionId, limitValue, confirmed } = req.body as {
        accountId?: string; msisdn?: string; productCode?: string; productVersionId?: string; limitValue?: string; confirmed?: boolean;
      };
      if (confirmed !== true) { res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' }); return; }
      if (!accountId || !msisdn || !productCode || !productVersionId) {
        res.status(400).json({ success: false, error: 'Укажите accountId, msisdn, productCode и productVersionId' });
        return;
      }
      const { eventId } = await mtsBusinessBudgetService.addBudgetRuleByMsisdn(accountId, msisdn, productCode, productVersionId, limitValue);
      await mtsBusinessActionsService.create({
        eventId, accountId, scope: 'msisdn', msisdn, actionType: 'budget_rule_add',
        payload: { productCode, productVersionId, limitValue: limitValue ?? null }, requestedBy: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_BUDGET_RULE_ADD_REQUESTED, {
        details: { accountId, productCode },
      });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      fail(res, error, 'Ошибка добавления правила корп.бюджета');
    }
  },

  async removeRule(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { accountId, msisdn, productCode, productVersionId, confirmed } = req.body as {
        accountId?: string; msisdn?: string; productCode?: string; productVersionId?: string; confirmed?: boolean;
      };
      if (confirmed !== true) { res.status(400).json({ success: false, error: 'Требуется подтверждение (confirmed=true)' }); return; }
      if (!accountId || !msisdn || !productCode || !productVersionId) {
        res.status(400).json({ success: false, error: 'Укажите accountId, msisdn, productCode и productVersionId' });
        return;
      }
      const { eventId } = await mtsBusinessBudgetService.removeBudgetRuleByMsisdn(accountId, msisdn, productCode, productVersionId);
      await mtsBusinessActionsService.create({
        eventId, accountId, scope: 'msisdn', msisdn, actionType: 'budget_rule_remove',
        payload: { productCode, productVersionId }, requestedBy: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.MTS_BUSINESS_BUDGET_RULE_REMOVE_REQUESTED, {
        details: { accountId, productCode },
      });
      res.json({ success: true, data: { eventId } });
    } catch (error) {
      fail(res, error, 'Ошибка удаления правила корп.бюджета');
    }
  },
};
