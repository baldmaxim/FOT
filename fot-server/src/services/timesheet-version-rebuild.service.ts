// Фоновая пересборка официальных версий табеля после правки в обход штатного close.
//
// Админ вправе писать в закрытый период напрямую. Такая правка помечает подачу
// version_dirty (см. checkClosedTimesheetWriteAndMarkDirty), а этот воркер собирает
// новый снимок и создаёт новую редакцию — чтобы для 1С результат был таким же, как
// после «Открыть → поправить → Закрыть».
//
// Синхронно пересобирать нельзя: правка одного дня влекла бы сборку табеля всего
// отдела, и админ ждал бы её в каждом запросе.

import { query } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import {
  materializeVersion,
  TimesheetVersionEmptyRosterError,
  TimesheetVersionIncompleteError,
  type IVersionApproval,
} from './timesheet-version.service.js';

const TICK_INTERVAL_MS = 60_000;
const STARTUP_DELAY_MS = 45_000;
/** Дать серии правок «осесть»: админ обычно правит несколько дней подряд. */
const DEBOUNCE_SECONDS = 30;
const BATCH_SIZE = 20;
/** Метка живёт дольше — повод посмотреть, почему подача не собирается. */
const STUCK_WARN_MINUTES = 15;

let tickTimer: ReturnType<typeof setInterval> | null = null;
let startupTimeout: ReturnType<typeof setTimeout> | null = null;
/** Перекрытие тиков запрещено: сборка может идти дольше интервала. */
let tickInFlight = false;

interface IDirtyRow {
  id: number | string;
  department_id: string | null;
  manager_employee_id: number | string | null;
  start_date: string;
  end_date: string;
  status: string;
  version_dirty_seq: number | string;
  dirty_age_minutes: number | string;
}

function monthAnchorsInRange(startDate: string, endDate: string): string[] {
  const anchors: string[] = [];
  const cursor = new Date(`${startDate.slice(0, 8)}01T00:00:00Z`);
  const stop = new Date(`${endDate.slice(0, 8)}01T00:00:00Z`);
  while (cursor <= stop) {
    anchors.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return anchors;
}

/** Растущая задержка: одна нерешаемая подача не должна занимать лимит батча. */
async function scheduleRetry(approvalId: number, message: string): Promise<void> {
  await query(
    `UPDATE timesheet_approvals
        SET version_rebuild_attempts   = version_rebuild_attempts + 1,
            version_rebuild_after      = NOW() + (LEAST(version_rebuild_attempts + 1, 6) * interval '5 minutes'),
            version_rebuild_last_error = $2
      WHERE id = $1`,
    [approvalId, message.slice(0, 1000)],
  );
}

/**
 * Пересобирает одну подачу. Возвращает true, если версия создана заново.
 *
 * Последовательность внутри withTimesheetSnapshotTransaction: session-локи → BEGIN
 * REPEATABLE READ → SELECT FOR UPDATE → перепроверка → материализация.
 */
async function rebuildOne(row: IDirtyRow): Promise<boolean> {
  const approval: IVersionApproval = {
    id: Number(row.id),
    department_id: row.department_id,
    manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
  };
  const expectedSeq = Number(row.version_dirty_seq);

  // Состав для advisory-локов читаем ДО транзакции — как в approve/close.
  const anchors = monthAnchorsInRange(approval.start_date, approval.end_date);
  const snapshot = await query<{ employee_id: number | string }>(
    'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
    [approval.id],
  );
  const lockPairs = snapshot.flatMap(item => anchors.map(workDate => ({
    employeeId: Number(item.employee_id),
    workDate,
  })));

  return withTimesheetSnapshotTransaction(lockPairs, async client => {
    const locked = (await client.query<{
      status: string; unlocked_at: string | null;
      version_dirty_at: string | null; version_dirty_seq: number | string;
    }>(
      `SELECT status, unlocked_at, version_dirty_at, version_dirty_seq
         FROM timesheet_approvals WHERE id = $1 FOR UPDATE`,
      [approval.id],
    )).rows[0];

    if (!locked) return false;
    // Подачу успели открыть обычным способом — версию открытого табеля не создаём,
    // метку снимет штатный close вместе со своей материализацией.
    if (locked.status !== 'approved' || locked.unlocked_at != null) return false;
    // Второй инстанс, дождавшийся лока уже после первого, увидит ТОТ ЖЕ seq — по нему
    // одному отличить «задание сделано» нельзя, поэтому проверяем и саму метку.
    if (locked.version_dirty_at == null) return false;
    if (Number(locked.version_dirty_seq) !== expectedSeq) return false;

    const { created } = await materializeVersion(client, approval, 'rebuild', null);

    // Условная очистка: правка, пришедшая во время сборки, инкрементит seq — тогда
    // метка остаётся и следующий тик пересоберёт заново.
    await client.query(
      `UPDATE timesheet_approvals
          SET version_dirty_at = NULL,
              version_rebuild_attempts = 0,
              version_rebuild_after = NULL,
              version_rebuild_last_error = NULL
        WHERE id = $1 AND version_dirty_seq = $2`,
      [approval.id, expectedSeq],
    );

    return created;
  });
}

async function runRebuildCycle(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const rows = await query<IDirtyRow>(
      `SELECT id, department_id, manager_employee_id,
              start_date::text AS start_date,
              end_date::text   AS end_date,
              status, version_dirty_seq,
              EXTRACT(EPOCH FROM (NOW() - version_dirty_at)) / 60 AS dirty_age_minutes
         FROM timesheet_approvals
        WHERE version_dirty_at IS NOT NULL
          AND status = 'approved'
          AND unlocked_at IS NULL
          AND version_dirty_at <= NOW() - ($1 || ' seconds')::interval
          AND (version_rebuild_after IS NULL OR version_rebuild_after <= NOW())
        ORDER BY version_dirty_at ASC
        LIMIT $2`,
      [String(DEBOUNCE_SECONDS), BATCH_SIZE],
    );
    if (rows.length === 0) return;

    let createdCount = 0;
    let failedCount = 0;

    for (const row of rows) {
      const approvalId = Number(row.id);
      if (Number(row.dirty_age_minutes) >= STUCK_WARN_MINUTES) {
        console.warn(
          `[timesheet-version-rebuild] подача ${approvalId} висит ${Math.round(Number(row.dirty_age_minutes))} мин`,
        );
      }
      try {
        if (await rebuildOne(row)) createdCount += 1;
      } catch (err) {
        failedCount += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof TimesheetVersionIncompleteError || err instanceof TimesheetVersionEmptyRosterError) {
          console.error(`[timesheet-version-rebuild] подача ${approvalId}: ${message}`);
        } else {
          console.error(`[timesheet-version-rebuild] подача ${approvalId} — ошибка:`, err);
        }
        await scheduleRetry(approvalId, message).catch(() => { /* не роняем цикл */ });
      }
    }

    if (createdCount > 0) {
      // Иначе HR до 30 секунд видит прежнее состояние бейджа.
      invalidateCaches('timesheet-1c-status');
    }
    console.log(
      `[timesheet-version-rebuild] обработано ${rows.length}, новых редакций ${createdCount}, ошибок ${failedCount}`,
    );
  } catch (err) {
    console.error('[timesheet-version-rebuild] цикл упал:', err);
  } finally {
    tickInFlight = false;
  }
}

export function startTimesheetVersionRebuildScheduler(): void {
  if (tickTimer || startupTimeout) return;

  console.log('[timesheet-version-rebuild] started (interval: 60s)');
  startupTimeout = setTimeout(() => {
    startupTimeout = null;
    void runRebuildCycle();
  }, STARTUP_DELAY_MS);

  tickTimer = setInterval(() => {
    void runRebuildCycle();
  }, TICK_INTERVAL_MS);
}

export function stopTimesheetVersionRebuildScheduler(): void {
  if (startupTimeout) {
    clearTimeout(startupTimeout);
    startupTimeout = null;
  }
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[timesheet-version-rebuild] stopped');
  }
}

/** Для тестов и ручного прогона. */
export const __testing = { runRebuildCycle, rebuildOne };
