/**
 * Схлопывание накопленных employee_assignments до одного открытого назначения на сотрудника.
 * Используется ОДНОРАЗОВО перед включением заморозки истории переводов на период чистки списков:
 *   1. Запустить `npx tsx scripts/freeze-transfer-history.ts --dry-run` и сверить лог.
 *   2. Запустить без флага — реальные изменения.
 *   3. В UI super_admin включить «Заморозка истории переводов».
 *   4. Доделать списки. После финализации — выключить заморозку, переводы снова пишут историю.
 *
 * Что делает для каждого активного сотрудника:
 * - Берёт snapshot (employees.org_department_id, position_id, hire_date).
 * - Оставляет одно открытое назначение (effective_to IS NULL): самое раннее по effective_from
 *   или новый INSERT, если открытого не было.
 * - В оставленном назначении: org_department_id и position_id = snapshot, effective_from =
 *   COALESCE(hire_date, '2020-01-01'), effective_to = NULL.
 * - Удаляет все остальные employee_assignments сотрудника.
 * - Если excluded_from_timesheet=false и excluded_from_timesheet_date IS NOT NULL — обнуляет дату.
 *
 * Запуск:
 *   npx tsx scripts/freeze-transfer-history.ts --dry-run
 *   npx tsx scripts/freeze-transfer-history.ts
 *   npx tsx scripts/freeze-transfer-history.ts --employee-id=123
 */
import { supabase } from '../src/config/database.js';

const DEFAULT_EFFECTIVE_FROM = '2020-01-01';
const CONCURRENCY = 20;
const REASON = 'Снимок при заморозке истории переводов';

interface IEmployeeRow {
  id: number;
  org_department_id: string | null;
  position_id: string | null;
  hire_date: string | null;
  excluded_from_timesheet: boolean | null;
  excluded_from_timesheet_date: string | null;
}

interface IAssignmentRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
}

interface ICounters {
  total: number;
  processed: number;
  skippedNoDept: number;
  kept: number;
  inserted: number;
  deleted: number;
  excludedDateReset: number;
  errors: number;
}

const dryRun = process.argv.includes('--dry-run');
const employeeIdArg = process.argv.find(a => a.startsWith('--employee-id='));
const targetEmployeeId = employeeIdArg ? Number(employeeIdArg.split('=')[1]) : null;

async function processEmployee(emp: IEmployeeRow, counters: ICounters): Promise<void> {
  if (!emp.org_department_id) {
    counters.skippedNoDept++;
    console.log(`[skip] employee=${emp.id} нет org_department_id`);
    return;
  }

  const { data: assignments, error: loadErr } = await supabase
    .from('employee_assignments')
    .select('id, effective_from, effective_to')
    .eq('employee_id', emp.id)
    .order('effective_from', { ascending: true });
  if (loadErr) throw loadErr;

  const rows = (assignments || []) as IAssignmentRow[];
  const openAssignments = rows.filter(r => r.effective_to == null);
  const keep = openAssignments[0] || null;
  const effectiveFrom = emp.hire_date || DEFAULT_EFFECTIVE_FROM;

  const toDeleteIds = rows.filter(r => !keep || r.id !== keep.id).map(r => r.id);

  if (dryRun) {
    console.log(
      `[dry] employee=${emp.id} keep=${keep?.id ?? 'INSERT_NEW'} delete=${toDeleteIds.length}`
      + ` effective_from=${effectiveFrom} excluded_date_reset=${
        emp.excluded_from_timesheet === false && emp.excluded_from_timesheet_date != null ? 'yes' : 'no'
      }`,
    );
    return;
  }

  if (keep) {
    const { error: updateErr } = await supabase
      .from('employee_assignments')
      .update({
        org_department_id: emp.org_department_id,
        position_id: emp.position_id,
        effective_from: effectiveFrom,
        effective_to: null,
        is_primary: true,
        assignment_type: 'main',
        change_reason: REASON,
        updated_at: new Date().toISOString(),
      })
      .eq('id', keep.id)
      .eq('employee_id', emp.id);
    if (updateErr) throw updateErr;
    counters.kept++;
  } else {
    const { error: insertErr } = await supabase
      .from('employee_assignments')
      .insert({
        employee_id: emp.id,
        org_department_id: emp.org_department_id,
        position_id: emp.position_id,
        effective_from: effectiveFrom,
        is_primary: true,
        assignment_type: 'main',
        change_reason: REASON,
      });
    if (insertErr) throw insertErr;
    counters.inserted++;
  }

  if (toDeleteIds.length > 0) {
    const { error: deleteErr } = await supabase
      .from('employee_assignments')
      .delete()
      .in('id', toDeleteIds)
      .eq('employee_id', emp.id);
    if (deleteErr) throw deleteErr;
    counters.deleted += toDeleteIds.length;
  }

  if (emp.excluded_from_timesheet === false && emp.excluded_from_timesheet_date != null) {
    const { error: excErr } = await supabase
      .from('employees')
      .update({ excluded_from_timesheet_date: null, updated_at: new Date().toISOString() })
      .eq('id', emp.id);
    if (excErr) throw excErr;
    counters.excludedDateReset++;
  }
}

async function main(): Promise<void> {
  console.log(`[freeze] start dryRun=${dryRun} targetEmployeeId=${targetEmployeeId ?? 'all'}`);

  let query = supabase
    .from('employees')
    .select('id, org_department_id, position_id, hire_date, excluded_from_timesheet, excluded_from_timesheet_date')
    .eq('is_archived', false)
    .eq('employment_status', 'active')
    .order('id');

  if (targetEmployeeId != null) {
    query = query.eq('id', targetEmployeeId);
  }

  const { data: employees, error: empErr } = await query;
  if (empErr) {
    console.error('[freeze] не удалось загрузить сотрудников:', empErr.message);
    process.exit(1);
  }

  const list = (employees || []) as IEmployeeRow[];
  const counters: ICounters = {
    total: list.length,
    processed: 0,
    skippedNoDept: 0,
    kept: 0,
    inserted: 0,
    deleted: 0,
    excludedDateReset: 0,
    errors: 0,
  };

  console.log(`[freeze] employees=${counters.total}`);

  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const batch = list.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(emp => processEmployee(emp, counters)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'rejected') {
        counters.errors++;
        console.error(`[err] employee=${batch[j].id}:`, r.reason instanceof Error ? r.reason.message : r.reason);
      } else {
        counters.processed++;
      }
    }
    if ((i + batch.length) % 200 === 0 || i + batch.length === list.length) {
      console.log(`[freeze] progress ${i + batch.length}/${counters.total}`);
    }
  }

  console.log('[freeze] готово:', counters);
  process.exit(counters.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('[freeze] fatal:', err);
  process.exit(1);
});
