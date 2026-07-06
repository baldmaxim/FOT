import { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { normalizeMsisdn } from '../services/mts-business-cdr.service.js';
import {
  mtsBusinessSubscriberCardService,
  SubscriberNotLinkedError,
} from '../services/mts-business-subscriber-card.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';

// Карточка номера (read-only). Роутер уже под authenticate + noStore +
// requirePageAccess('/mts-business','view'). Тело/ПДн не логируем — только http.

const fail = (res: Response, error: unknown, fallback: string): void => {
  if (error instanceof SubscriberNotLinkedError) {
    res.status(404).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof MtsBusinessApiError) {
    console.error(`[mts-biz-subscriber] upstream error: http=${error.status}`);
    Sentry.captureException(error, { tags: { module: 'mts-business-subscriber', kind: 'upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status });
    return;
  }
  const msg = error instanceof Error ? error.message : 'unknown';
  console.error(`[mts-biz-subscriber] ${fallback}: ${msg}`);
  Sentry.captureException(error, { tags: { module: 'mts-business-subscriber', kind: 'generic' } });
  res.status(500).json({ success: false, error: fallback, internal: msg });
};

const currentMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const mtsBusinessSubscriberController = {
  /** Полная карточка номера: идентификация + баланс/тариф/услуги/блоки/переадресация/роуминг/доставка/начисления. */
  async getCard(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = normalizeMsisdn(req.params.msisdn);
      if (!msisdn) {
        res.status(400).json({ success: false, error: 'Некорректный номер' });
        return;
      }
      const data = await mtsBusinessSubscriberCardService.getCard(msisdn);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения карточки номера');
    }
  },

  /** Сводка расходов за месяц (?month=YYYY-MM, по умолчанию текущий). */
  async getExpenses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const msisdn = normalizeMsisdn(req.params.msisdn);
      if (!msisdn) {
        res.status(400).json({ success: false, error: 'Некорректный номер' });
        return;
      }
      const month = req.query.month ? String(req.query.month) : currentMonth();
      if (!/^\d{4}-\d{2}$/.test(month)) {
        res.status(400).json({ success: false, error: 'Месяц должен быть в формате YYYY-MM' });
        return;
      }
      const data = await mtsBusinessSubscriberCardService.getExpenses(msisdn, month);
      res.json({ success: true, data });
    } catch (error) {
      fail(res, error, 'Ошибка получения расходов');
    }
  },
};
