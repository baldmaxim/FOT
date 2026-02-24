import { supabase } from '../config/database.js';

async function main() {
  const r1 = await supabase.from('skud_events').select('id', { count: 'exact', head: true });
  const r2 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).not('dedup_hash', 'is', null);
  const r3 = await supabase.from('skud_events').select('id', { count: 'exact', head: true }).is('dedup_hash', null);
  console.log(`Total: ${r1.count} | With hash: ${r2.count} | Without hash: ${r3.count}`);
  process.exit(0);
}
main();
