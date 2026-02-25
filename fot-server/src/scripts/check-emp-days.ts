import { supabase } from '../config/database.js';

async function main() {
  const { data } = await supabase.from('skud_events')
    .select('event_date, event_time, direction, access_point')
    .eq('employee_id', 15989)
    .order('event_date')
    .order('event_time');

  if (!data) { console.log('No data'); process.exit(0); }

  const byDay = new Map<string, number>();
  for (const ev of data) {
    byDay.set(ev.event_date, (byDay.get(ev.event_date) || 0) + 1);
  }

  console.log(`Total events: ${data.length}`);
  console.log('By day:');
  for (const [day, count] of [...byDay.entries()].sort()) {
    console.log(`  ${day}: ${count} events`);
  }

  process.exit(0);
}
main();
