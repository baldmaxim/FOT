import * as Sentry from '@sentry/node';
import { mtsBusinessCatalogService, type IMtsForwardingRule, type IMtsService } from './mts-business-catalog.service.js';
import { mtsBusinessActionsService } from './mts-business-actions.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { MtsBusinessApiError, isTransientMtsError, mtsMutationSendOutcome } from './mts-business-base.service.js';
import { auditService, AUDIT_ACTIONS } from './audit.service.js';
import { matchesForwardingIntent } from './mts-forwarding.shared.js';
import {
  mtsForwardingOperationsService as ops,
  type IForwardingOperation,
  type ITransitionPatch,
} from './mts-forwarding-operations.service.js';

// Шаги серверной операции переадресации — общие для контроллера «Моя SIM»
// (первый шаг синхронно, пока сотрудник ждёт ответа) и фонового воркера.
// Каждая внешняя мутация — только после выигранного claimSend; при неизвестном
// исходе дальше идёт лишь сверка чтением.

/** Услуга «Переадресация вызова (периодическая)» — без неё Foris отклоняет правило (421/3003). */
export const FORWARDING_SERVICE_CODE = 'PE0250';

export const SERVICE_STAGE_DEADLINE_SECONDS = 60 * 60;
export const RULE_STAGE_DEADLINE_SECONDS = 30 * 60;
const CHECK_INTERVAL_SECONDS = 60;
const RULE_RETRY_SECONDS = 120;
const MAX_RULE_ATTEMPTS = 3;
const UNCONFIRMED_CHECK_SECONDS = 15 * 60;
const UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Подключить PE0250. Отправляет только выигравший claimSend. */
export const sendServiceRequest = async (
  op: IForwardingOperation,
  owner: string,
  msisdn: string,
): Promise<IForwardingOperation> => {
  const claimed = await ops.claimSend(op.id, 'service_reserved', 'service_sending', owner);
  if (!claimed) return (await ops.getById(op.id)) ?? op;

  let eventId: string;
  try {
    ({ eventId } = await mtsBusinessCatalogService.modifyProduct(op.accountId, msisdn, 'create', FORWARDING_SERVICE_CODE));
  } catch (error) {
    const err = errorOf(error);
    console.warn(`[mts-fwd-op] ModifyProduct ${FORWARDING_SERVICE_CODE} не принят: ${err.code ?? '-'}`);
    const rejected = mtsMutationSendOutcome(error) === 'rejected';
    const next = await ops.transition(op.id, ['service_sending'], rejected
      ? { state: 'failed', lease: null, error: err }
      : { state: 'service_unknown', lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, error: err }, owner);
    return next ?? (await ops.getById(op.id)) ?? op;
  }

  // eventId пишем тем же переходом: если запись упадёт, строка останется
  // service_sending и recoverStale переведёт её в сверку — без повторной отправки.
  const next = await ops.transition(op.id, ['service_sending'], {
    state: 'service_accepted', serviceEventId: eventId, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, error: null,
  }, owner);
  await bestEffort('action-request', () => mtsBusinessActionsService.create({
    eventId, accountId: op.accountId, scope: 'msisdn', msisdn, actionType: 'service_add',
    payload: { externalID: FORWARDING_SERVICE_CODE, source: 'employee_sim', operationId: op.id }, requestedBy: op.requestedBy,
  }));
  await bestEffort('audit-service-add', () => auditService.log({
    user_id: op.requestedBy,
    action: AUDIT_ACTIONS.MTS_BUSINESS_SERVICE_ADD_REQUESTED,
    details: { accountId: op.accountId, externalID: FORWARDING_SERVICE_CODE, source: 'employee_sim', operationId: op.id },
  }));
  return next ?? (await ops.getById(op.id)) ?? op;
};

/**
 * Отправить правило сохранёнными параметрами. Повтор после отказа 421/3003 —
 * только когда отказал именно POST (ошибки проверки сюда не попадают).
 */
export const sendRule = async (
  op: IForwardingOperation,
  owner: string,
  msisdn: string,
): Promise<IForwardingOperation> => {
  const claimed = await ops.claimSend(op.id, 'rule_ready', 'rule_sending', owner);
  if (!claimed) return (await ops.getById(op.id)) ?? op;

  try {
    const { eventId } = await mtsBusinessCatalogService.postCallForwarding(op.accountId, msisdn, 'create', {
      forwardingType: op.forwardingType,
      forwardingAddress: op.target,
      noReplyTimer: op.noReplyTimer ?? undefined,
    });
    const next = await ops.transition(op.id, ['rule_sending'], {
      state: 'rule_verifying', ruleEventId: eventId, lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS,
      deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
    }, owner);
    return next ?? (await ops.getById(op.id)) ?? op;
  } catch (error) {
    const err = errorOf(error);
    console.warn(`[mts-fwd-op] ChangeCallForwarding не принят: ${err.code ?? '-'}`);
    let patch: ITransitionPatch;
    if (mtsMutationSendOutcome(error) === 'unknown') {
      patch = { state: 'rule_verifying', lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS, deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: err };
    } else if (isTransientMtsError(error) && claimed.ruleAttempts < MAX_RULE_ATTEMPTS) {
      // МТС мог ещё не «увидеть» только что подключённую услугу; отказ = правило не применено.
      patch = { state: 'rule_ready', lease: null, nextCheckSeconds: RULE_RETRY_SECONDS, error: err };
    } else {
      patch = { state: 'failed', lease: null, error: err };
    }
    const next = await ops.transition(op.id, ['rule_sending'], patch, owner);
    return next ?? (await ops.getById(op.id)) ?? op;
  }
};

/** Итог: снапшот правил и аудит. Сбой записи — остаёмся в rule_confirmed, внешних вызовов нет. */
export const finalizeOperation = async (op: IForwardingOperation, owner: string | undefined, msisdn: string): Promise<IForwardingOperation> => {
  const rules = Array.isArray(op.confirmedRules) ? (op.confirmedRules as IMtsForwardingRule[]) : [];
  try {
    await mtsBusinessMetricsStoreService.upsertSnapshot({
      accountId: op.accountId, scope: 'msisdn', msisdn, metric: 'forwarding', payload: rules,
    });
  } catch (error) {
    await bestEffort('snapshot-forwarding', () => Promise.reject(error));
    const next = await ops.transition(op.id, ['rule_confirmed'], { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, owner);
    return next ?? op;
  }
  await bestEffort('audit-forwarding-set', () => auditService.log({
    user_id: op.requestedBy,
    action: AUDIT_ACTIONS.MTS_BUSINESS_FORWARDING_SET_REQUESTED,
    details: {
      accountId: op.accountId, type: op.forwardingType, timer: op.noReplyTimer, targetTail: op.target.slice(-4),
      outcome: 'applied', source: 'employee_sim', operationId: op.id,
    },
  }));
  const next = await ops.transition(op.id, ['rule_confirmed'], { state: 'done', lease: null, error: null }, owner);
  return next ?? (await ops.getById(op.id)) ?? op;
};

/** Сверка правила чтением. quick — паузы 0/3/8 с (синхронный ответ сотруднику). */
export const verifyRule = async (
  op: IForwardingOperation,
  owner: string | undefined,
  msisdn: string,
  quick: boolean,
): Promise<IForwardingOperation> => {
  const intent = { forwardingType: op.forwardingType, forwardingAddress: op.target, noReplyTimer: op.noReplyTimer ?? undefined };
  let rules: IMtsForwardingRule[] | null = null;
  if (quick) {
    rules = await mtsBusinessCatalogService.verifyCallForwarding(op.accountId, msisdn, 'create', intent);
  } else {
    try {
      const actual = await mtsBusinessCatalogService.getCallForwarding(op.accountId, msisdn);
      if (matchesForwardingIntent(actual, 'create', op.forwardingType, op.target, op.noReplyTimer ?? undefined)) rules = actual;
    } catch (error) {
      console.warn(`[mts-fwd-op] чтение правил не удалось: ${errorOf(error).code ?? '-'}`);
    }
  }

  if (rules) {
    const confirmed = await ops.transition(op.id, ['rule_verifying', 'unconfirmed'], {
      state: 'rule_confirmed', confirmedRules: rules, error: null,
    }, owner);
    return confirmed ? finalizeOperation(confirmed, owner, msisdn) : ((await ops.getById(op.id)) ?? op);
  }
  if (op.state === 'unconfirmed') return op;
  const next = await ops.transition(op.id, ['rule_verifying'], deadlinePassed(op)
    ? { state: 'unconfirmed', lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }
    : { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, owner);
  return next ?? op;
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

  if (services && hasForwardingService(services)) {
    const list = services;
    await bestEffort('snapshot-services', () => mtsBusinessMetricsStoreService.upsertSnapshot({
      accountId: op.accountId, scope: 'msisdn', msisdn, metric: 'product_services', payload: list,
    }));
    const next = await ops.transition(op.id, ['service_accepted', 'service_unknown', 'unconfirmed'], {
      state: 'rule_ready', lease: null, nextCheckSeconds: 0, deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS, error: null,
    }, owner);
    return next ?? op;
  }

  if (op.state === 'service_accepted' && op.serviceEventId) {
    try {
      const { status } = await mtsBusinessCatalogService.checkModifyProductStatus(op.accountId, msisdn, op.serviceEventId);
      if (status === 'faulted') {
        const next = await ops.transition(op.id, ['service_accepted'], {
          state: 'failed', lease: null, error: { code: 'faulted', message: 'МТС отклонил подключение услуги «Переадресация вызова»' },
        }, owner);
        return next ?? op;
      }
    } catch (error) {
      console.warn(`[mts-fwd-op] статус заявки на услугу не получен: ${errorOf(error).code ?? '-'}`);
    }
  }

  if (op.state === 'unconfirmed') return op;
  const next = await ops.transition(op.id, ['service_accepted', 'service_unknown'], deadlinePassed(op)
    ? { state: 'unconfirmed', lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }
    : { lease: null, nextCheckSeconds: CHECK_INTERVAL_SECONDS }, owner);
  return next ?? op;
};

/**
 * unconfirmed: исход внешней мутации неизвестен, номер заблокирован. Сверяем
 * без мутаций; 24 ч без подтверждения → expired (номер разблокирован).
 */
export const reconcileUnconfirmed = async (op: IForwardingOperation, owner: string, msisdn: string): Promise<IForwardingOperation> => {
  if (Date.now() - new Date(op.createdAt).getTime() >= UNCONFIRMED_TTL_MS) {
    const next = await ops.transition(op.id, ['unconfirmed'], {
      state: 'expired', lease: null, error: { code: 'expired', message: 'МТС не подтвердил результат за сутки' },
    }, owner);
    return next ?? op;
  }
  // Этап правила начинался (была попытка отправки) — сверяем правило, иначе услугу.
  const after = op.ruleAttempts > 0
    ? await verifyRule(op, owner, msisdn, false)
    : await checkService(op, owner, msisdn);
  if (after.state !== 'unconfirmed') return after;
  const next = await ops.transition(op.id, ['unconfirmed'], { lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }, owner);
  return next ?? after;
};

/** Состояния, в которых внешняя мутация ещё не начиналась (перепривязка номера → cancelled). */
const NOT_SENT_STATES = ['service_reserved', 'rule_ready'] as const;

/**
 * Один шаг воркера по закреплённой строке. Перед мутацией — актуальная привязка
 * номера к сотруднику и ЛС; если сменилась, неотправленное отменяем, начатое только сверяем.
 */
export const processOperation = async (op: IForwardingOperation, owner: string): Promise<IForwardingOperation> => {
  const binding = await ops.getNumberBinding(op.msisdnHash);
  const msisdn = binding?.msisdn ?? null;
  const stillOwned = Boolean(binding)
    && binding?.employeeId === op.employeeId
    && (binding?.accountId == null || binding.accountId === op.accountId);

  if (!msisdn || (!stillOwned && (NOT_SENT_STATES as readonly string[]).includes(op.state))) {
    const next = await ops.transition(op.id, [op.state], {
      state: 'cancelled', lease: null, error: { code: 'rebound', message: 'Номер больше не закреплён за сотрудником' },
    }, owner);
    return next ?? op;
  }

  switch (op.state) {
    case 'service_reserved': return sendServiceRequest(op, owner, msisdn);
    case 'service_accepted':
    case 'service_unknown': return checkService(op, owner, msisdn);
    case 'rule_ready': return sendRule(op, owner, msisdn);
    case 'rule_verifying': return verifyRule(op, owner, msisdn, false);
    case 'rule_confirmed': return finalizeOperation(op, owner, msisdn);
    case 'unconfirmed': return reconcileUnconfirmed(op, owner, msisdn);
    default: {
      await ops.transition(op.id, [op.state], { lease: null }, owner);
      return op;
    }
  }
};
