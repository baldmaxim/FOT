import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { mtsBusinessActionsService } from './mts-business-actions.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { MtsBusinessApiError, isFeatureUnavailable, isTransientMtsError } from './mts-business-base.service.js';
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

// Разобрано живьём 22.07.2026 (7915***501): 421/3003 «Сервис Foris временно
// недоступен» на переадресации означал не сбой МТС, а отсутствие услуги на
// номере — в журнале заявок CallForwardingInfo пришло
// foris_error_code=CallForwardingServiceNotExists «На приложении обслуживания
// отсутствует услуга "Переадресация вызова"». После подключения этой услуги
// (каталог «Подключить услугу» в карточке номера) тот же вызов прошёл.
const NOT_CONNECTED_HINT = 'Проверьте, подключена ли на номере услуга «Переадресация вызова» — её можно подключить в карточке номера («Подключённые услуги» → «+»).';

/**
 * Ответ на «не наши» отказы МТС по переадресации: показываем причину и не шумим
 * в Sentry (это не баг портала). Возвращает true, если ответ уже отправлен.
 */
export const failForwardingUpstream = (res: Response, error: unknown, fallback: string): boolean => {
  if (isFeatureUnavailable(error)) {
    console.warn('[mts-forwarding] 403/1010 — функция не входит в подписку МТС');
    res.status(409).json({ success: false, error: fallback, mtsHttp: 403, mtsMessage: NOT_CONNECTED_HINT });
    return true;
  }
  if (isTransientMtsError(error)) {
    const e = error as MtsBusinessApiError;
    console.warn('[mts-forwarding] 421/3003 — Foris не принял запрос по переадресации');
    res.status(503).json({
      success: false,
      error: fallback,
      mtsHttp: e.status,
      mtsMessage: `${e.message}. ${NOT_CONNECTED_HINT}`,
    });
    return true;
  }
  return false;
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
