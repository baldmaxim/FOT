import 'dotenv/config';
import { sigurService } from '../src/services/sigur.service.js';

async function main() {
  const sigurEmployeeId = 128342;
  const newName = 'Луис Дженс Жоаким Матиас';

  console.log(`[push-name] PUT sigur employee ${sigurEmployeeId} name="${newName}"`);
  const result = await sigurService.updateEmployee(sigurEmployeeId, { name: newName });
  console.log('[push-name] OK', JSON.stringify(result));
}

main().catch((err) => {
  console.error('[push-name] ERR', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exit(1);
});
