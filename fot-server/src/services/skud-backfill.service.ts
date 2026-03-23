/**
 * Фоновый backfill: привязка employee_id к unmatched skud_events по ФИО.
 * Вызывается после каждого цикла поллинга, а НЕ на read-path.
 */
import { supabase } from '../config/database.js';
import { formatDateToISO } from '../utils/date.utils.js';

export async function backfillUnmatchedEvents(): Promise<void> {
  const today = formatDateToISO(new Date());

  // Загружаем активных сотрудников
  const { data: employees } = await supabase
    .from('employees')
    .select('id, full_name, organization_id')
    .eq('is_archived', false)
    .eq('employment_status', 'active');

  if (!employees || employees.length === 0) return;

  // Карта ФИО|org_id → employee.id
  const nameOrgToEmpId = new Map<string, number>();
  for (const emp of employees) {
    const key = `${(emp.full_name || '').toLowerCase().trim()}|${emp.organization_id}`;
    nameOrgToEmpId.set(key, emp.id);
  }

  // Загружаем unmatched events за сегодня
  const { data: unmatchedEvents } = await supabase
    .from('skud_events')
    .select('id, physical_person, organization_id')
    .eq('event_date', today)
    .is('employee_id', null)
    .limit(5000);

  if (!unmatchedEvents || unmatchedEvents.length === 0) return;

  const backfillEventIds: number[] = [];
  const backfillEmpIds: number[] = [];
  const affectedEmpIdSet = new Set<number>();

  for (const evt of unmatchedEvents) {
    const key = `${(evt.physical_person || '').toLowerCase().trim()}|${evt.organization_id}`;
    const empId = nameOrgToEmpId.get(key);
    if (!empId) continue;

    backfillEventIds.push(evt.id);
    backfillEmpIds.push(empId);
    affectedEmpIdSet.add(empId);
  }

  if (backfillEventIds.length === 0) return;

  console.log(`[backfill] ${today}: matched ${backfillEventIds.length}/${unmatchedEvents.length} events`);

  // Привязываем employee_id к событиям
  await supabase.rpc('bulk_update_employee_ids', {
    p_event_ids: backfillEventIds,
    p_employee_ids: backfillEmpIds,
  });

  // Пересчёт daily summary для затронутых сотрудников
  const orgIds = new Set(employees.filter(e => affectedEmpIdSet.has(e.id)).map(e => e.organization_id));
  for (const orgId of orgIds) {
    const empIdsForOrg = employees
      .filter(e => e.organization_id === orgId && affectedEmpIdSet.has(e.id))
      .map(e => ({ org_id: orgId, emp_id: e.id, date: today }));

    if (empIdsForOrg.length > 0) {
      await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: empIdsForOrg });
    }
  }

  console.log(`[backfill] recalculated daily summary for ${affectedEmpIdSet.size} employees`);
}
