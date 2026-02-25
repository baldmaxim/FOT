import { supabase } from '../config/database.js';

async function main() {
  // Проверяем распределение organization_id
  const { data } = await supabase.from('skud_events').select('organization_id').limit(10);
  console.log('Sample org_ids:', data?.map(d => d.organization_id));

  // Сколько событий с правильным org_id
  const target = '270987e6-f7b9-4074-99f4-d5a42780bf5c';
  const r1 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).eq('organization_id', target);
  const r2 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).neq('organization_id', target);
  const r3 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).is('organization_id', null);
  console.log(`Org ${target}: ${r1.count} | Other: ${r2.count} | Null: ${r3.count}`);

  // Сколько событий с employee_id для сотрудника 15989
  const r4 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).eq('employee_id', 15989);
  console.log(`Events for employee 15989: ${r4.count}`);

  // Даты событий для сотрудника 15989
  const { data: empDates } = await supabase.from('skud_events')
    .select('event_date')
    .eq('employee_id', 15989)
    .order('event_date')
    .limit(5);
  const { data: empDatesEnd } = await supabase.from('skud_events')
    .select('event_date')
    .eq('employee_id', 15989)
    .order('event_date', { ascending: false })
    .limit(5);
  console.log('Employee 15989 earliest:', empDates?.map(d => d.event_date));
  console.log('Employee 15989 latest:', empDatesEnd?.map(d => d.event_date));

  process.exit(0);
}
main();
