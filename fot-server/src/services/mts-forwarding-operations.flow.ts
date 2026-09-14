import { mtsForwardingOperationsService as ops, type ForwardingOperationState, type IForwardingOperation } from './mts-forwarding-operations.service.js';
import {
  checkService,
  finalizeOperation,
  guardOf,
  sendServiceRequest,
  stepRule,
  verifyClear,
  verifyRule,
  UNCONFIRMED_CHECK_SECONDS,
} from './mts-forwarding-operations.runner.js';

// Оркестрация шагов операции переадресации: шаг воркера по закреплённой строке,
// сверка неподтверждённых и синхронные циклы этапа правила для контроллера.

const UNCONFIRMED_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * unconfirmed: исход внешней мутации неизвестен, номер заблокирован. Сверяем
 * без мутаций по этапу, из которого ушли; 24 ч без подтверждения → expired.
 */
export const reconcileUnconfirmed = async (op: IForwardingOperation, owner: string, msisdn: string): Promise<IForwardingOperation> => {
  if (Date.now() - new Date(op.createdAt).getTime() >= UNCONFIRMED_TTL_MS) {
    const next = await ops.transition(op.id, ['unconfirmed'], {
      state: 'expired', lease: null, error: { code: 'expired', message: 'МТС не подтвердил результат за сутки' },
    }, guardOf(op, owner));
    return next ?? op;
  }
  const from = op.unconfirmedFrom;
  let after: IForwardingOperation;
  if (from === 'rule_clear_verifying') after = await verifyClear(op, owner, msisdn, false);
  else if (from === 'rule_verifying' || (from == null && op.ruleAttempts > 0)) after = await verifyRule(op, owner, msisdn, false);
  else after = await checkService(op, owner, msisdn);
  if (after.state !== 'unconfirmed') return after;
  const next = await ops.transition(op.id, ['unconfirmed'], { lease: null, nextCheckSeconds: UNCONFIRMED_CHECK_SECONDS }, guardOf(after, owner));
  return next ?? after;
};

/** Состояния, в которых внешняя мутация сейчас не выполняется и не ждёт сверки (перепривязка → cancelled). */
const NOT_SENT_STATES: readonly ForwardingOperationState[] = ['service_reserved', 'rule_ready'];

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

  if (!msisdn || (!stillOwned && NOT_SENT_STATES.includes(op.state))) {
    const next = await ops.transition(op.id, [op.state], {
      state: 'cancelled', lease: null, error: { code: 'rebound', message: 'Номер больше не закреплён за сотрудником' },
    }, guardOf(op, owner));
    return next ?? op;
  }

  switch (op.state) {
    case 'service_reserved': return sendServiceRequest(op, owner, msisdn);
    case 'service_accepted':
    case 'service_unknown': return checkService(op, owner, msisdn);
    case 'rule_ready': return stepRule(op, owner, msisdn);
    case 'rule_clear_verifying': return verifyClear(op, owner, msisdn, false);
    case 'rule_verifying': return verifyRule(op, owner, msisdn, false);
    case 'rule_confirmed': return finalizeOperation(op, owner, msisdn);
    case 'unconfirmed': return reconcileUnconfirmed(op, owner, msisdn);
    default: {
      await ops.transition(op.id, [op.state], { lease: null }, { owner });
      return op;
    }
  }
};

/**
 * Синхронная часть для контроллера: до maxCycles циклов «шаг правила → быстрая проверка»
 * (например, снять CFU → поставить CFNRY). Дальше операцию доводит воркер.
 */
export const runRuleCyclesNow = async (
  op: IForwardingOperation,
  owner: string,
  msisdn: string,
  maxCycles: number,
): Promise<IForwardingOperation> => {
  let current = op;
  for (let cycle = 0; cycle < maxCycles && current.state === 'rule_ready'; cycle++) {
    current = await stepRule(current, owner, msisdn);
    if (current.state === 'rule_clear_verifying') current = await verifyClear(current, undefined, msisdn, true);
    else if (current.state === 'rule_verifying') current = await verifyRule(current, undefined, msisdn, true);
  }
  return current;
};
