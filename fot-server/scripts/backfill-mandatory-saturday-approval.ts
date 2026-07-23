/**
 * Одноразовый бэкфилл: пересчёт approval_status обязательных суббот после восстановления
 * count-модели (коммит 41830323 от 13.07 её удалил, из-за чего первые отработанные субботы
 * whitelist-отделов застряли в pending вместо auto_approved).
 *
 * Использует ОБЩИЙ расчёт computeReapprovalTransitions (та же логика, что и apply):
 *  - dry-run (по умолчанию): только печатает планируемые переходы, НИЧЕГО не пишет;
 *  - --apply: применяет через reapproveAdjustmentsForRange (один UPDATE).
 *
 * Тронет только auto_approved/pending; решения руководителя (approved/rejected) не меняются.
 * Скоуп — сотрудники whitelist-отделов (correction_approval_required_department_ids); строки
 * не из count-графика/рабочие дни расчёт пропустит сам.
 *
 * Запуск (dry-run):  cd fot-server && npx tsx scripts/backfill-mandatory-saturday-approval.ts
 * Применить:         ... scripts/backfill-mandatory-saturday-approval.ts --apply
 * Другой период:     ... scripts/backfill-mandatory-saturday-approval.ts 2026-07-01 2026-07-31 --apply
 */
import { query } from '../src/config/postgres.js';
import {
  computeReapprovalTransitions,
  reapproveAdjustmentsForRange,
} from '../src/controllers/timesheet.controller.js';
import { correctionApprovalSettingsService } from '../src/services/correction-approval-settings.service.js';

const TAG = '[backfill-mandatory-saturday]';

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const startDate = dates[0] ?? '2026-07-01';
  const endDate = dates[1] ?? '2026-07-31';

  // Скоуп: сотрудники whitelist-отделов (у остальных выходные и так auto_approved).
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
  const empIds = empRows.map(r => Number(r.id));
  console.log(`${TAG} период ${startDate}..${endDate}; отделов whitelist=${deptIds.length}; сотрудников в скоупе=${empIds.length}`);
  if (empIds.length === 0) return;

  // Dry-run расчёт — тот же, что использует apply.
  const transitions = await computeReapprovalTransitions(empIds, startDate, endDate);
  if (transitions.length === 0) {
    console.log(`${TAG} переходов нет — всё уже согласовано корректно.`);
    return;
  }

  const byKind = new Map<string, number>();
  for (const t of transitions) {
    const k = `${t.from} -> ${t.to}`;
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  console.log(`${TAG} планируемые переходы (${transitions.length}):`);
  for (const [k, n] of byKind) console.log(`${TAG}   ${k}: ${n}`);

  // Детализация: сотрудник + дата по каждому переходу (для проверки перед apply).
  const ids = transitions.map(t => t.id);
  const detail = await query<{ id: number | string; work_date: string; last_name: string; first_name: string; status: string }>(
    `SELECT aa.id, aa.work_date::text AS work_date, aa.status, e.last_name, e.first_name
       FROM attendance_adjustments aa JOIN employees e ON e.id = aa.employee_id
      WHERE aa.id = ANY($1::bigint[])
      ORDER BY e.last_name, aa.work_date`,
    [ids],
  );
  const toMap = new Map(transitions.map(t => [Number(t.id), t]));
  for (const d of detail) {
    const t = toMap.get(Number(d.id));
    console.log(`${TAG}   id=${d.id} ${d.last_name} ${d.first_name} ${String(d.work_date).slice(0, 10)} ${d.status}: ${t?.from} -> ${t?.to}`);
  }

  if (!apply) {
    console.log(`${TAG} DRY-RUN — ничего не записано. Перезапустите с --apply, чтобы применить.`);
    return;
  }

  const changed = await reapproveAdjustmentsForRange(empIds, startDate, endDate);
  console.log(`${TAG} применено: изменено строк = ${changed}`);
};

main().catch(err => {
  console.error(`${TAG} фатальная ошибка:`, err);
  process.exit(1);
});
