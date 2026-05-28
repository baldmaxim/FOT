/**
 * Датированная привязка УДАЛЁНЩИКА к объекту (skud_objects) для учёта часов в ФОТ.
 *
 * Отличие от employee_skud_object_access:
 *   - employee_skud_object_access = «видимость» в сетке /skud-presence;
 *   - employee_object_attribution  = «куда отнести часы удалёнщика, когда в день
 *     НЕТ СКУД-событий». Реальный СКУД всегда приоритетнее — привязка только фолбэк.
 *
 * Историчность: effective_from / effective_to (NULL = текущая), один открытый
 * период на сотрудника. Закрытие предыдущего периода: effective_to = новый_from - 1.
 * См. миграцию 138_employee_object_attribution.sql.
 */
import { query, queryOne, withTransaction } from '../config/postgres.js';

let missingTableWarned = false;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

function warnMissingTable(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn(
    '[employee-object-attribution] table public.employee_object_attribution not found; feature disabled.',
  );
}

export interface IAttributionObject {
  object_id: string;
  object_name: string;
}

export interface IAttributionRow {
  object_id: string;
  object_name: string;
  effective_from: string;
  effective_to: string | null;
}

export interface IAttributionHistoryRow extends IAttributionRow {
  id: string;
  reason: string | null;
  created_at: string;
}

/** Привязка, активная для сотрудника на конкретную дату (point-in-time). */
export async function getAttributionObjectForEmployeeAt(
  employeeId: number,
  date: string,
): Promise<IAttributionObject | null> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
  try {
    const row = await queryOne<IAttributionObject>(
      `SELECT eoa.skud_object_id::text AS object_id,
              so.name                  AS object_name
         FROM employee_object_attribution eoa
         JOIN skud_objects so
           ON so.id = eoa.skud_object_id AND so.is_active = TRUE
        WHERE eoa.employee_id = $1
          AND eoa.effective_from <= $2::date
          AND (eoa.effective_to IS NULL OR eoa.effective_to >= $2::date)
        ORDER BY eoa.effective_from DESC
        LIMIT 1`,
      [employeeId, date],
    );
    return row;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return null;
    }
    throw err;
  }
}

/**
 * Батч-вариант для табеля «По объектам»: все строки привязки, пересекающие
 * период [startDate, endDate], сгруппированные по сотруднику. Резолвинг на
 * конкретную дату делается в памяти (resolveAttributionAt ниже).
 */
export async function listAttributionRowsForEmployees(
  employeeIds: number[],
  startDate: string,
  endDate: string,
): Promise<Map<number, IAttributionRow[]>> {
  const result = new Map<number, IAttributionRow[]>();
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return result;
  try {
    const rows = await query<{
      employee_id: number | string;
      object_id: string;
      object_name: string;
      effective_from: string;
      effective_to: string | null;
    }>(
      `SELECT eoa.employee_id,
              eoa.skud_object_id::text AS object_id,
              so.name                  AS object_name,
              eoa.effective_from::text AS effective_from,
              eoa.effective_to::text   AS effective_to
         FROM employee_object_attribution eoa
         JOIN skud_objects so
           ON so.id = eoa.skud_object_id AND so.is_active = TRUE
        WHERE eoa.employee_id = ANY($1::bigint[])
          AND eoa.effective_from <= $3::date
          AND (eoa.effective_to IS NULL OR eoa.effective_to >= $2::date)`,
      [ids, startDate, endDate],
    );
    for (const row of rows) {
      const employeeId = Number(row.employee_id);
      if (!Number.isFinite(employeeId)) continue;
      const bucket = result.get(employeeId) || [];
      bucket.push({
        object_id: row.object_id,
        object_name: row.object_name,
        effective_from: row.effective_from,
        effective_to: row.effective_to,
      });
      result.set(employeeId, bucket);
    }
    return result;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return result;
    }
    throw err;
  }
}

/** Резолв привязки на дату из батч-набора строк (для buildObjectAttendanceData). */
export function resolveAttributionAt(
  rows: IAttributionRow[] | undefined,
  date: string,
): IAttributionObject | null {
  if (!rows || rows.length === 0) return null;
  let best: IAttributionRow | null = null;
  for (const row of rows) {
    if (row.effective_from > date) continue;
    if (row.effective_to != null && row.effective_to < date) continue;
    if (!best || row.effective_from > best.effective_from) best = row;
  }
  return best ? { object_id: best.object_id, object_name: best.object_name } : null;
}

/** Полная датированная история привязок сотрудника (для UI, newest-first). */
export async function listAttributionHistoryForEmployee(
  employeeId: number,
): Promise<IAttributionHistoryRow[]> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return [];
  try {
    return await query<IAttributionHistoryRow>(
      `SELECT eoa.id::text             AS id,
              eoa.skud_object_id::text AS object_id,
              so.name                  AS object_name,
              eoa.effective_from::text AS effective_from,
              eoa.effective_to::text   AS effective_to,
              eoa.reason               AS reason,
              eoa.created_at::text     AS created_at
         FROM employee_object_attribution eoa
         JOIN skud_objects so ON so.id = eoa.skud_object_id
        WHERE eoa.employee_id = $1
        ORDER BY eoa.effective_from DESC`,
      [employeeId],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

/** Текущая (открытая) привязка сотрудника либо null. */
export async function getCurrentAttributionForEmployee(
  employeeId: number,
): Promise<IAttributionRow | null> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
  try {
    return await queryOne<IAttributionRow>(
      `SELECT eoa.skud_object_id::text AS object_id,
              so.name                  AS object_name,
              eoa.effective_from::text AS effective_from,
              eoa.effective_to::text   AS effective_to
         FROM employee_object_attribution eoa
         JOIN skud_objects so ON so.id = eoa.skud_object_id
        WHERE eoa.employee_id = $1
          AND eoa.effective_to IS NULL
        ORDER BY eoa.effective_from DESC
        LIMIT 1`,
      [employeeId],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return null;
    }
    throw err;
  }
}

/**
 * Установить новую привязку с указанной даты. В транзакции:
 * 1) закрыть текущий открытый период (effective_to = effectiveFrom - 1);
 * 2) вставить новую открытую строку (effective_to = NULL).
 * Если на effectiveFrom уже есть открытый период того же объекта — no-op.
 */
export async function setAttributionForEmployee(params: {
  employeeId: number;
  skudObjectId: string;
  effectiveFrom: string;
  reason?: string | null;
  actorUserId: string | null;
}): Promise<void> {
  const { employeeId, skudObjectId, effectiveFrom, reason, actorUserId } = params;
  await withTransaction(async client => {
    const open = await client.query<{ skud_object_id: string; effective_from: string }>(
      `SELECT skud_object_id::text AS skud_object_id, effective_from::text AS effective_from
         FROM employee_object_attribution
        WHERE employee_id = $1 AND effective_to IS NULL
        FOR UPDATE`,
      [employeeId],
    );
    const current = open.rows[0];
    // Уже привязан к этому объекту с не-позднее даты — менять нечего.
    if (current && current.skud_object_id === skudObjectId && current.effective_from <= effectiveFrom) {
      return;
    }

    if (current && current.effective_from >= effectiveFrom) {
      // Открытый период начался не раньше новой даты — это коррекция «сегодняшней»
      // привязки: заменяем строку целиком (иначе UNIQUE по effective_from конфликтует).
      await client.query(
        `DELETE FROM employee_object_attribution
          WHERE employee_id = $1 AND effective_to IS NULL`,
        [employeeId],
      );
    } else if (current) {
      // Закрываем предыдущий открытый период днём раньше новой даты.
      await client.query(
        `UPDATE employee_object_attribution
            SET effective_to = ($2::date - INTERVAL '1 day')::date,
                updated_at = now()
          WHERE employee_id = $1 AND effective_to IS NULL`,
        [employeeId, effectiveFrom],
      );
    }

    await client.query(
      `INSERT INTO employee_object_attribution
         (employee_id, skud_object_id, effective_from, effective_to, reason, created_by)
       VALUES ($1::bigint, $2::uuid, $3::date, NULL, $4, $5)`,
      [employeeId, skudObjectId, effectiveFrom, reason ?? null, actorUserId],
    );
  });
}
