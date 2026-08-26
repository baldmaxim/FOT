/**
 * Бэкфилл официальных версий закрытых табелей.
 *
 * Версия создаётся при approve и при закрытии утверждённого периода, но подачи,
 * согласованные ДО внедрения версионирования, её не имеют. Пока версии нет, API
 * для 1С отдаёт по такой подаче VERSION_NOT_AVAILABLE, а в списке она приходит
 * с version_available = false.
 *
 * ГЕЙТ ЗАПУСКА ОБМЕНА: ключ 1С включаем только когда контрольный запрос
 * «approved + unlocked_at IS NULL + нет версии, в пределах глубины» даёт 0.
 *
 * Запуск (на проде — из /opt/fot-build, см. практику одноразовых скриптов):
 *   npx tsx scripts/backfill-timesheet-versions.ts --dry-run
 *   npx tsx scripts/backfill-timesheet-versions.ts
 *
 * Флаги:
 *   --dry-run              только показать, что будет сделано
 *   --from=YYYY-MM-DD      нижняя граница start_date (по умолчанию — глубина API)
 *   --to=YYYY-MM-DD        верхняя граница start_date
 *   --limit=N              обработать не более N подач
 *   --allow-empty-roster   создавать версию и для подач с пустым составом
 *
 * Идемпотентен: подачи с версией пропускаются, повторный прогон безопасен.
 */
import { query } from '../src/config/postgres.js';
import { withTimesheetSnapshotTransaction } from '../src/services/timesheet-snapshot-tx.js';
import {
  materializeVersion,
  TimesheetVersionEmptyRosterError,
  TimesheetVersionIncompleteError,
  type IVersionApproval,
} from '../src/services/timesheet-version.service.js';

/** Та же глубина, что ограничивает API: иначе 1С запрашивала бы глубже, чем забэкфиллено. */
const MAX_EXPORT_DEPTH_MONTHS = 3;

interface IApprovalRow {
  id: number;
  department_id: string | null;
  manager_employee_id: number | null;
  start_date: string;
  end_date: string;
  status: string;
}

function parseArgs(): { dryRun: boolean; from: string | null; to: string | null; limit: number | null; allowEmpty: boolean } {
  const args = process.argv.slice(2);
  const get = (name: string): string | null => {
    const found = args.find(a => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : null;
  };
  const limitRaw = get('limit');
  return {
    dryRun: args.includes('--dry-run'),
    from: get('from'),
    to: get('to'),
    limit: limitRaw && /^\d+$/.test(limitRaw) ? Number(limitRaw) : null,
    allowEmpty: args.includes('--allow-empty-roster'),
  };
}

function defaultFromDate(): string {
  const now = new Date();
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MAX_EXPORT_DEPTH_MONTHS, 1));
  return anchor.toISOString().slice(0, 10);
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

const main = async (): Promise<void> => {
  const opts = parseArgs();
  const from = opts.from ?? defaultFromDate();

  const params: unknown[] = [from];
  let sql = `SELECT a.id, a.department_id, a.manager_employee_id, a.start_date, a.end_date, a.status
       FROM timesheet_approvals a
      WHERE a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.start_date >= $1::date
        AND NOT EXISTS (SELECT 1 FROM timesheet_versions v WHERE v.approval_id = a.id)`;
  if (opts.to) {
    params.push(opts.to);
    sql += ` AND a.start_date <= $${params.length}::date`;
  }
  sql += ' ORDER BY a.start_date ASC, a.id ASC';
  if (opts.limit) {
    params.push(opts.limit);
    sql += ` LIMIT $${params.length}`;
  }

  const rows = await query<IApprovalRow>(sql, params);

  console.log(`Подач без версии: ${rows.length} (start_date >= ${from}${opts.to ? `, <= ${opts.to}` : ''})`);
  if (opts.dryRun) {
    for (const row of rows) {
      console.log(`  [dry-run] approval ${row.id}: ${row.start_date}..${row.end_date}, `
        + `${row.department_id ? `отдел ${row.department_id}` : `персональная (рук. ${row.manager_employee_id})`}`);
    }
    console.log('Режим --dry-run: ничего не записано.');
    return;
  }

  let created = 0;
  let unchanged = 0;
  const skippedEmpty: number[] = [];
  const skippedIncomplete: Array<{ id: number; missing: number[] }> = [];
  const failed: Array<{ id: number; error: string }> = [];

  for (const row of rows) {
    const approval: IVersionApproval = {
      id: Number(row.id),
      department_id: row.department_id,
      manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
      start_date: row.start_date,
      end_date: row.end_date,
      status: row.status,
    };

    // Состав для advisory-локов читаем ДО транзакции — как в approve/close.
    const anchors = monthAnchorsInRange(approval.start_date, approval.end_date);
    const snapshot = await query<{ employee_id: number | string }>(
      'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
      [approval.id],
    );
    const lockPairs = snapshot.flatMap(s => anchors.map(workDate => ({
      employeeId: Number(s.employee_id),
      workDate,
    })));

    if (lockPairs.length === 0 && !opts.allowEmpty) {
      skippedEmpty.push(approval.id);
      continue;
    }

    try {
      const result = await withTimesheetSnapshotTransaction(lockPairs, async client => {
        const locked = await client.query<IApprovalRow>(
          'SELECT id, department_id, manager_employee_id, start_date, end_date, status FROM timesheet_approvals WHERE id = $1 FOR UPDATE',
          [approval.id],
        );
        const current = locked.rows[0];
        if (!current || current.status !== 'approved') return null;
        return materializeVersion(client, approval, 'backfill', null);
      });

      if (!result) {
        failed.push({ id: approval.id, error: 'статус изменился во время обработки' });
      } else if (result.created) {
        created += 1;
        console.log(`  approval ${approval.id}: версия ${result.version.revision}, `
          + `сотрудников ${result.version.employees_count}, часов ${result.version.total_hours}`);
      } else {
        unchanged += 1;
      }
    } catch (err) {
      if (err instanceof TimesheetVersionEmptyRosterError) {
        skippedEmpty.push(approval.id);
      } else if (err instanceof TimesheetVersionIncompleteError) {
        skippedIncomplete.push({ id: approval.id, missing: err.missingEmployeeIds });
      } else {
        failed.push({ id: approval.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  console.log('\n=== Итог ===');
  console.log(`Создано версий: ${created}`);
  if (unchanged > 0) console.log(`Без изменений (версия уже актуальна): ${unchanged}`);

  if (skippedEmpty.length > 0) {
    console.log(`\nПропущено — нет состава: ${skippedEmpty.length}`);
    console.log(`  approval_id: ${skippedEmpty.join(', ')}`);
    console.log('  Это подачи, у которых снимок состава пуст (например, отдел опустел '
      + 'до начала периода). Разобрать вручную; признать пустыми — флаг --allow-empty-roster.');
  }
  if (skippedIncomplete.length > 0) {
    console.log(`\nПропущено — состав собран не полностью: ${skippedIncomplete.length}`);
    for (const item of skippedIncomplete) {
      console.log(`  approval ${item.id}: не попали в расчёт employee_id ${item.missing.join(', ')}`);
    }
    console.log('  Официальная версия с потерянными людьми не создаётся намеренно.');
  }
  if (failed.length > 0) {
    console.log(`\nОшибки: ${failed.length}`);
    for (const item of failed) console.log(`  approval ${item.id}: ${item.error}`);
  }

  // Контрольный запрос гейта — то же условие, что проверяем перед выдачей ключа 1С.
  const [gate] = await query<{ remaining: string }>(
    `SELECT count(*)::text AS remaining
       FROM timesheet_approvals a
      WHERE a.status = 'approved'
        AND a.unlocked_at IS NULL
        AND a.start_date >= $1::date
        AND NOT EXISTS (SELECT 1 FROM timesheet_versions v WHERE v.approval_id = a.id)`,
    [from],
  );
  console.log(`\nГейт запуска обмена (должно быть 0): осталось без версии — ${gate?.remaining ?? '?'}`);
};

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('backfill-timesheet-versions failed:', err);
    process.exit(1);
  });
