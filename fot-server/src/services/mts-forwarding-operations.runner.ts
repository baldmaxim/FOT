import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { mtsBusinessCatalogService, type IMtsForwardingRule, type IMtsService } from './mts-business-catalog.service.js';
import { mtsBusinessActionsService } from './mts-business-actions.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { MtsBusinessApiError, isTransientMtsError, mtsMutationSendOutcome } from './mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import { FORWARDING_CHANGES_PER_HOUR } from '../middleware/rateLimit.js';
import {
  conflictingRuleTypes,
  matchesForwardingIntent,
  matchesForwardingMode,
  matchesForwardingOff,
  type ForwardingType,
} from './mts-forwarding.shared.js';
import {
  mtsForwardingOperationsService as ops,
  type ForwardingOperationState,
  type IForwardingOperation,
  type ITransitionGuard,
  type ITransitionPatch,
} from './mts-forwarding-operations.service.js';

// Шаги серверной операции переадресации — общие для контроллера «Моя SIM»
// (первые шаги синхронно, пока сотрудник ждёт ответа) и фонового воркера.
//
//  - Каждая внешняя мутация — только после выигранного claimSend (новое поколение);
//    при неизвестном исходе дальше идёт лишь сверка чтением.
//  - Этап правила: сначала по одному снимаются мешающие правила других типов
//    (при активном CFU МТС не применяет условную переадресацию), каждое снятие
//    подтверждается; затем ставится выбранное; успех — режим целиком.
//  - Переходы после отправки сверяют поколение и действие: запоздавший результат
//    прошлого шага не меняет состояние; снимок и аудит пишутся в той же транзакции.

/** Услуга «Переадресация вызова (периодическая)» — без неё Foris отклоняет правило (421/3003). */
export const FORWARDING_SERVICE_CODE = 'PE0250';

export const SERVICE_STAGE_DEADLINE_SECONDS = 60 * 60;
export const RULE_STAGE_DEADLINE_SECONDS = 30 * 60;
const CHECK_INTERVAL_SECONDS = 60;
const RULE_RETRY_SECONDS = 120;
const MAX_RULE_ATTEMPTS = 3;
export const UNCONFIRMED_CHECK_SECONDS = 15 * 60;
const QUOTA_WINDOW_SECONDS = 60 * 60;

export const RATE_LIMITED_CODE = 'rate_limited';

export const hasForwardingService = (services: ReadonlyArray<Pick<IMtsService, 'code' | 'status'>>): boolean =>
  services.some(s => (s.code ?? '').toUpperCase() === FORWARDING_SERVICE_CODE && (s.status ?? '').toUpperCase() === 'ACTIVE');

const errorOf = (error: unknown): { code: string | null; message: string } => {
  if (error instanceof MtsBusinessApiError) {
    return { code: error.code ? `${error.status}/${error.code}` : String(error.status), message: error.message };
  }
  return { code: null, message: error instanceof Error ? error.message : 'unknown' };
};

const deadlinePassed = (op: IForwardingOperation): boolean => new Date(op.deadlineAt).getTime() <= Date.now();

const bestEffort = async (label: string, fn: () => Promise<void>): Promise<void> => {
  try {
    await fn();
  } catch (error) {
    console.error(`[mts-fwd-op] ${label}: ${error instanceof Error ? error.message : 'unknown'}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'forwarding-operation', step: label } });
  }
};

/**
 * Условие перехода по текущей строке: аренда — только если строка закреплена за
 * этим владельцем (воркер); поколение и действие — всегда.
 */
export const guardOf = (op: IForwardingOperation, owner: string | undefined): ITransitionGuard => ({
  owner: owner && op.leaseOwner === owner ? owner : undefined,
  expect: { generation: op.sendGeneration, action: op.ruleAction },
});

const reload = async (op: IForwardingOperation): Promise<IForwardingOperation> => (await ops.getById(op.id)) ?? op;

const deleteActionType = (action: IForwardingOperation['ruleAction']): ForwardingType | null =>
  action ? (action.slice('delete:'.length) as ForwardingType) : null;

/** Целевой режим операции достигнут (для remove — переадресация выключена). */
const targetReached = (op: IForwardingOperation, rules: IMtsForwardingRule[]): boolean =>
  op.kind === 'remove'
    ? matchesForwardingOff(rules)
    : matchesForwardingMode(rules, op.forwardingType, op.target ?? '', op.noReplyTimer ?? undefined);

/** Квота изменений: один раз на операцию, перед первой реальной мутацией. Исчерпана → cancelled. */
const ensureQuota = async (op: IForwardingOperation, owner: string): Promise<IForwardingOperation | null> => {
  if (op.quotaCountedAt) return op;
  if (await ops.consumeQuota(op.id, op.requestedBy, FORWARDING_CHANGES_PER_HOUR, QUOTA_WINDOW_SECONDS)) return op;
  console.warn(`[mts-fwd-op] quota exhausted user=${op.requestedBy} operation=${op.id}`);
  await ops.transition(op.id, [op.state], {
    state: 'cancelled', lease: null,
    error: { code: RATE_LIMITED_CODE, message: 'Слишком много изменений переадресации, попробуйте через час' },
  }, guardOf(op, owner));
  return null;
};

const writeForwardingSnapshot = (client: PoolClient, op: IForwardingOperation, msisdn: string, rules: unknown): Promise<void> =>
  mtsBusinessMetricsStoreService.upsertSnapshotWithClient(client, {
    accountId: op.accountId, scope: 'msisdn', msisdn, metric: 'forwarding', payload: rules,
  });

/** Подключить PE0250. Отправляет только выигравший claimSend. */
export const sendServiceRequest = async (
  op: IForwardingOperation,
  owner: string,
  msisdn: string,
): Promise<IForwardingOperation> => {
  if (!(await ensureQuota(op, owner))) return reload(op);
  const claimed = await ops.claimSend(op.id, 'service_reserved', 'service_sending', owner);
  if (!claimed) return reload(op);
  const guard = guardOf(claimed, owner);

  let eventId: string;
  try {
    ({ eventId } = await mtsBusinessCatalogService.modifyProduct(op.accountId, msisdn, 'create', FORWARDING_SERVICE_CODE));
  } catch (error) {
    const err = errorOf(error);
    console.warn(`[mts-fwd-op] ModifyProduct ${FORWARDING_SERVICE_CODE} не принят: ${err.code ?? '-'}`);
    const rejected = mtsMutationSendOutcome(error) === 'rejected';
    const next = await ops.transition(op.id, ['service_sending'], rejected
      ? { state: 'failed', lease: null, error: err }
      : { state: 'service_unknown', lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, error: err }, guard);
    return next ?? reload(op);
  }

  // eventId пишем тем же переходом: если запись упадёт, строка останется
  // service_sending и recoverStale переведёт её в сверку — без повторной отправки.
  const next = await ops.transition(op.id, ['service_sending'], {
    state: 'service_accepted', serviceEventId: eventId, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, error: null,
  }, guard);
  if (next) {
    await bestEffort('action-request', () => mtsBusinessActionsService.create({
      eventId, accountId: op.accountId, scope: 'msisdn', msisdn, actionType: 'service_add',
      payload: { externalID: FORWARDING_SERVICE_CODE, source: 'employee_sim', operationId: op.id }, requestedBy: op.requestedBy,
    }));
    await bestEffort('audit-service-add', () => auditService.log({
      user_id: op.requestedBy,
      action: AUDIT_ACTIONS.MTS_BUSINESS_SERVICE_ADD_REQUESTED,
      details: { accountId: op.accountId, externalID: FORWARDING_SERVICE_CODE, source: 'employee_sim', operationId: op.id },
    }));
  }
  return next ?? reload(op);
};

/**
 * Итог: снимок подтверждённых правил и аудит — одной транзакцией с переходом в done
 * под поколением. Сбой записи — остаёмся в rule_confirmed, внешних вызовов нет.
 */
export const finalizeOperation = async (op: IForwardingOperation, owner: string | undefined, msisdn: string): Promise<IForwardingOperation> => {
  const rules = Array.isArray(op.confirmedRules) ? op.confirmedRules : [];
  try {
    const done = await ops.commit(op.id, ['rule_confirmed'], { state: 'done', lease: null, error: null }, guardOf(op, owner),
      async (client, row) => {
        await writeForwardingSnapshot(client, row, msisdn, rules);
        await auditService.logWithClient(client, row.kind === 'remove'
          ? {
            user_id: row.requestedBy,
            action: AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED,
            details: { accountId: row.accountId, type: 'all', outcome: 'applied', source: 'employee_sim', operationId: row.id },
          }
          : {
            user_id: row.requestedBy,
            action: AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_SET_REQUESTED,
            details: {
              accountId: row.accountId, type: row.forwardingType, timer: row.noReplyTimer, targetTail: (row.target ?? '').slice(-4),
              outcome: 'applied', source: 'employee_sim', operationId: row.id,
            },
          });
      });
    return done ?? reload(op);
  } catch (error) {
    await bestEffort('finalize', () => Promise.reject(error));
    const next = await ops.transition(op.id, ['rule_confirmed'], { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, guardOf(op, owner));
    return next ?? op;
  }
};

/** Режим достигнут без отправки/после сверки: зафиксировать правила и довести до done. */
const confirmAndFinalize = async (
  op: IForwardingOperation,
  from: readonly ForwardingOperationState[],
  owner: string | undefined,
  msisdn: string,
  rules: IMtsForwardingRule[],
): Promise<IForwardingOperation> => {
  const confirmed = await ops.transition(op.id, from, { state: 'rule_confirmed', confirmedRules: rules, error: null }, guardOf(op, owner));
  return confirmed ? finalizeOperation(confirmed, owner, msisdn) : reload(op);
};

/** Отказ POST этапа правила: 421 — повтор того же шага позже (≤3), иначе failed (с учётом частичного результата). */
const failRuleSend = async (
  claimed: IForwardingOperation,
  owner: string,
  msisdn: string,
  error: unknown,
  sendingState: 'rule_sending' | 'rule_clear_sending',
): Promise<IForwardingOperation> => {
  const err = errorOf(error);
  const guard = guardOf(claimed, owner);
  const verifying = sendingState === 'rule_clear_sending' ? 'rule_clear_verifying' : 'rule_verifying';

  if (mtsMutationSendOutcome(error) === 'unknown') {
    const next = await ops.transition(claimed.id, [sendingState], {
      state: verifying, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: err,
    }, guard);
    return next ?? reload(claimed);
  }
  if (isTransientMtsError(error) && claimed.ruleAttempts < MAX_RULE_ATTEMPTS) {
    // МТС мог ещё не «увидеть» свежую услугу/снятие; ответ-отказ = мутация не применена.
    const next = await ops.transition(claimed.id, [sendingState], {
      state: 'rule_ready', lease: null, nextCheckSeconds: RULE_RETRY_SECONDS, error: err,
    }, guard);
    return next ?? reload(claimed);
  }

  // Уже что-то сняли (confirmed_rules записаны при подтверждённом снятии) — прежней переадресации нет.
  const partial = claimed.confirmedRules != null;
  const message = sendingState === 'rule_clear_sending'
    ? `Не удалось снять текущую переадресацию: ${err.message}`
    : partial ? `Прежняя переадресация снята, новое правило МТС отклонил: ${err.message}` : err.message;
  let actual: IMtsForwardingRule[] | null = null;
  if (partial) {
    try {
      actual = await mtsBusinessCatalogService.getCallForwarding(claimed.accountId, msisdn);
    } catch (readError) {
      console.warn(`[mts-fwd-op] правила после отказа не прочитаны: ${errorOf(readError).code ?? '-'}`);
    }
  }
  const patch: ITransitionPatch = { state: 'failed', lease: null, error: { code: err.code, message } };
  if (actual) patch.confirmedRules = actual;
  const next = actual
    ? await ops.commit(claimed.id, [sendingState], patch, guard, (client, row) => writeForwardingSnapshot(client, row, msisdn, actual))
    : await ops.transition(claimed.id, [sendingState], patch, guard);
  return next ?? reload(claimed);
};

/**
 * Шаг rule_ready: читает правила и решает — режим уже достигнут (done без POST и
 * квоты), снять одно мешающее правило или поставить выбранное.
 */
export const stepRule = async (
  op: IForwardingOperation,
  owner: string,
  msisdn: string,
): Promise<IForwardingOperation> => {
  let rules: IMtsForwardingRule[];
  try {
    rules = await mtsBusinessCatalogService.getCallForwarding(op.accountId, msisdn);
  } catch (error) {
    console.warn(`[mts-fwd-op] чтение правил перед шагом не удалось: ${errorOf(error).code ?? '-'}`);
    const next = await ops.transition(op.id, ['rule_ready'], { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, guardOf(op, owner));
    return next ?? reload(op);
  }

  if (targetReached(op, rules)) return confirmAndFinalize(op, ['rule_ready'], owner, msisdn, rules);

  const conflicts = conflictingRuleTypes(rules, op.kind === 'remove' ? null : op.forwardingType);
  if (!(await ensureQuota(op, owner))) return reload(op);

  if (conflicts.length > 0) {
    const type = conflicts[0];
    const claimed = await ops.claimSend(op.id, 'rule_ready', 'rule_clear_sending', owner, `delete:${type}`);
    if (!claimed) return reload(op);
    try {
      const { eventId } = await mtsBusinessCatalogService.postCallForwarding(op.accountId, msisdn, 'delete', { forwardingType: type });
      const next = await ops.transition(op.id, ['rule_clear_sending'], {
        state: 'rule_clear_verifying', ruleEventId: eventId, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS,
        deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
      }, guardOf(claimed, owner));
      return next ?? reload(op);
    } catch (error) {
      console.warn(`[mts-fwd-op] снятие ${type} не принято: ${errorOf(error).code ?? '-'}`);
      return failRuleSend(claimed, owner, msisdn, error, 'rule_clear_sending');
    }
  }

  // kind=remove без конфликтов уже обработан targetReached; здесь — установка выбранного правила.
  const claimed = await ops.claimSend(op.id, 'rule_ready', 'rule_sending', owner, null);
  if (!claimed) return reload(op);
  try {
    const { eventId } = await mtsBusinessCatalogService.postCallForwarding(op.accountId, msisdn, 'create', {
      forwardingType: op.forwardingType,
      forwardingAddress: op.target ?? undefined,
      noReplyTimer: op.noReplyTimer ?? undefined,
    });
    const next = await ops.transition(op.id, ['rule_sending'], {
      state: 'rule_verifying', ruleEventId: eventId, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS,
      deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
    }, guardOf(claimed, owner));
    return next ?? reload(op);
  } catch (error) {
    console.warn(`[mts-fwd-op] ChangeCallForwarding не принят: ${errorOf(error).code ?? '-'}`);
    return failRuleSend(claimed, owner, msisdn, error, 'rule_sending');
  }
};

const readRules = async (
  op: IForwardingOperation,
  msisdn: string,
  quick: boolean,
  predicate: (rules: IMtsForwardingRule[]) => boolean,
): Promise<IMtsForwardingRule[] | null> => {
  if (quick) return mtsBusinessCatalogService.verifyCallForwardingWith(op.accountId, msisdn, predicate);
  try {
    const actual = await mtsBusinessCatalogService.getCallForwarding(op.accountId, msisdn);
    return predicate(actual) ? actual : null;
  } catch (error) {
    console.warn(`[mts-fwd-op] чтение правил не удалось: ${errorOf(error).code ?? '-'}`);
    return null;
  }
};

/** Не подтвердилось: срок истёк → unconfirmed, иначе следующая проверка. Под поколением. */
const postponeCheck = async (
  op: IForwardingOperation,
  verifyingState: 'rule_verifying' | 'rule_clear_verifying',
  owner: string | undefined,
): Promise<IForwardingOperation> => {
  if (op.state === 'unconfirmed') return op;
  const next = await ops.transition(op.id, [verifyingState], deadlinePassed(op)
    ? { state: 'unconfirmed', unconfirmedFrom: verifyingState, lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }
    : { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, guardOf(op, owner));
  return next ?? op;
};

/**
 * Сверка снятия (rule_clear_verifying). Подтверждено → одной транзакцией под поколением:
 * переход в rule_ready (следующее действие), снимок фактических правил, аудит снятия и
 * журнал eventId. Старое поколение → ничего не пишется.
 */
export const verifyClear = async (
  op: IForwardingOperation,
  owner: string | undefined,
  msisdn: string,
  quick: boolean,
): Promise<IForwardingOperation> => {
  const type = deleteActionType(op.ruleAction);
  if (!type) return op;
  const rules = await readRules(op, msisdn, quick, list => matchesForwardingIntent(list, 'delete', type));
  if (!rules) return postponeCheck(op, 'rule_clear_verifying', owner);

  const next = await ops.commit(op.id, ['rule_clear_verifying', 'unconfirmed'], {
    state: 'rule_ready', ruleAction: null, ruleEventId: null, resetRuleAttempts: true, confirmedRules: rules,
    unconfirmedFrom: null, lease: null, nextCheckSeconds: 0, deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
  }, guardOf(op, owner), async (client, row) => {
    await writeForwardingSnapshot(client, row, msisdn, rules);
    await auditService.logWithClient(client, {
      user_id: row.requestedBy,
      action: AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_REMOVE_REQUESTED,
      details: {
        accountId: row.accountId, type, outcome: 'applied', source: 'employee_sim',
        operationId: row.id, generation: op.sendGeneration, eventId: op.ruleEventId,
      },
    });
    if (op.ruleEventId) {
      await mtsBusinessActionsService.createCompletedWithClient(client, {
        eventId: op.ruleEventId, accountId: row.accountId, scope: 'msisdn', msisdn, actionType: 'forwarding_remove',
        payload: { type, operationId: row.id, generation: op.sendGeneration }, requestedBy: row.requestedBy,
      });
    }
  });
  return next ?? reload(op);
};

/** Сверка установки (rule_verifying): режим целиком → rule_confirmed → done. */
export const verifyRule = async (
  op: IForwardingOperation,
  owner: string | undefined,
  msisdn: string,
  quick: boolean,
): Promise<IForwardingOperation> => {
  const rules = await readRules(op, msisdn, quick, list => targetReached(op, list));
  if (!rules) return postponeCheck(op, 'rule_verifying', owner);
  return confirmAndFinalize(op, ['rule_verifying', 'unconfirmed'], owner, msisdn, rules);
};

/** Сверка подключения PE0250: активна → этап правила; отказ МТС → failed; срок истёк → unconfirmed. */
export const checkService = async (
  op: IForwardingOperation,
  owner: string | undefined,
  msisdn: string,
): Promise<IForwardingOperation> => {
  let services: IMtsService[] | null = null;
  try {
    services = await mtsBusinessCatalogService.getProductInfo(op.accountId, msisdn);
  } catch (error) {
    console.warn(`[mts-fwd-op] чтение услуг не удалось: ${errorOf(error).code ?? '-'}`);
  }
  const guard = guardOf(op, owner);

  if (services && hasForwardingService(services)) {
    const list = services;
    await bestEffort('snapshot-services', () => mtsBusinessMetricsStoreService.upsertSnapshot({
      accountId: op.accountId, scope: 'msisdn', msisdn, metric: 'product_services', payload: list,
    }));
    const next = await ops.transition(op.id, ['service_accepted', 'service_unknown', 'unconfirmed'], {
      state: 'rule_ready', unconfirmedFrom: null, lease: null, nextCheckSeconds: 0, deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
    }, guard);
    return next ?? op;
  }

  if (op.state === 'service_accepted' && op.serviceEventId) {
    try {
      const { status } = await mtsBusinessCatalogService.checkModifyProductStatus(op.accountId, msisdn, op.serviceEventId);
      if (status === 'faulted') {
        const next = await ops.transition(op.id, ['service_accepted'], {
          state: 'failed', lease: null, error: { code: 'faulted', message: 'МТС отклонил подключение услуги «Переадресация вызова»' },
        }, guard);
        return next ?? op;
      }
    } catch (error) {
      console.warn(`[mts-fwd-op] статус заявки на услугу не получен: ${errorOf(error).code ?? '-'}`);
    }
  }

  if (op.state === 'unconfirmed') return op;
  const next = await ops.transition(op.id, ['service_accepted', 'service_unknown'], deadlinePassed(op)
    ? { state: 'unconfirmed', unconfirmedFrom: op.state, lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }
    : { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, guard);
  return next ?? op;
};
