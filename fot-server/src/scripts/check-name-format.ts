import { supabase } from '../config/database.js';

async function main() {
  // Показать 10 уникальных имён из событий
  const { data } = await supabase.from('skud_events')
    .select('physical_person')
    .range(0, 99);

  const names = new Set<string>();
  for (const ev of data || []) {
    const name = ev.physical_person || '';
    names.add(name);
    if (names.size >= 10) break;
  }
  console.log('Sample names from events:');
  for (const n of names) console.log(`  "${n}"`);

  // Показать ФИО из employees для сотрудника 15989
  const { data: emp } = await supabase.from('employees')
    .select('full_name')
    .eq('id', 15989)
    .single();
  if (emp) {
    console.log(`\nEmployee 15989 name: "${emp.full_name}"`);
  }

  // Поиск "одинцов" в событиях (частичный)
  let found = 0;
  for (let offset = 0; offset < 2000; offset += 500) {
    const { data: page } = await supabase.from('skud_events')
      .select('physical_person, employee_id, event_date')
      .range(offset, offset + 499);
    if (!page) break;
    for (const ev of page) {
      const name = (ev.physical_person || '').toLowerCase();
      if (name.includes('одинцов')) {
        found++;
        if (found <= 3) console.log(`  partial match: "${name}" emp_id=${ev.employee_id} date=${ev.event_date}`);
      }
    }
  }
  console.log(`Partial matches for "одинцов" in 2000 events: ${found}`);

  process.exit(0);
}
main();
