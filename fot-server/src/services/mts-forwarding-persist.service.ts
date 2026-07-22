import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { mtsBusinessActionsService } from './mts-business-actions.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import type { ForwardingChangeResult } from './mts-business-catalog.service.js';

// Локальная постобработка мутации переадресации — общая для админки
// («МТС Бизнес» → Абоненты) и ЛК «Моя SIM».
//
// КЛЮЧЕВОЕ ПРАВИЛО: сюда попадают только УСПЕШНЫЕ ответы МТС. Падение записи в
// нашу БД (заявка/снапшот) не должно превращаться в «переадресация не
// применена» — иначе пользователь повторит уже выполненную внешнюю мутацию.
// Поэтому ошибки здесь не бросаются: они уходят в Sentry, а наружу идёт
// tracking:false («в МТС применено, локально не записано»).

export interface IForwardingPersistInput {
  result: ForwardingChangeResult;
  accountId: string;
  msisdn: string;
  actionType: 'forwarding_set' | 'forwarding_remove';
  /** Шифруется целиком в mts_business_action_requests. */
  payload: unknown;
  requestedBy: string;
  /** Запись в аудит — здесь же, чтобы её падение тоже не отменяло успех МТС. */
  audit?: () => Promise<void>;
}

export const persistForwardingResult = async (input: IForwardingPersistInput): Promise<{ tracking: boolean }> => {
  const { result, accountId, msisdn } = input;
  try {
    if (input.audit) await input.audit();
    if (result.outcome === 'queued') {
      await mtsBusinessActionsService.create({
        eventId: result.eventId,
        accountId,
        scope: 'msisdn',
        msisdn,
        actionType: input.actionType,
        payload: input.payload,
        requestedBy: input.requestedBy,
      });
      return { tracking: true };
    }
    if (result.outcome === 'applied') {
      // Заявку не создаём: без eventId статус-поллеру нечего проверять. Правила
      // берём те, что сервис уже прочитал и сверил, — повторное чтение здесь
      // могло бы упасть и обнулить успешную операцию.
      await mtsBusinessMetricsStoreService.upsertSnapshot({
        accountId, scope: 'msisdn', msisdn, metric: 'forwarding', payload: result.rules,
      });
      return { tracking: true };
    }
    // unknown — писать нечего: исход в МТС не подтверждён.
    return { tracking: true };
  } catch (error) {
    console.error(`[mts-forwarding] локальная запись после успеха МТС не удалась: ${error instanceof Error ? error.message : 'unknown'}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'forwarding-persist' } });
    return { tracking: false };
  }
};

/**
 * Единый ответ обоих контуров. 202 — исход в МТС не подтверждён: клиент обязан
 * не повторять операцию, а обновить состояние позже.
 */
export const sendForwardingResult = (res: Response, result: ForwardingChangeResult, tracking: boolean): void => {
  res.status(result.outcome === 'unknown' ? 202 : 200).json({
    success: true,
    data: { outcome: result.outcome, eventId: result.eventId, tracking },
  });
};
