// Единый ответ на попытку записи в закрытый табель.
//
// Раньше текст был продублирован в timesheet.controller и correction-approval, а
// leave-requests и team-management отвечали своими формулировками и вовсе без машинного
// кода. Для 1С и для фронта важно обратное: один статус, один код, один текст —
// независимо от того, каким путём пользователь попытался изменить закрытый период.

import type { Response } from 'express';
import { canToggleTimesheetLock } from './timesheet-lock-toggle.js';

/** Машинный код закрытого периода. Раньше 409 приходил без code вообще. */
export const TIMESHEET_PERIOD_CLOSED = 'TIMESHEET_PERIOD_CLOSED';

/** Минимум, который нужен для текста: статус подачи и её границы. */
export interface IClosedPeriodLock {
  status: string;
  start_date: string;
  end_date: string;
}

type LockToggleUser = { is_admin?: boolean | null; role_code?: string | null } | null | undefined;

/**
 * Текст 409. Подсказку про «Открыть табель» добавляем только тем, кто действительно
 * может снять замок (админ и hr): руководителю бессмысленно советовать кнопку,
 * которой он у себя не увидит.
 */
export function closedPeriodMessage(lock: IClosedPeriodLock, user?: LockToggleUser): string {
  const state = lock.status === 'approved' ? 'утверждён' : 'на проверке';
  const base = `Период ${lock.start_date} – ${lock.end_date} уже ${state}. Редактирование закрыто.`;
  if (!canToggleTimesheetLock(user)) return base;
  return `${base} Откройте табель кнопкой «Открыть табель», внесите правки и закройте заново.`;
}

/** Готовый 409 для закрытого периода. */
export function failClosedPeriod(res: Response, lock: IClosedPeriodLock, user?: LockToggleUser): void {
  res.status(409).json({
    success: false,
    error: closedPeriodMessage(lock, user),
    code: TIMESHEET_PERIOD_CLOSED,
  });
}
