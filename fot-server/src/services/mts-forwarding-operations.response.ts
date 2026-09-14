import type { Response } from 'express';
import {
  isOperationFinal,
  sameForwardingParams,
  type ForwardingOperationState,
  type IForwardingOperation,
} from './mts-forwarding-operations.service.js';
import type { ForwardingType } from './mts-forwarding.shared.js';

// Ответы ЛК «Моя SIM» по серверной операции переадресации. Номер назначения
// наружу — только хвостом; причина отказа МТС — в mtsMessage (как в прочих ответах модуля).

export interface IForwardingOperationDto {
  id: string;
  state: ForwardingOperationState;
  final: boolean;
  type: ForwardingType;
  targetTail: string;
  timer: number | null;
  errorMessage: string | null;
  updatedAt: string;
}

export const toOperationDto = (op: IForwardingOperation): IForwardingOperationDto => ({
  id: op.id,
  state: op.state,
  final: isOperationFinal(op.state),
  type: op.forwardingType,
  targetTail: op.target.slice(-4),
  timer: op.noReplyTimer,
  errorMessage: op.lastErrorMessage,
  updatedAt: op.updatedAt,
});

const failureText = (op: IForwardingOperation): string => {
  if (op.state === 'cancelled') return 'Номер больше не закреплён за вами';
  if (op.state === 'expired') return 'МТС не подтвердил подключение. Попробуйте ещё раз';
  return op.lastErrorMessage || 'МТС отклонил запрос';
};

/**
 * done → 200 applied; failed/cancelled/expired → 422 с причиной; иначе 202 —
 * операция продолжается на сервере, клиент следит за статусом и не повторяет запрос.
 */
export const sendOperationResult = (res: Response, op: IForwardingOperation): void => {
  const data = { operationId: op.id, state: op.state, operation: toOperationDto(op) };
  if (op.state === 'done') {
    res.status(200).json({ success: true, data: { ...data, outcome: 'applied' } });
    return;
  }
  if (isOperationFinal(op.state)) {
    res.status(422).json({
      success: false,
      error: 'Не удалось включить переадресацию',
      mtsMessage: failureText(op),
      data: { ...data, outcome: 'operation_failed' },
    });
    return;
  }
  res.status(202).json({ success: true, data: { ...data, outcome: 'operation_pending' } });
};

/** У номера уже идёт операция: те же параметры — её статус, другие — 409. */
export const sendOperationConflictOrPending = (
  res: Response,
  op: IForwardingOperation,
  intent: { forwardingType: ForwardingType; target: string; noReplyTimer: number | null },
): void => {
  if (!sameForwardingParams(op, intent)) {
    res.status(409).json({
      success: false,
      error: 'Дождитесь завершения текущего подключения переадресации',
      data: { operationId: op.id, state: op.state, operation: toOperationDto(op) },
    });
    return;
  }
  sendOperationResult(res, op);
};
