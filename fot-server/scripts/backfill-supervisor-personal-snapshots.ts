/**
 * Одноразовый бэкфилл состава персональных подач руководителей (manager_employee_id IS NOT NULL).
 *
 * Контекст: до фикса persona-подача начальника участка содержала в snapshot только
 * самого руководителя ([managerEmpId]). Его лично назначенные сотрудники
 * (employee_direct_reports), сидящие вне подаваемых бригад, не попадали ни в одну
 * подачу и были не видны HR на «Согласование табелей». Этот скрипт пересобирает
 * snapshot каждой живой персональной подачи через resolveManagerPersonalSnapshotIds
 * (self + активные прямые подчинённые минус покрытые department-подачами за период),
 * совпадающий с рантайм-логикой ensureManagerSelfApprovalForRange.
 *
 * Бэкфиллим ВСЕ статусы, включая approved (по согласованному решению). Записи approved
 * помечаются в логе отдельно для аудита.
 *
 * По умолчанию dry-run: печатает diff, ничего не пишет.
 * Запись: cd fot-server && npx tsx scripts/backfill-supervisor-personal-snapshots.ts --apply
 *
 * Идемпотентен. Подачи с пустым целевым набором (руководитель уже покрыт бригадой,
 * активных подчинённых вне бригад нет) пропускаются — существующий snapshot не стираем.
 */
import { query, withTransaction } from '../src/config/postgres.js';
import {
  listApprovalEmployees,
  resolveManagerPersonalSnapshotIds,
  snapshotApprovalEmployees,
} from '../src/services/timesheet-approval-employees-snapshot.service.js';

interface IPersonalApprovalRow {
  id: number;
  manager_employee_id: number;
  start_date: string;
  end_date: string;
  status: string;
}

const main = async (): Promise<void> => {
  const apply = process.argv.includes('--apply');

  const rows = await query<IPersonalApprovalRow>(
    `SELECT a.id,
            a.manager_employee_id,
            to_char(a.start_date, 'YYYY-MM-DD') AS start_date,
            to_char(a.end_date, 'YYYY-MM-DD') AS end_date,
            a.status
       FROM timesheet_approvals a
      WHERE a.manager_employee_id IS NOT NULL
        AND a.status IN ('submitted', 'approved', 'returned', 'rejected')
      ORDER BY a.id ASC`,
  );

  if (rows.length === 0) {
    console.log('[backfill-supervisor-personal] персональных подач не найдено.');
    return;
  }

  console.log(`[backfill-supervisor-personal] ${apply ? 'APPLY' : 'DRY-RUN'} · персональных подач: ${rows.length}`);

  let changed = 0;
  let unchanged = 0;
  let skippedEmpty = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const target = await resolveManagerPersonalSnapshotIds(
        row.manager_employee_id,
        row.start_date,
        row.end_date,
      );

      if (target.length === 0) {
        skippedEmpty += 1;
        console.warn(`[skip-empty] approval_id=${row.id} (${row.status}, ${row.start_date}..${row.end_date}, mgr=${row.manager_employee_id}): целевой набор пуст — оставляем как есть`);
        continue;
      }

      const currentIds = (await listApprovalEmployees(row.id)).map(e => Number(e.employee_id));
      const currentSet = new Set(currentIds);
      const targetSet = new Set(target);
      const added = target.filter(id => !currentSet.has(id));
      const removed = currentIds.filter(id => !targetSet.has(id));

      if (added.length === 0 && removed.length === 0) {
        unchanged += 1;
        continue;
      }

      const approvedMark = row.status === 'approved' ? ' [APPROVED]' : '';
      console.log(
        `[diff]${approvedMark} approval_id=${row.id} (${row.status}, ${row.start_date}..${row.end_date}, mgr=${row.manager_employee_id}): `
        + `${currentIds.length} → ${target.length}; +[${added.join(',')}]${removed.length ? ` -[${removed.join(',')}]` : ''}`,
      );

      if (apply) {
        await withTransaction(client => snapshotApprovalEmployees(client, row.id, target));
      }
      changed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[fail] approval_id=${row.id}:`, (err as Error).message);
    }
  }

  console.log(
    `[backfill-supervisor-personal] готово (${apply ? 'APPLY' : 'DRY-RUN'}): `
    + `изменено=${changed}, без изменений=${unchanged}, пропущено(пусто)=${skippedEmpty}, ошибок=${failed}`,
  );
  if (!apply && changed > 0) {
    console.log('[backfill-supervisor-personal] это dry-run. Для записи перезапустите с флагом --apply');
  }
};

main().catch(err => {
  console.error('[backfill-supervisor-personal] фатальная ошибка:', err);
  process.exit(1);
});
