import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';

async function main() {
  const target = 'одинцов';
  let found = 0;
  let scanned = 0;
  const nameVariants = new Map<string, number>();
  const PAGE = 1000;

  // Сканируем все события, ищем "одинцов" в имени
  for (let offset = 0; offset < 500000; offset += PAGE) {
    const { data } = await supabase.from('skud_events')
      .select('id, physical_person_encrypted, event_date, employee_id')
      .range(offset, offset + PAGE - 1);

    if (!data || data.length === 0) break;
    scanned += data.length;

    for (const ev of data) {
      const name = encryptionService.decrypt(ev.physical_person_encrypted);
      if (name.toLowerCase().includes(target)) {
        found++;
        const key = name.trim();
        nameVariants.set(key, (nameVariants.get(key) || 0) + 1);
      }
    }

    if (scanned % 10000 === 0) process.stdout.write(`\rScanned: ${scanned}...`);
  }

  console.log(`\nScanned: ${scanned} | Found "${target}": ${found}`);
  console.log('Name variants:');
  for (const [name, count] of [...nameVariants.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  "${name}": ${count}`);
  }

  // Имя в employees
  const { data: emp } = await supabase.from('employees')
    .select('full_name_encrypted')
    .eq('id', 15989)
    .single();
  if (emp) {
    console.log(`\nEmployee 15989: "${encryptionService.decrypt(emp.full_name_encrypted)}"`);
  }

  process.exit(0);
}
main();
