import type { Response } from 'express';
import {
  isOperationFinal,
  sameForwardingParams,
  type ForwardingOperationKind,
  type ForwardingOperationState,
  type IForwardingOperation,
} from './mts-forwarding-operations.service.js';
import { RATE_LIMITED_CODE } from './mts-forwarding-operations.runner.js';
import type { ForwardingType } from './mts-forwarding.shared.js';

// Ответы ЛК «Моя SIM» по серверной операции переадресации. Номер назначения
// наружу — только хвостом; причина отказа МТС — в mtsMessage (как в прочих ответах модуля).

export interface IForwardingOperationDto {
  id: string;
  kind: ForwardingOperationKind;
  state: ForwardingOperationState;
  final: boolean;
  type: ForwardingType;
  targetTail: string | null;
  timer: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export const toOperationDto = (op: IForwardingOperation): IForwardingOperationDto => ({
  id: op.id,
  kind: op.kind,
  state: op.state,
  final: isOperationFinal(op.state),
  type: op.forwardingType,
  targetTail: op.target ? op.target.slice(-4) : null,
  timer: op.noReplyTimer,
  errorCode: op.lastErrorCode,
  errorMessage: op.lastErrorMessage,
  updatedAt: op.updatedAt,
});

const failureText = (op: IForwardingOperation): string => {
  if (op.state === 'cancelled' && op.lastErrorCode !== RATE_LIMITED_CODE) return 'Номер больше не закреплён за вами';
  if (op.state === 'expired') return 'МТС не подтвердил изменение. Попробуйте ещё раз';
  return op.lastErrorMessage || 'МТС отклонил запрос';
};

/**
 * done → 200 applied; квота исчерпана → 429; failed/cancelled/expired → 422 с причиной;
 * иначе 202 — операция продолжается на сервере, клиент следит за статусом и не повторяет запрос.
 */
export const sendOperationResult = (res: Response, op: IForwardingOperation, failTitle: string): void => {
  const data = { operationId: op.id, state: op.state, operation: toOperationDto(op) };
  if (op.state === 'done') {
    res.status(200).json({ success: true, data: { ...data, outcome: 'applied' } });
    return;
  }
  if (isOperationFinal(op.state)) {
    const rateLimited = op.lastErrorCode === RATE_LIMITED_CODE;
    res.status(rateLimited ? 429 : 422).json({
      success: false,
      error: rateLimited ? failureText(op) : failTitle,
      code: rateLimited ? 'rate_limited_forwarding' : undefined,
      mtsMessage: failureText(op),
      data: { ...data, outcome: 'operation_failed' },
    });
    return;
  }
  res.status(202).json({ success: true, data: { ...data, outcome: 'operation_pending' } });
};

/** У номера уже идёт операция: тот же запрос — её статус, другой (в т.ч. включение против отключения) — 409. */
export const sendOperationConflictOrPending = (
  res: Response,
  op: IForwardingOperation,
  intent: { kind: ForwardingOperationKind; forwardingType: ForwardingType; target: string | null; noReplyTimer: number | null },
  failTitle: string,
): void => {
  if (!sameForwardingParams(op, intent)) {
    res.status(409).json({
      success: false,
      error: 'По номеру уже выполняется изменение переадресации. Дождитесь его завершения',
      data: { operationId: op.id, state: op.state, operation: toOperationDto(op) },
    });
    return;
  }
  sendOperationResult(res, op, failTitle);
};
