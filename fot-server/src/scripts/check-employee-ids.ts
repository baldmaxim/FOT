import { supabase } from '../config/database.js';

async function main() {
  const r1 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).not('employee_id', 'is', null);
  const r2 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).is('employee_id', null);
  const r3 = await supabase.from('skud_events').select('id', { count: 'exact', head: true });
  console.log(`With employee_id: ${r1.count} | Without: ${r2.count} | Total: ${r3.count}`);

  const { data: dates } = await supabase.from('skud_events').select('event_date').order('event_date').limit(3);
  const { data: datesEnd } = await supabase.from('skud_events').select('event_date').order('event_date', { ascending: false }).limit(3);
  console.log('Earliest:', dates?.map(d => d.event_date));
  console.log('Latest:', datesEnd?.map(d => d.event_date));
  process.exit(0);
}
main();
