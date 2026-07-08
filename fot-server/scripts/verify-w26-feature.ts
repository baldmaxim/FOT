/**
 * Проверка фичи W26 (READ-ONLY): колонка через getSigurEmployeeCardStatuses и поиск через
 * listSigurEmployees. Только GET к Sigur + чтение БД. Ничего не пишет.
 *
 * Запуск: cd fot-server && npx tsx scripts/verify-w26-feature.ts
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const parseEnvLastWins = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
};

const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const rawUrl = envFile.DATABASE_URL;
  if (!rawUrl) { console.error('DATABASE_URL не найден'); process.exit(1); }
  try {
    const u = new URL(rawUrl);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
    process.env.DATABASE_URL = u.toString();
  } catch { process.env.DATABASE_URL = rawUrl; }
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

async function main() {
  const { getSigurEmployeeCardStatuses, listSigurEmployees } = await import('../src/services/sigur-live-admin.service.js');

  console.log('=== 1) Колонка W26 через card-statuses ===');
  const statuses = await getSigurEmployeeCardStatuses([145723, 145244]);
  for (const s of statuses) {
    console.log(`  employeeId=${s.employeeId} | state=${s.state} | hasCard=${s.hasCard} | W26=${s.w26 ?? '—'} | exp=${s.expirationDate ?? '—'}`);
  }

  const runSearch = async (q: string) => {
    const res = await listSigurEmployees({ search: q }, { page: 1, pageSize: 50 });
    console.log(`\n=== Поиск "${q}" → total=${res.total}, items=${res.items.length} ===`);
    for (const it of res.items) {
      console.log(`  id=${it.id} | ${it.name} | отдел=${it.departmentName ?? '—'} | blocked=${it.blocked}`);
    }
  };

  await runSearch('035,30723');
  await runSearch('35,30723');
  await runSearch('999,99999'); // невалидный/несуществующий → пусто, без fallback
  await runSearch('250,65000'); // валидный формат, скорее всего нет карты → пусто

  console.log('\n=== готово (read-only) ===');
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err?.stack ?? err?.message ?? err);
  process.exit(1);
});
