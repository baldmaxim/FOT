// Решения кадров по отпуску, поставленному корректировкой (миграция 311):
// «Ознакомлен», «Ознакомлен» по снятым дням и «Отказать».
//
// Все три идут под общим advisory-локом CORRECTION_LEAVE_LOCK_KEY (его же берёт сверщик) и
// заново вычисляют карточку из табеля: клиент присылает версию, которую видел, и при любом
// расхождении (день добавили, сменили тип, приложили файл) получает 409, а не решение по
// чужому составу. Отказ вдобавок вызывается внутри квотных локов (сотрудник, месяц) по всем
// месяцам карточки ±1 день — см. controllers/correction-leaves.controller.ts.

import type { PoolClient } from 'pg';
import { notificationService, type ICreateNotification, type INotification } from './notification.service.js';
import { loadClosedTimesheetLocks } from './timesheet-version.service.js';
import type { IApprovalLockInfo } from './timesheet-department-assignments.service.js';
import {
  CORRECTION_LEAVE_LOCK_KEY,
  findCardByAdjustmentId,
  isDayAcked,
  loadDayStates,
  type ICorrectionLeaveCardCore,
} from './correction-leave.service.js';
import { correctionLeaveLabel, formatLeaveDays, shortFio } from '../utils/correction-leave-format.js';

export const CARD_CHANGED_MESSAGE = 'Карточка отпуска изменилась — обновите список и повторите.';
export const REJECT_REASON_MAX_LENGTH = 500;

export class CorrectionLeaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorrectionLeaveConflictError';
  }
}

export class CorrectionLeaveClosedPeriodError extends Error {
  constructor(public readonly lock: IApprovalLockInfo) {
    super('Период закрыт');
    this.name = 'CorrectionLeaveClosedPeriodError';
  }
}

export const takeCorrectionLeaveLock = async (client: PoolClient): Promise<void> => {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [CORRECTION_LEAVE_LOCK_KEY]);
};

const normalizeIds = (ids: unknown): number[] => {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(Number).filter(id => Number.isInteger(id) && id > 0))];
};

/** Карточка по свежему табелю; набор дней и версия обязаны совпасть с тем, что видел клиент. */
async function loadExpectedCard(
  client: PoolClient,
  adjustmentIds: unknown,
  version: unknown,
): Promise<ICorrectionLeaveCardCore> {
  const ids = normalizeIds(adjustmentIds);
  if (ids.length === 0 || typeof version !== 'string' || version === '') {
    throw new CorrectionLeaveConflictError(CARD_CHANGED_MESSAGE);
  }
  const card = await findCardByAdjustmentId(client, ids[0]!);
  const sameDays = !!card
    && card.adjustment_ids.length === ids.length
    && ids.every(id => card.adjustment_ids.includes(id));
  if (!card || !sameDays || card.version !== version) {
    throw new CorrectionLeaveConflictError(CARD_CHANGED_MESSAGE);
  }
  return card;
}

/**
 * «Ознакомлен»: отметка — снимок версии каждого дня (тип + файлы). notified_at ставим,
 * если сверщик о дне ещё не сообщал: кадры его уже увидели, колокольчик не нужен.
 */
export async function acknowledgeCorrectionLeave(
  client: PoolClient,
  input: { adjustmentIds: unknown; version: unknown; userId: string },
): Promise<ICorrectionLeaveCardCore> {
  await takeCorrectionLeaveLock(client);
  const card = await loadExpectedCard(client, input.adjustmentIds, input.version);
  await client.query(
    `INSERT INTO timesheet_correction_leave_days
       (adjustment_id, employee_id, work_date, leave_status, files_sig, author_id,
        notified_at, acked_at, acked_by, acked_status, acked_files_sig)
     SELECT d.adjustment_id, $2::int, d.work_date, d.status, d.files_sig, $3::uuid,
            now(), now(), $4::uuid, d.status, d.files_sig
       FROM unnest($1::bigint[], $5::date[], $6::text[], $7::text[]) AS d(adjustment_id, work_date, status, files_sig)
     ON CONFLICT (adjustment_id) DO UPDATE SET
       employee_id = EXCLUDED.employee_id,
       work_date = EXCLUDED.work_date,
       leave_status = EXCLUDED.leave_status,
       files_sig = EXCLUDED.files_sig,
       author_id = EXCLUDED.author_id,
       notified_at = COALESCE(timesheet_correction_leave_days.notified_at, now()),
       acked_at = now(),
       acked_by = EXCLUDED.acked_by,
       acked_status = EXCLUDED.acked_status,
       acked_files_sig = EXCLUDED.acked_files_sig,
       removed_at = NULL,
       removed_kind = NULL,
       removed_seen_at = NULL,
       removed_seen_by = NULL`,
    [
      card.dayList.map(d => d.adjustment_id),
      card.employee_id,
      card.author_id,
      input.userId,
      card.dayList.map(d => d.work_date),
      card.dayList.map(d => d.status),
      card.dayList.map(d => d.files_sig),
    ],
  );
  return card;
}

/** «Ознакомлен» по дням, снятым после ознакомления. */
export async function acknowledgeRemovedCorrectionLeave(
  client: PoolClient,
  input: { adjustmentIds: unknown; userId: string },
): Promise<number[]> {
  const ids = normalizeIds(input.adjustmentIds);
  if (ids.length === 0) throw new CorrectionLeaveConflictError('Не выбраны дни.');
  await takeCorrectionLeaveLock(client);
  const res = await client.query<{ adjustment_id: number }>(
    `UPDATE timesheet_correction_leave_days
        SET removed_seen_at = now(), removed_seen_by = $2::uuid
      WHERE adjustment_id = ANY($1::bigint[])
        AND removed_at IS NOT NULL
        AND removed_seen_at IS NULL
      RETURNING adjustment_id`,
    [ids, input.userId],
  );
  if (res.rows.length === 0) throw new CorrectionLeaveConflictError('Снятие уже отмечено — обновите список.');
  return res.rows.map(row => Number(row.adjustment_id));
}

export interface IRejectPushTarget {
  userIds: string[];
  title: string;
  body: string;
  path: string;
}

export interface IRejectCorrectionLeaveResult<TTransition> {
  card: ICorrectionLeaveCardCore;
  rejectionId: number;
  transitions: TTransition[];
  notifications: INotification[];
  pushTargets: IRejectPushTarget[];
  employeeUserId: string | null;
}

const shiftIsoDay = (iso: string, delta: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};

/**
 * Пары (сотрудник, дата) для квотных локов отказа: все дни карточки и соседние дни по краям.
 * Соседний день может лежать в другом месяце — его лок не даёт серии вырасти, пока идёт отказ.
 */
export const rejectLockPairs = (card: Pick<ICorrectionLeaveCardCore, 'employee_id' | 'days' | 'start_date' | 'end_date'>) =>
  [shiftIsoDay(card.start_date, -1), ...card.days, shiftIsoDay(card.end_date, 1)]
    .map(workDate => ({ employeeId: card.employee_id, workDate }));

/** Самая ранняя дата каждого месяца: хвостовой пересчёт квоты идёт с неё. */
export const earliestDatePerMonth = (days: readonly string[]): string[] => {
  const byMonth = new Map<string, string>();
  for (const day of days) {
    const month = day.slice(0, 7);
    const current = byMonth.get(month);
    if (!current || day < current) byMonth.set(month, day);
  }
  return [...byMonth.values()].sort();
};

/**
 * «Отказать»: дни карточки удаляются из табеля, отказ — в историю, сотруднику и автору —
 * уведомление в той же транзакции. Вызывать внутри withQuotaLocks по месяцам карточки ±1 день.
 */
export async function rejectCorrectionLeaveInTx<TTransition>(
  client: PoolClient,
  input: { adjustmentIds: unknown; version: unknown; reason: string; userId: string },
  deps: { reapproveTail: (employeeId: number, workDate: string, exec: PoolClient) => Promise<TTransition[]> },
): Promise<IRejectCorrectionLeaveResult<TTransition>> {
  await takeCorrectionLeaveLock(client);
  const card = await loadExpectedCard(client, input.adjustmentIds, input.version);

  const states = await loadDayStates(client, card.adjustment_ids);
  if (card.dayList.every(day => isDayAcked(day, states.get(day.adjustment_id)))) {
    throw new CorrectionLeaveConflictError('Отпуск уже отмечен «Ознакомлен» — отказать нельзя.');
  }

  const locks = await loadClosedTimesheetLocks(
    card.days.map(workDate => ({ employeeId: card.employee_id, workDate })),
    client,
  );
  if (locks.size > 0) throw new CorrectionLeaveClosedPeriodError([...locks.values()][0]!);

  const locked = await client.query(
    'SELECT id FROM attendance_adjustments WHERE id = ANY($1::bigint[]) FOR UPDATE',
    [card.adjustment_ids],
  );
  if (locked.rows.length !== card.adjustment_ids.length) throw new CorrectionLeaveConflictError(CARD_CHANGED_MESSAGE);
  const deleted = await client.query(
    'DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[]) RETURNING id',
    [card.adjustment_ids],
  );
  if (deleted.rows.length !== card.adjustment_ids.length) throw new CorrectionLeaveConflictError(CARD_CHANGED_MESSAGE);

  const transitions: TTransition[] = [];
  for (const workDate of earliestDatePerMonth(card.days)) {
    transitions.push(...await deps.reapproveTail(card.employee_id, workDate, client));
  }

  const rejection = await client.query<{ id: number }>(
    `INSERT INTO timesheet_correction_leave_rejections
       (employee_id, leave_status, start_date, end_date, days, reason, author_id, rejected_by, reject_reason)
     VALUES ($1, $2, $3::date, $4::date, $5::date[], $6, $7::uuid, $8::uuid, $9)
     RETURNING id`,
    [card.employee_id, card.status, card.start_date, card.end_date, card.days, card.reason,
      card.author_id, input.userId, input.reason],
  );
  await client.query(
    'DELETE FROM timesheet_correction_leave_days WHERE adjustment_id = ANY($1::bigint[])',
    [card.adjustment_ids],
  );

  const who = await client.query<{ full_name: string | null; user_id: string | null }>(
    `SELECT e.full_name,
            (SELECT up.id FROM user_profiles up WHERE up.employee_id = e.id LIMIT 1) AS user_id
       FROM employees e WHERE e.id = $1`,
    [card.employee_id],
  );
  const employeeName = who.rows[0]?.full_name ?? null;
  const employeeUserId = who.rows[0]?.user_id ?? null;
  const title = 'Отпуск не принят отделом кадров';
  const body = `${correctionLeaveLabel(card.status)}: ${shortFio(employeeName)}, ${formatLeaveDays(card.days)} — `
    + `снят из табеля. Причина: ${input.reason}`;
  const pushTargets: IRejectPushTarget[] = [];
  if (employeeUserId && employeeUserId !== input.userId) {
    pushTargets.push({ userIds: [employeeUserId], title, body, path: '/employee/requests' });
  }
  // Сотрудник без учётки уведомления не получит — его получит автор корректировки.
  if (card.author_id && card.author_id !== input.userId && card.author_id !== employeeUserId) {
    pushTargets.push({ userIds: [card.author_id], title, body, path: '/timesheet' });
  }
  const items: ICreateNotification[] = pushTargets.flatMap(target => target.userIds.map(userId => ({
    userId,
    type: 'leave_request',
    title,
    body,
    metadata: { path: target.path, employeeId: card.employee_id, action: 'correction_leave_rejected' },
  })));
  const notifications = await notificationService.insertManyTx(client, items);

  return {
    card,
    rejectionId: Number(rejection.rows[0]!.id),
    transitions,
    notifications,
    pushTargets,
    employeeUserId,
  };
}
