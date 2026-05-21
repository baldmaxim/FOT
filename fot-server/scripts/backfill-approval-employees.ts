/**
 * Одноразовый бэкфилл: для каждой записи timesheet_approvals со статусом
 * submitted/approved/rejected/returned, у которой ещё нет строк в
 * timesheet_approval_employees, формируем снимок состава по текущим
 * назначениям отдела на период. Это best-effort — для старых подач
 * назначения уже могли измениться, но это лучше, чем пустой блок в UI.
 *
 * Запуск: cd fot-server && npx tsx scripts/backfill-approval-employees.ts
 * Идемпотентен — пропускает approvals, у которых снимок уже есть.
 */
import { query, withTransaction } from '../src/config/postgres.js';
import { snapshotApprovalEmployees } from '../src/services/timesheet-approval-employees-snapshot.service.js';

interface IApprovalRow {
  id: number;
  department_id: string;
  start_date: string;
  end_date: string;
  status: string;
}

const main = async (): Promise<void> => {
  const rows = await query<IApprovalRow>(
    `SELECT a.id, a.department_id, a.start_date, a.end_date, a.status
       FROM timesheet_approvals a
      WHERE a.status <> 'draft'
        AND NOT EXISTS (SELECT 1 FROM timesheet_approval_employees e WHERE e.approval_id = a.id)
      ORDER BY a.id ASC`,
  );

  if (rows.length === 0) {
    console.log('[backfill-approval-employees] нечего бэкфилить — у всех подач уже есть снимок.');
    return;
  }

  console.log(`[backfill-approval-employees] подач без снимка: ${rows.length}`);

  let ok = 0;
  let empty = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const count = await withTransaction(client =>
        snapshotApprovalEmployees(client, row.id, row.department_id, row.start_date, row.end_date),
      );
      if (count === 0) {
        empty += 1;
        console.warn(`[backfill-approval-employees] approval_id=${row.id} (${row.status}, ${row.start_date}..${row.end_date}, dept=${row.department_id}): 0 сотрудников`);
      } else {
        ok += 1;
        console.log(`[backfill-approval-employees] approval_id=${row.id}: ${count} сотр.`);
      }
    } catch (err) {
      failed += 1;
      console.error(`[backfill-approval-employees] approval_id=${row.id} упал:`, (err as Error).message);
    }
  }

  console.log(`[backfill-approval-employees] готово: ok=${ok}, пустых=${empty}, ошибок=${failed}`);
};

main().catch(err => {
  console.error('[backfill-approval-employees] фатальная ошибка:', err);
  process.exit(1);
});
