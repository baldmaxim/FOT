/**
 * Идемпотентное создание сотрудника: журнал операций «Sigur + PG».
 *
 * Проблема, которую он закрывает: POST /api/employees создаёт карточку в Sigur,
 * а потом пишет строку в employees. Любое падение в этом окне (таймаут Sigur на
 * контрольном чтении, обрыв соединения, ошибка вставки) оставляло карточку в
 * Sigur без записи в ФОТ, а повторное нажатие кнопки создавало вторую карточку.
 *
 * Протокол:
 *   claim (ON CONFLICT DO NOTHING) → sigur_created → employee_created → done
 * Повтор с тем же operation_id продолжает ту же операцию, а не начинает новую.
 * Дополнительная страховка на случай падения ДО записи sigur_employee_id —
 * маркер FOT-OP:<operation_id> в поле description карточки Sigur: перед
 * повторным созданием ищем карточку по маркеру.
 */
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, queryOne } from '../config/postgres.js';

export type EmployeeCreateOperationStatus =
  | 'claimed'
  | 'sigur_created'
  | 'employee_created'
  | 'done'
  | 'failed';

export interface IEmployeeCreateOperation {
  operation_id: string;
  requested_by: string | null;
  payload_hash: string;
  status: EmployeeCreateOperationStatus;
  sigur_employee_id: number | null;
  employee_id: number | null;
  error_message: string | null;
}

const OPERATION_COLUMNS =
  'operation_id, requested_by, payload_hash, status, sigur_employee_id, employee_id, error_message';

export const OPERATION_MARKER_PREFIX = 'FOT-OP:';

/** Маркер операции в description карточки Sigur — по нему находим «потерянную» карточку. */
export function buildOperationMarker(operationId: string): string {
  return `${OPERATION_MARKER_PREFIX}${operationId}`;
}

/** Стабильный хэш тела: тот же ключ с другим телом — ошибка, а не повтор. */
export function hashCreatePayload(payload: Record<string, unknown>): string {
  const canonical = Object.keys(payload)
    .sort()
    .map(key => `${key}=${String(payload[key] ?? '')}`)
    .join('&');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Занимает операцию. isNew=false означает, что операция уже существует —
 * параллельный запрос или повтор; вызывающий продолжает её, а не создаёт вторую
 * карточку в Sigur.
 */
export async function claimCreateOperation(
  operationId: string,
  requestedBy: string | null,
  payloadHash: string,
): Promise<{ operation: IEmployeeCreateOperation; isNew: boolean }> {
  const inserted = await queryOne<IEmployeeCreateOperation>(
    `INSERT INTO employee_create_operations (operation_id, requested_by, payload_hash, status)
     VALUES ($1, $2, $3, 'claimed')
     ON CONFLICT (operation_id) DO NOTHING
     RETURNING ${OPERATION_COLUMNS}`,
    [operationId, requestedBy, payloadHash],
  );

  if (inserted) return { operation: inserted, isNew: true };

  const existing = await queryOne<IEmployeeCreateOperation>(
    `SELECT ${OPERATION_COLUMNS} FROM employee_create_operations WHERE operation_id = $1`,
    [operationId],
  );
  if (!existing) {
    // Возможно только при гонке с удалением строки — трактуем как новую попытку.
    throw new Error('Операция создания сотрудника не найдена после конфликта');
  }
  return { operation: existing, isNew: false };
}

export async function markSigurCreated(operationId: string, sigurEmployeeId: number): Promise<void> {
  await query(
    `UPDATE employee_create_operations
        SET sigur_employee_id = $2, status = 'sigur_created', error_message = NULL, updated_at = now()
      WHERE operation_id = $1`,
    [operationId, sigurEmployeeId],
  );
}

/** Пишется в одной транзакции со вставкой сотрудника. */
export async function markEmployeeCreatedTx(
  client: PoolClient,
  operationId: string,
  employeeId: number,
  sigurEmployeeId: number,
): Promise<void> {
  await client.query(
    `UPDATE employee_create_operations
        SET employee_id = $2, sigur_employee_id = $3, status = 'employee_created',
            error_message = NULL, updated_at = now()
      WHERE operation_id = $1`,
    [operationId, employeeId, sigurEmployeeId],
  );
}

export async function markCreateDone(operationId: string): Promise<void> {
  await query(
    `UPDATE employee_create_operations
        SET status = 'done', error_message = NULL, updated_at = now()
      WHERE operation_id = $1`,
    [operationId],
  );
}

export async function markCreateFailed(operationId: string, message: string): Promise<void> {
  await query(
    `UPDATE employee_create_operations
        SET status = 'failed', error_message = $2, updated_at = now()
      WHERE operation_id = $1`,
    [operationId, message.slice(0, 1000)],
  );
}

/** Уже созданный этой операцией сотрудник (для ответа на повтор). */
export async function findEmployeeIdByOperation(operationId: string): Promise<number | null> {
  const row = await queryOne<{ employee_id: number | null }>(
    'SELECT employee_id FROM employee_create_operations WHERE operation_id = $1',
    [operationId],
  );
  return row?.employee_id ?? null;
}

/**
 * Ищет карточку Sigur по маркеру операции. Нужна ровно в одном сценарии:
 * создание в Sigur прошло, а запись sigur_employee_id — нет (падение процесса
 * между двумя вызовами). Без этого повтор создал бы дубль.
 */
export function findSigurEmployeeIdByMarker(
  employees: Array<Record<string, unknown>>,
  operationId: string,
): number | null {
  const marker = buildOperationMarker(operationId);
  for (const employee of employees) {
    const description = employee.description ?? employee.Description ?? employee.comment;
    if (typeof description === 'string' && description.includes(marker)) {
      const rawId = employee.id ?? employee.ID ?? employee.Id;
      const id = Number(rawId);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return null;
}
