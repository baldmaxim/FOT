import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';

async function main() {
  const targetName = 'одинцов артем андреевич';

  // Выборочно проверяем 5000 событий
  let found = 0;
  let scanned = 0;
  const PAGE = 1000;

  for (let offset = 0; offset < 5000; offset += PAGE) {
    const { data } = await supabase.from('skud_events')
      .select('id, physical_person_encrypted, event_date, employee_id')
      .range(offset, offset + PAGE - 1);

    if (!data || data.length === 0) break;
    scanned += data.length;

    for (const ev of data) {
      const name = encryptionService.decrypt(ev.physical_person_encrypted).toLowerCase().trim();
      if (name === targetName) {
        found++;
        if (found <= 5) console.log(`  match: id=${ev.id} date=${ev.event_date} employee_id=${ev.employee_id}`);
      }
    }
  }

  console.log(`Scanned: ${scanned} | Found "${targetName}": ${found}`);
  process.exit(0);
}
main();
