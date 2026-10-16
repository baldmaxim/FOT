// Сверщик отпусков корректировкой (миграция 311): уведомления кадрам — по разнице между
// тем, что сейчас видно во вкладке (loadVisibleDays), и тем, о чём кадрам уже сообщили.
//
// Почему сверка, а не хуки в путях записи: день отпуска меняют десяток путей (день, массовая
// правка, объектный режим, supersede, удаление, файлы, отмена перекрывающего заявления).
// Сверка ловит их все и использует ровно те же фильтры, что и список.
//
// Один прогон — одна транзакция под общим локом кадровых решений: отметки состояния и
// уведомления в БД коммитятся вместе (insertManyTx). Упали — откат, повтор на следующем тике.
// Push и realtime — после коммита, best effort.

import * as Sentry from '@sentry/node';
import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import { notificationService, type ICreateNotification, type INotification } from './notification.service.js';
import { pushService } from './push.service.js';
import { emitDomainChange } from './realtime-broadcast.service.js';
import {
  CORRECTION_LEAVE_LOCK_KEY,
  HR_VACATIONS_PATH,
  isCorrectionLeaveStatus,
  listHrRecipientIds,
  loadVisibleDays,
  normalizeDayState,
  type IDayHrState,
  type IVisibleLeaveDay,
} from './correction-leave.service.js';
import { correctionLeaveLabel, formatLeaveDays, shortFio } from '../utils/correction-leave-format.js';

const TICK_MS = 20_000;
const STARTUP_DELAY_MS = 30_000;

export type ReconcileEventKind = 'added' | 'type_changed' | 'files_changed' | 'removed';

export interface IReconcileEvent {
  kind: ReconcileEventKind;
  employeeId: number;
  status: string;
  oldStatus?: string;
  authorId: string | null;
  workDate: string;
  removedKind?: 'deleted' | 'status_changed';
}

export interface IReconcileResult {
  seeded: boolean;
  events: IReconcileEvent[];
  changed: number;
  notifications: INotification[];
  pushes: Array<{ userIds: string[]; title: string; body: string }>;
  hrRecipients: string[];
}

const INSERT_STATE_SQL = `
  INSERT INTO timesheet_correction_leave_days
    (adjustment_id, employee_id, work_date, leave_status, files_sig, author_id, notified_at)
  VALUES ($1, $2, $3::date, $4, $5, $6::uuid, now())
  ON CONFLICT (adjustment_id) DO UPDATE SET
    employee_id = EXCLUDED.employee_id, work_date = EXCLUDED.work_date,
    leave_status = EXCLUDED.leave_status, files_sig = EXCLUDED.files_sig, author_id = EXCLUDED.author_id,
    notified_at = now(), acked_at = NULL, acked_by = NULL, acked_status = NULL, acked_files_sig = NULL,
    removed_at = NULL, removed_kind = NULL, removed_seen_at = NULL, removed_seen_by = NULL`;

const insertState = (client: PoolClient, day: IVisibleLeaveDay) => client.query(INSERT_STATE_SQL, [
  day.adjustment_id, day.employee_id, day.work_date, day.status, day.files_sig, day.author_id,
]);

const clearAck = 'acked_at = NULL, acked_by = NULL, acked_status = NULL, acked_files_sig = NULL';

/** Разница «видно сейчас» ↔ «состояние кадров» → события. Пишет состояние в той же транзакции. */
export async function diffAndApply(client: PoolClient, seeding: boolean): Promise<{ events: IReconcileEvent[]; changed: number }> {
  const visible = await loadVisibleDays(client);
  const visibleIds = visible.map(day => day.adjustment_id);
  const stateRes = await client.query<IDayHrState>(
    `SELECT * FROM timesheet_correction_leave_days
      WHERE removed_at IS NULL OR adjustment_id = ANY($1::bigint[])
      FOR UPDATE`,
    [visibleIds],
  );
  const states = new Map(stateRes.rows.map(row => {
    const state = normalizeDayState(row);
    return [state.adjustment_id, state] as const;
  }));
  const events: IReconcileEvent[] = [];
  let changed = 0;
  const event = (kind: ReconcileEventKind, day: IVisibleLeaveDay, extra: Partial<IReconcileEvent> = {}) => {
    if (!seeding) events.push({ kind, employeeId: day.employee_id, status: day.status, authorId: day.author_id, workDate: day.work_date, ...extra });
  };

  for (const day of visible) {
    const state = states.get(day.adjustment_id);
    if (!state || state.removed_at) {
      await insertState(client, day);
      event('added', day);
      changed += 1;
      continue;
    }
    if (state.leave_status !== day.status) {
      await client.query(
        `UPDATE timesheet_correction_leave_days
            SET leave_status = $2, files_sig = $3, author_id = $4::uuid, notified_at = now(), ${clearAck}
          WHERE adjustment_id = $1`,
        [day.adjustment_id, day.status, day.files_sig, day.author_id],
      );
      event('type_changed', day, { oldStatus: state.leave_status });
      changed += 1;
      continue;
    }
    if (state.files_sig !== day.files_sig) {
      const wasAcked = !!state.acked_at;
      await client.query(
        `UPDATE timesheet_correction_leave_days
            SET files_sig = $2, author_id = $3::uuid${wasAcked ? `, ${clearAck}` : ''}
          WHERE adjustment_id = $1`,
        [day.adjustment_id, day.files_sig, day.author_id],
      );
      if (wasAcked) event('files_changed', day);
      changed += 1;
      continue;
    }
    if (state.author_id !== day.author_id) {
      await client.query(
        'UPDATE timesheet_correction_leave_days SET author_id = $2::uuid WHERE adjustment_id = $1',
        [day.adjustment_id, day.author_id],
      );
    }
  }

  const visibleSet = new Set(visibleIds);
  const gone = [...states.values()].filter(state => !state.removed_at && !visibleSet.has(state.adjustment_id));
  if (gone.length > 0) {
    const rows = await client.query<{ id: number; source_type: string; status: string }>(
      'SELECT id, source_type, status FROM attendance_adjustments WHERE id = ANY($1::bigint[])',
      [gone.map(state => state.adjustment_id)],
    );
    const current = new Map(rows.rows.map(row => [Number(row.id), row]));
    for (const state of gone) {
      const row = current.get(state.adjustment_id);
      const removedKind = !row
        ? 'deleted' as const
        : (row.source_type !== 'manual' || !isCorrectionLeaveStatus(row.status)) ? 'status_changed' as const : null;
      changed += 1;
      // Ознакомленный день сняли или сменили на не-отпуск — кадрам нужно убрать его из 1С.
      if (state.acked_at && removedKind) {
        await client.query(
          `UPDATE timesheet_correction_leave_days
              SET removed_at = now(), removed_kind = $2, ${clearAck}
            WHERE adjustment_id = $1`,
          [state.adjustment_id, removedKind],
        );
        if (!seeding) {
          events.push({
            kind: 'removed', employeeId: state.employee_id, status: state.leave_status,
            authorId: state.author_id, workDate: state.work_date, removedKind,
          });
        }
      } else {
        // Не ознакомлен (в т.ч. отказ кадров) или день покрыло заявление / сотрудник стал
        // рабочим — отпуск оформлен иначе, сообщать нечего.
        await client.query('DELETE FROM timesheet_correction_leave_days WHERE adjustment_id = $1', [state.adjustment_id]);
      }
    }
  }
  return { events, changed };
}

interface INotificationDraft { title: string; body: string; authorId: string | null; employeeId: number; kind: ReconcileEventKind }

/** События → уведомления: одно на (вид, сотрудник, тип, автор), даты — диапазонами. */
export function buildNotificationDrafts(
  events: readonly IReconcileEvent[],
  names: { employees: Map<number, string | null>; profiles: Map<string, string | null> },
): INotificationDraft[] {
  const groups = new Map<string, IReconcileEvent[]>();
  for (const ev of events) {
    const key = [ev.kind, ev.employeeId, ev.status, ev.oldStatus ?? '', ev.authorId ?? '', ev.removedKind ?? ''].join('|');
    groups.set(key, [...(groups.get(key) ?? []), ev]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const fio = shortFio(names.employees.get(first.employeeId)) || `#${first.employeeId}`;
    const author = first.authorId ? shortFio(names.profiles.get(first.authorId)) : '';
    const dates = formatLeaveDays(group.map(ev => ev.workDate));
    const label = correctionLeaveLabel(first.status);
    // shortFio уже заканчивается точкой инициалов — свою не ставим.
    const by = author ? ` Автор корректировки: ${author}` : '';
    switch (first.kind) {
      case 'added':
        return { ...first, title: 'Отпуск корректировкой табеля', body: `${label}: ${fio}, ${dates}.${by}` };
      case 'type_changed':
        return {
          ...first,
          title: 'Изменён тип отпуска в табеле',
          body: `${fio}: ${correctionLeaveLabel(first.oldStatus ?? '')} → ${label}, ${dates}.${by}`,
        };
      case 'files_changed':
        return { ...first, title: 'Изменены файлы отпуска', body: `${label}: ${fio}, ${dates} — файлы изменены после ознакомления.${by}` };
      case 'removed':
        return {
          ...first,
          title: 'Снят ознакомленный отпуск',
          body: `${label}: ${fio}, ${dates} — ${first.removedKind === 'deleted' ? 'удалён из табеля' : 'в табеле стоит другой статус'}.`,
        };
    }
  });
}

async function loadNames(client: PoolClient, events: readonly IReconcileEvent[]) {
  const employeeIds = [...new Set(events.map(ev => ev.employeeId))];
  const profileIds = [...new Set(events.map(ev => ev.authorId).filter((id): id is string => !!id))];
  const employees = employeeIds.length > 0
    ? (await client.query<{ id: number; full_name: string | null }>(
      'SELECT id, full_name FROM employees WHERE id = ANY($1::int[])', [employeeIds])).rows
    : [];
  const profiles = profileIds.length > 0
    ? (await client.query<{ id: string; full_name: string | null }>(
      'SELECT id, full_name FROM user_profiles WHERE id = ANY($1::uuid[])', [profileIds])).rows
    : [];
  return {
    employees: new Map(employees.map(row => [Number(row.id), row.full_name])),
    profiles: new Map(profiles.map(row => [row.id, row.full_name])),
  };
}

/** Один прогон. null — лок занят (идёт решение кадров или другой прогон). */
export async function runCorrectionLeaveReconcileOnce(): Promise<IReconcileResult | null> {
  return withTransaction(async (client) => {
    const lock = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok',
      [CORRECTION_LEAVE_LOCK_KEY],
    );
    if (!lock.rows[0]?.ok) return null;

    const meta = await client.query<{ seeded_at: string | null }>(
      'SELECT seeded_at FROM timesheet_correction_leave_reconcile WHERE id = true FOR UPDATE',
    );
    // Первый прогон после миграции: существующие отпуска — в состояние, без колокольчиков.
    const seeding = !meta.rows[0]?.seeded_at;
    const { events, changed } = await diffAndApply(client, seeding);
    if (seeding) {
      await client.query(
        `INSERT INTO timesheet_correction_leave_reconcile (id, seeded_at) VALUES (true, now())
         ON CONFLICT (id) DO UPDATE SET seeded_at = now()`,
      );
    }

    let notifications: INotification[] = [];
    const pushes: IReconcileResult['pushes'] = [];
    const hrRecipients = changed > 0 ? await listHrRecipientIds(client) : [];
    if (events.length > 0 && hrRecipients.length > 0) {
      const drafts = buildNotificationDrafts(events, await loadNames(client, events));
      const items: ICreateNotification[] = [];
      for (const draft of drafts) {
        // Автор своей же правки колокольчик не получает (кадровик, поставивший отпуск сам).
        const userIds = hrRecipients.filter(id => draft.kind === 'removed' || id !== draft.authorId);
        if (userIds.length === 0) continue;
        pushes.push({ userIds, title: draft.title, body: draft.body });
        for (const userId of userIds) {
          items.push({
            userId,
            type: 'leave_request',
            title: draft.title,
            body: draft.body,
            metadata: { path: HR_VACATIONS_PATH, employeeId: draft.employeeId, action: `correction_leave_${draft.kind}` },
          });
        }
      }
      notifications = await notificationService.insertManyTx(client, items);
    }
    return { seeded: seeding, events, changed, notifications, pushes, hrRecipients };
  });
}

/** После коммита: сокет новых уведомлений, push и обновление вкладки у кадров. */
async function publishReconcileEffects(result: IReconcileResult): Promise<void> {
  if (result.notifications.length > 0) await notificationService.emitInserted(result.notifications);
  for (const push of result.pushes) {
    await pushService.sendGenericNotification(push.userIds, push.title, push.body, { path: HR_VACATIONS_PATH })
      .catch(err => console.warn('[correction-leave] push error:', err instanceof Error ? err.message : err));
  }
  if (result.changed > 0) {
    emitDomainChange({
      event: 'leave_request:changed',
      targetUserIds: result.hrRecipients,
      payload: { action: 'correction_leave' },
    });
  }
}

let timer: NodeJS.Timeout | null = null;
let startupTimeout: NodeJS.Timeout | null = null;
let ticking = false;
// Тик раз в 20 с: одну и ту же ошибку (например, миграция 311 ещё не применена) шлём в Sentry
// один раз, а не каждые 20 секунд.
let lastReportedError: string | null = null;

const tick = async (): Promise<void> => {
  if (ticking) return;
  ticking = true;
  try {
    const result = await runCorrectionLeaveReconcileOnce();
    if (result) {
      if (result.seeded) console.log(`[correction-leave] первый прогон: засеяно без уведомлений, дней ${result.changed}`);
      await publishReconcileEffects(result);
    }
    lastReportedError = null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[correction-leave] ошибка сверщика:', message);
    if (message !== lastReportedError) {
      lastReportedError = message;
      Sentry.captureException(error, { tags: { job: 'correction-leave-reconcile' } });
    }
  } finally {
    ticking = false;
  }
};

/** Сразу после решения кадров или правки отпуска: не ждём тика. */
export function kickCorrectionLeaveReconcile(): void {
  void tick();
}

export function startCorrectionLeaveReconcileWorker(): void {
  if (timer || startupTimeout) return;
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void tick();
  }, STARTUP_DELAY_MS);
  startupTimeout.unref();
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref();
}

export function stopCorrectionLeaveReconcileWorker(): void {
  if (startupTimeout) clearTimeout(startupTimeout);
  if (timer) clearInterval(timer);
  startupTimeout = null;
  timer = null;
}
