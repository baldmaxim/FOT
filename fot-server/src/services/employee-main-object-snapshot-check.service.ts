/**
 * Проверка опубликованного поколения снимков 277/279 (гейт деплоя, scripts/check-main-object-snapshot.ts).
 *
 * Проверяется активный запуск (state.active_run_id), а не последняя запись журнала:
 *  - запуск status='ok', object_hours_ready, период заканчивается вчера (МСК);
 *  - все строки обеих таблиц принадлежат активному запуску;
 *  - сотрудники основного снимка = сотрудники со списком объектов;
 *  - основной объект у каждого = первый объект списка по compareObjectHours.
 * Пустой готовый снимок валиден для приложения; для гейта — провал, если не allowEmpty.
 */
import { withReadOnlySnapshot } from '../config/postgres.js';
import { compareObjectHours, type IMainObject } from './employees-export-objects.service.js';
import { resolveSnapshotPeriod } from './employee-main-object-snapshot.service.js';

export interface ISnapshotCheckInput {
  activeRunId: number | null;
  run: { id: number; status: string; objectHoursReady: boolean; periodEnd: string } | null;
  /** Строк основного снимка / списков с run_id, отличным от активного (включая NULL). */
  foreignMainRows: number;
  foreignObjectRows: number;
  mainRows: Array<{ employeeId: number; objectId: string | null; objectName: string; hours: number }>;
  objectRows: Array<{ employeeId: number; objectId: string; objectName: string; hours: number }>;
}

export interface ISnapshotCheckReport {
  failures: string[];
  info: string[];
}

export function evaluateSnapshot(
  input: ISnapshotCheckInput,
  options: { expectedPeriodEnd: string; allowEmpty: boolean },
): ISnapshotCheckReport {
  const failures: string[] = [];
  const info: string[] = [];

  if (input.activeRunId === null) {
    failures.push('нет опубликованного поколения (state.active_run_id IS NULL)');
    return { failures, info };
  }
  if (!input.run) {
    failures.push(`активный запуск ${input.activeRunId} не найден в журнале`);
    return { failures, info };
  }
  info.push(`активный запуск ${input.run.id}: status=${input.run.status}, ready=${input.run.objectHoursReady}, period_end=${input.run.periodEnd}`);
  if (input.run.status !== 'ok') failures.push(`активный запуск в статусе ${input.run.status}, ожидается ok`);
  if (!input.run.objectHoursReady) failures.push('активный запуск без object_hours_ready');
  if (input.run.periodEnd !== options.expectedPeriodEnd) {
    failures.push(`period_end ${input.run.periodEnd}, ожидается вчера (МСК) ${options.expectedPeriodEnd}`);
  }

  if (input.foreignMainRows > 0) failures.push(`${input.foreignMainRows} строк основного снимка не принадлежат активному запуску`);
  if (input.foreignObjectRows > 0) failures.push(`${input.foreignObjectRows} строк списков объектов не принадлежат активному запуску`);

  const lists = new Map<number, IMainObject[]>();
  for (const row of input.objectRows) {
    const item: IMainObject = { objectId: row.objectId, objectName: row.objectName, hours: row.hours };
    const list = lists.get(row.employeeId);
    if (list) list.push(item);
    else lists.set(row.employeeId, [item]);
  }
  for (const list of lists.values()) list.sort(compareObjectHours);
  const mains = new Map(input.mainRows.map(row => [row.employeeId, row]));
  info.push(`основной снимок: ${mains.size} сотр.; списки: ${lists.size} сотр., ${input.objectRows.length} строк`);

  const withoutList = [...mains.keys()].filter(id => !lists.has(id));
  const withoutMain = [...lists.keys()].filter(id => !mains.has(id));
  if (withoutList.length > 0) failures.push(`${withoutList.length} сотр. есть в основном снимке, но без списка объектов (напр. ${withoutList.slice(0, 5).join(', ')})`);
  if (withoutMain.length > 0) failures.push(`${withoutMain.length} сотр. со списком объектов без основного объекта (напр. ${withoutMain.slice(0, 5).join(', ')})`);

  const mismatched: number[] = [];
  for (const [employeeId, main] of mains) {
    const first = lists.get(employeeId)?.[0];
    if (!first) continue;
    if (first.objectId !== main.objectId || first.objectName !== main.objectName || first.hours !== main.hours) {
      mismatched.push(employeeId);
    }
  }
  if (mismatched.length > 0) failures.push(`${mismatched.length} сотр.: основной объект ≠ первому объекту списка (напр. ${mismatched.slice(0, 5).join(', ')})`);

  if (input.objectRows.length === 0 && !options.allowEmpty) {
    failures.push('списки объектов пусты (для текущих данных прода не ожидается; --allow-empty, если это верно)');
  }
  return { failures, info };
}

export async function checkPublishedSnapshot(options: { allowEmpty?: boolean; now?: Date } = {}): Promise<ISnapshotCheckReport> {
  const input = await withReadOnlySnapshot(async (client): Promise<ISnapshotCheckInput> => {
    const state = (await client.query<{ active_run_id: string | number | null }>(
      'SELECT active_run_id FROM employee_main_object_snapshot_state WHERE singleton',
    )).rows[0];
    const activeRunId = state?.active_run_id != null ? Number(state.active_run_id) : null;
    if (activeRunId === null) {
      return { activeRunId, run: null, foreignMainRows: 0, foreignObjectRows: 0, mainRows: [], objectRows: [] };
    }

    const runRow = (await client.query<{ id: string | number; status: string; object_hours_ready: boolean; period_end: string }>(
      `SELECT id, status, object_hours_ready, to_char(period_end, 'YYYY-MM-DD') AS period_end
         FROM employee_main_object_snapshot_runs WHERE id = $1`,
      [activeRunId],
    )).rows[0];

    const foreign = (await client.query<{ main: string | number; objects: string | number }>(
      `SELECT (SELECT count(*) FROM employee_main_object_snapshot WHERE run_id IS DISTINCT FROM $1) AS main,
              (SELECT count(*) FROM employee_object_hours_snapshot WHERE run_id <> $1) AS objects`,
      [activeRunId],
    )).rows[0];

    const mainRows = (await client.query<{ employee_id: number | string; skud_object_id: string | null; object_name: string; hours: string }>(
      `SELECT employee_id, skud_object_id::text AS skud_object_id, object_name, hours
         FROM employee_main_object_snapshot WHERE run_id = $1`,
      [activeRunId],
    )).rows;
    const objectRows = (await client.query<{ employee_id: number | string; skud_object_id: string; object_name: string; hours: string }>(
      `SELECT employee_id, skud_object_id::text AS skud_object_id, object_name, hours
         FROM employee_object_hours_snapshot WHERE run_id = $1`,
      [activeRunId],
    )).rows;

    return {
      activeRunId,
      run: runRow
        ? { id: Number(runRow.id), status: runRow.status, objectHoursReady: runRow.object_hours_ready, periodEnd: runRow.period_end }
        : null,
      foreignMainRows: Number(foreign?.main ?? 0),
      foreignObjectRows: Number(foreign?.objects ?? 0),
      mainRows: mainRows.map(row => ({
        employeeId: Number(row.employee_id), objectId: row.skud_object_id, objectName: row.object_name, hours: Number(row.hours),
      })),
      objectRows: objectRows.map(row => ({
        employeeId: Number(row.employee_id), objectId: row.skud_object_id, objectName: row.object_name, hours: Number(row.hours),
      })),
    };
  });

  return evaluateSnapshot(input, {
    expectedPeriodEnd: resolveSnapshotPeriod(options.now).end,
    allowEmpty: options.allowEmpty === true,
  });
}
