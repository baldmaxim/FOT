/**
 * Пересчёт approval_status обязательных суббот (count-модель графика
 * expected_saturdays_per_month). Использует ОБЩИЙ расчёт computeReapprovalTransitions —
 * ту же логику, что и «Обновить» в табеле.
 *
 * Режимы:
 *  - dry-run (по умолчанию): печатает планируемые переходы, НИЧЕГО не пишет;
 *  - --apply: применяет переходы. Если заданы --expect-*, набор переходов обязан совпасть
 *    с ожиданием ровно — иначе аварийное завершение без единой записи;
 *  - --repair-id=<id>: АТОМАРНЫЙ ремонт одной строки. Откат решения (rejected/approved →
 *    pending), расчёт и применение происходят в ОДНОЙ транзакции под advisory-lock квоты;
 *    при любом несовпадении — ROLLBACK, строка остаётся в исходном состоянии.
 *
 * Тронет только auto_approved/pending; решения руководителя (approved/rejected) расчёт не
 * пересматривает, строки закрытых подач табеля (submitted/approved) исключаются.
 *
 * Скоуп: по умолчанию — сотрудники whitelist-отделов
 * (correction_approval_required_department_ids). Сузить:
 *   --department-id=<uuid>   состав отдела за период (как в табеле)
 *   --employee-id=<id>       конкретный сотрудник (можно повторять)
 * Заданы оба — берётся пересечение; пустое пересечение = аварийное завершение.
 *
 * Примеры:
 *   npx tsx scripts/backfill-mandatory-saturday-approval.ts 2026-07-01 2026-07-31
 *   npx tsx scripts/backfill-mandatory-saturday-approval.ts 2026-07-16 2026-07-31 --department-id=<uuid>
 *   npx tsx scripts/backfill-mandatory-saturday-approval.ts 2026-07-18 2026-07-18 \
 *     --employee-id=6006 --repair-id=1085379 \
 *     --expect-id=1085379 --expect-from=pending --expect-to=auto_approved --apply
 */
import { query, withTransaction } from '../src/config/postgres.js';
import {
  computeReapprovalTransitions,
  reapproveAdjustmentsForRange,
  quotaLockKeys,
  type IReapprovalTransition,
} from '../src/controllers/timesheet.controller.js';
import { correctionApprovalSettingsService } from '../src/services/correction-approval-settings.service.js';
import { listEmployeeIdsAssignedToDepartmentPeriod } from '../src/services/timesheet-department-assignments.service.js';

const TAG = '[backfill-mandatory-saturday]';

class RepairAbort extends Error {}

const readFlag = (args: string[], name: string): string | null => {
  const prefix = `--${name}=`;
  const hit = args.find(a => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
};

const readFlagAll = (args: string[], name: string): string[] => {
  const prefix = `--${name}=`;
  return args.filter(a => a.startsWith(prefix)).map(a => a.slice(prefix.length));
};

const printTransitions = async (transitions: IReapprovalTransition[]): Promise<void> => {
  const byKind = new Map<string, number>();
  for (const t of transitions) {
    const k = `${t.from} -> ${t.to}`;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log(`${TAG} планируемые переходы (${transitions.length}):`);
  for (const [k, n] of byKind) console.log(`${TAG}   ${k}: ${n}`);

  const detail = await query<{ id: number | string; work_date: string; last_name: string; first_name: string; status: string }>(
    `SELECT aa.id, aa.work_date::text AS work_date, aa.status, e.last_name, e.first_name
       FROM attendance_adjustments aa JOIN employees e ON e.id = aa.employee_id
      WHERE aa.id = ANY($1::bigint[])
      ORDER BY e.last_name, aa.work_date`,
    [transitions.map(t => t.id)],
  );
  const toMap = new Map(transitions.map(t => [Number(t.id), t]));
  for (const d of detail) {
    const t = toMap.get(Number(d.id));
    console.log(`${TAG}   id=${d.id} ${d.last_name} ${d.first_name} ${String(d.work_date).slice(0, 10)} ${d.status}: ${t?.from} -> ${t?.to}`);
  }
};

/**
 * Сверка набора переходов с ожиданием (--expect-*). Возвращает текст ошибки или null.
 * Пустое ожидание = проверка не запрашивалась.
 */
const checkExpectation = (
  transitions: IReapprovalTransition[],
  expect: { id: number | null; from: string | null; to: string | null },
): string | null => {
  if (expect.id === null && expect.from === null && expect.to === null) return null;
  if (transitions.length !== 1) {
    return `ожидался ровно один переход, получено ${transitions.length}`;
  }
  const t = transitions[0]!;
  if (expect.id !== null && Number(t.id) !== expect.id) {
    return `ожидался id=${expect.id}, получен id=${t.id}`;
  }
  if (expect.from !== null && t.from !== expect.from) {
    return `ожидался переход из '${expect.from}', получен из '${t.from}'`;
  }
  if (expect.to !== null && t.to !== expect.to) {
    return `ожидался переход в '${expect.to}', получен в '${t.to}'`;
  }
  return null;
};

/**
 * Атомарный ремонт одной строки. Всё в одной транзакции под advisory-lock квоты:
 * прочитать FOR UPDATE → сверить → откатить решение в pending → рассчитать → сверить с
 * ожиданием → применить. Любое несовпадение = ROLLBACK (строка остаётся как была).
 */
const repairSingleRow = async (params: {
  repairId: number;
  startDate: string;
  endDate: string;
  employeeIds: number[];
  expect: { id: number | null; from: string | null; to: string | null };
  apply: boolean;
}): Promise<void> => {
  const { repairId, startDate, endDate, employeeIds, expect, apply } = params;
  try {
    await withTransaction(async client => {
      const row = (await client.query<{
        id: string; employee_id: number; work_date: string; status: string;
        hours_override: string | null; source_type: string; source_id: string; approval_status: string;
      }>(
        `SELECT id, employee_id, work_date::text AS work_date, status, hours_override,
                source_type, source_id, approval_status
           FROM attendance_adjustments WHERE id = $1 FOR UPDATE`,
        [repairId],
      )).rows[0];
      if (!row) throw new RepairAbort(`строка id=${repairId} не найдена`);

      const [empKey, monthKey] = quotaLockKeys(Number(row.employee_id), String(row.work_date));
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [empKey, monthKey]);

      console.log(`${TAG} ремонт id=${row.id}: employee=${row.employee_id} date=${row.work_date} `
        + `status=${row.status} source=${row.source_type}/${row.source_id} hours=${row.hours_override} `
        + `approval=${row.approval_status}`);

      if (employeeIds.length > 0 && !employeeIds.includes(Number(row.employee_id))) {
        throw new RepairAbort(`сотрудник ${row.employee_id} вне заданного скоупа`);
      }
      if (String(row.work_date) < startDate || String(row.work_date) > endDate) {
        throw new RepairAbort(`дата ${row.work_date} вне диапазона ${startDate}..${endDate}`);
      }
      if (expect.from !== null && row.approval_status !== expect.from
          && !(expect.from === 'pending' && (row.approval_status === 'rejected' || row.approval_status === 'approved'))) {
        throw new RepairAbort(`исходный approval_status='${row.approval_status}' не совпал с ожиданием`);
      }

      // Откат решения внутри той же транзакции: расчёт видит строку уже как pending.
      if (row.approval_status === 'rejected' || row.approval_status === 'approved') {
        await client.query(
          `UPDATE attendance_adjustments
              SET approval_status = 'pending', approved_by = NULL, approved_at = NULL,
                  approval_comment = NULL, updated_at = NOW()
            WHERE id = $1`,
          [repairId],
        );
        console.log(`${TAG} решение откачено в pending (внутри транзакции)`);
      }

      const transitions = await computeReapprovalTransitions(
        [Number(row.employee_id)], startDate, endDate, client,
      );
      const foreign = transitions.filter(t => Number(t.id) !== repairId);
      if (foreign.length > 0) {
        throw new RepairAbort(`расчёт затрагивает чужие строки: ${foreign.map(t => t.id).join(', ')}`);
      }
      const mismatch = checkExpectation(transitions, expect);
      if (mismatch) throw new RepairAbort(mismatch);

      const target = transitions[0]!;
      console.log(`${TAG} переход: id=${target.id} ${target.from} -> ${target.to} (${target.workDate})`);

      if (!apply) throw new RepairAbort('DRY-RUN — откатываем транзакцию, ничего не записано');

      await client.query(
        `UPDATE attendance_adjustments SET approval_status = $2, updated_at = NOW() WHERE id = $1`,
        [repairId, target.to],
      );
      await client.query(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details)
         VALUES (NULL, 'UPDATE_TIMESHEET_ENTRY', 'attendance_adjustment', $1, $2::jsonb)`,
        [String(repairId), JSON.stringify({
          action: 'quota_repair_script',
          employee_id: Number(row.employee_id),
          work_date: String(row.work_date),
          from: target.from,
          to: target.to,
          previous_approval_status: row.approval_status,
        })],
      );
      console.log(`${TAG} применено: id=${repairId} → ${target.to}`);
    });
  } catch (err) {
    if (err instanceof RepairAbort) {
      console.log(`${TAG} ROLLBACK: ${err.message}`);
      return;
    }
    throw err;
  }
};

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const startDate = dates[0] ?? '2026-07-01';
  const endDate = dates[1] ?? '2026-07-31';

  const departmentId = readFlag(args, 'department-id');
  const employeeIdArgs = readFlagAll(args, 'employee-id').map(Number).filter(Number.isFinite);
  const repairIdRaw = readFlag(args, 'repair-id');
  const expect = {
    id: readFlag(args, 'expect-id') ? Number(readFlag(args, 'expect-id')) : null,
    from: readFlag(args, 'expect-from'),
    to: readFlag(args, 'expect-to'),
  };

  // Скоуп: отдел (состав за период) ∩ явные сотрудники; иначе whitelist-отделы.
  let empIds: number[];
  if (departmentId) {
    const deptEmployees = await listEmployeeIdsAssignedToDepartmentPeriod(departmentId, startDate, endDate);
    empIds = employeeIdArgs.length > 0
      ? deptEmployees.filter(id => employeeIdArgs.includes(id))
      : deptEmployees;
    if (empIds.length === 0) {
      console.error(`${TAG} пустой скоуп: отдел ${departmentId} ∩ сотрудники [${employeeIdArgs.join(', ')}]`);
      process.exit(1);
    }
  } else if (employeeIdArgs.length > 0) {
    empIds = employeeIdArgs;
  } else {
    const requiredDepartments = await correctionApprovalSettingsService.getRequiredDepartmentIds();
    const deptIds = [...requiredDepartments];
    if (deptIds.length === 0) {
      console.log(`${TAG} whitelist отделов пуст — нечего пересчитывать.`);
      return;
    }
    const empRows = await query<{ id: number | string }>(
      `SELECT id FROM employees WHERE org_department_id = ANY($1::uuid[])`,
      [deptIds],
    );
    empIds = empRows.map(r => Number(r.id));
    console.log(`${TAG} скоуп: whitelist отделов = ${deptIds.length}`);
  }
  console.log(`${TAG} период ${startDate}..${endDate}; сотрудников в скоупе=${empIds.length}`);
  if (empIds.length === 0) return;

  if (repairIdRaw) {
    const repairId = Number(repairIdRaw);
    if (!Number.isFinite(repairId) || repairId <= 0) {
      console.error(`${TAG} некорректный --repair-id=${repairIdRaw}`);
      process.exit(1);
    }
    await repairSingleRow({ repairId, startDate, endDate, employeeIds: empIds, expect, apply });
    return;
  }

  const transitions = await computeReapprovalTransitions(empIds, startDate, endDate);
  if (transitions.length === 0) {
    console.log(`${TAG} переходов нет — всё уже согласовано корректно.`);
    return;
  }
  await printTransitions(transitions);

  if (!apply) {
    console.log(`${TAG} DRY-RUN — ничего не записано. Перезапустите с --apply, чтобы применить.`);
    return;
  }

  const mismatch = checkExpectation(transitions, expect);
  if (mismatch) {
    console.error(`${TAG} ОТМЕНА: ${mismatch}. Ничего не записано.`);
    process.exit(1);
  }

  const applied = await reapproveAdjustmentsForRange(empIds, startDate, endDate);
  console.log(`${TAG} применено: изменено строк = ${applied.length}`);
};

main().catch(err => {
  console.error(`${TAG} фатальная ошибка:`, err);
  process.exit(1);
});
