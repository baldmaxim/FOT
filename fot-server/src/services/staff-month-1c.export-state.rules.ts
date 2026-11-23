/**
 * Статусы выгрузки «сотрудников месяца» в ЗУП3 — чистые правила, без БД.
 *
 * Состояние пары «сотрудник + месяц + половина» — тройка present / preliminary / content_hash. Меняется тройка — новая
 * ревизия (монотонная по паре); одинаковая пересборка ревизию не меняет. Сотрудник пропал из половины — ревизия-надгробие
 * (present = false, хеша нет). 1С подтверждает ревизию (ACK), статус — текущая ревизия против последней подтверждённой:
 * возврат данных к прежнему виду — новая ревизия, и прежний ACK её не закрывает.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../utils/canonical-json.js';

export type StaffMonthExportState = 'not_ready' | 'ready' | 'exported' | 'changed';

export const STAFF_MONTH_EXPORT_STATES: readonly StaffMonthExportState[] = ['not_ready', 'ready', 'exported', 'changed'];

export interface IStaffMonthState {
  revision: number;
  present: boolean;
  preliminary: boolean;
  /** sha256 строки; у надгробия null. */
  contentHash: string | null;
}

export interface IStaffMonthAck {
  revision: number;
  ackedAt: string;
  documentRef: string | null;
}

/** sha256 канонического JSON строки (порядок ключей не важен). */
export const staffMonthRowHash = (row: unknown): string => createHash('sha256').update(canonicalJson(row)).digest('hex');

/** Новые ревизии после сборки: строки снимка против текущих состояний пары. */
export const nextStaffMonthRevisions = (
  current: ReadonlyMap<number, IStaffMonthState>,
  rows: ReadonlyArray<{ employeeId: number; preliminary: boolean; contentHash: string }>,
): Map<number, IStaffMonthState> => {
  const next = new Map<number, IStaffMonthState>();
  const seen = new Set<number>();
  for (const row of rows) {
    seen.add(row.employeeId);
    const state = current.get(row.employeeId);
    if (state && state.present && state.preliminary === row.preliminary && state.contentHash === row.contentHash) continue;
    next.set(row.employeeId, {
      revision: (state?.revision ?? 0) + 1,
      present: true,
      preliminary: row.preliminary,
      contentHash: row.contentHash,
    });
  }
  for (const [employeeId, state] of current) {
    if (seen.has(employeeId) || !state.present) continue;
    next.set(employeeId, { revision: state.revision + 1, present: false, preliminary: false, contentHash: null });
  }
  return next;
};

/**
 * Статус пары: null — не показывать (надгробие, которое 1С не получала, или его удаление уже подтверждено).
 * Предварительная строка — «не готов», даже если раньше выгружалась.
 */
export const staffMonthExportState = (
  state: IStaffMonthState | undefined,
  lastAck: IStaffMonthAck | undefined,
): StaffMonthExportState | null => {
  if (!state) return null;
  if (state.present && state.preliminary) return 'not_ready';
  if (!lastAck) return state.present ? 'ready' : null;
  if (lastAck.revision === state.revision) return state.present ? 'exported' : null;
  return 'changed';
};

export type StaffMonthAckRejection = 'not_found' | 'hash_mismatch' | 'not_ready';

/** Можно ли подтвердить ревизию: она выдавалась, хеш тот же, не предварительная. */
export const checkStaffMonthAck = (
  revision: IStaffMonthState | undefined,
  contentHash: string | null,
): StaffMonthAckRejection | null => {
  if (!revision) return 'not_found';
  if ((revision.contentHash ?? null) !== (contentHash ?? null)) return 'hash_mismatch';
  if (revision.present && revision.preliminary) return 'not_ready';
  return null;
};
