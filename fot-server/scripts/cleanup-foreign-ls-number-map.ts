/**
 * Чистка mts_business_number_map от номеров ЧУЖИХ лицевых счетов.
 *
 * Проблема: HierarchyStructure отдаёт структуру ВСЕЙ организации (все ЛС сразу,
 * на 08.07.2026 — 14 ЛС, 1273 номера), а refreshHierarchy до фикса заводил
 * номера ЛС, не настроенных в FOT (~306 шт.), с account_id синкующего аккаунта.
 * Из-за этого списки СУ-10/Закупки раздуты, по чужим номерам гоняется
 * детализация/профили (часть — под 401 «нет доступа»).
 *
 * Что делает: берёт последний снапшот hierarchy из БД, находит номера, чей
 * accountNo НЕ принадлежит ни одному настроенному аккаунту FOT, и удаляет их
 * строки из number_map. Строки с привязкой к сотруднику (employee_id NOT NULL)
 * НЕ трогает — только отчитывается о них.
 *
 * По умолчанию — DRY-RUN (только чтение). Запись — с флагом --apply.
 *
 * Запуск на проде:
 *   cd /opt/fot-build/fot-server && npx tsx scripts/cleanup-foreign-ls-number-map.ts          # preview
 *   cd /opt/fot-build/fot-server && npx tsx scripts/cleanup-foreign-ls-number-map.ts --apply  # запись
 *
 * ПДн (полные номера) в вывод не печатаются.
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const envCandidates = [
  process.env.MTS_ENV_FILE,
  path.resolve(process.cwd(), '.env'),
  '/srv/sites/fot.su10.ru/fot-server/.env',
  path.resolve(__dirname, '../.env'),
].filter((p): p is string => Boolean(p));
const envPath = envCandidates.find(p => fs.existsSync(p));
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`[env] загружен ${envPath}`);
} else {
  console.warn('[env] .env не найден — переменные должны быть уже в окружении');
}

const APPLY = process.argv.includes('--apply');

const main = async (): Promise<void> => {
  // Динамический импорт app-модулей — ПОСЛЕ загрузки .env выше.
  const { query, execute, queryOne } = await import('../src/config/postgres.js');
  const { msisdnHash } = await import('../src/services/mts-business-cdr.service.js');

  console.log(`Чистка чужих ЛС из number_map — режим: ${APPLY ? 'APPLY (запись)' : 'DRY-RUN (только чтение)'}`);

  const snap = await queryOne<{ payload: { numbers?: Array<{ msisdn: string | null; accountNo: string | null }> }; captured_at: string }>(
    `SELECT payload, captured_at FROM mts_business_metric_snapshot
      WHERE metric = 'hierarchy' AND scope = 'account'
      ORDER BY captured_at DESC LIMIT 1`,
  );
  if (!snap?.payload?.numbers?.length) {
    console.error('Снапшот hierarchy не найден или пуст — сначала прогоните «Обновить всё».');
    process.exit(1);
  }
  console.log(`Снапшот структуры от ${snap.captured_at}, номеров в организации: ${snap.payload.numbers.length}`);

  const accounts = await query<{ id: string; label: string; account_number: string | null }>(
    `SELECT id, label, account_number FROM mts_business_accounts`,
  );
  const configuredNos = new Set(accounts.map(a => a.account_number).filter((v): v is string => !!v));
  console.log(`Настроенные ЛС в FOT: ${[...configuredNos].map(no => no.slice(0, 4) + '***').join(', ')}`);

  // Номера чужих ЛС (accountNo есть, но не наш). Без accountNo — не трогаем.
  const foreign = snap.payload.numbers.filter(n => n.msisdn && n.accountNo && !configuredNos.has(n.accountNo));
  const foreignByLs = new Map<string, number>();
  for (const n of foreign) {
    const key = (n.accountNo as string).slice(0, 5) + '***';
    foreignByLs.set(key, (foreignByLs.get(key) ?? 0) + 1);
  }
  console.log(`Номеров чужих ЛС в структуре: ${foreign.length}`);
  for (const [ls, cnt] of [...foreignByLs.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ls}: ${cnt}`);
  }

  const hashes = foreign
    .map(n => msisdnHash(n.msisdn as string))
    .filter((h): h is string => !!h);

  const rows = await query<{ msisdn_hash: string; account_id: string | null; linked: boolean }>(
    `SELECT msisdn_hash, account_id, (employee_id IS NOT NULL) AS linked
       FROM mts_business_number_map WHERE msisdn_hash = ANY($1)`,
    [hashes],
  );
  const linked = rows.filter(r => r.linked);
  const deletable = rows.filter(r => !r.linked);
  const byAccount = new Map<string, number>();
  for (const r of deletable) {
    const label = accounts.find(a => a.id === r.account_id)?.label ?? '(без аккаунта)';
    byAccount.set(label, (byAccount.get(label) ?? 0) + 1);
  }
  console.log(`В number_map найдено чужих: ${rows.length}, к удалению (без сотрудника): ${deletable.length}`);
  for (const [label, cnt] of byAccount.entries()) console.log(`  числились за «${label}»: ${cnt}`);
  if (linked.length > 0) {
    console.log(`ПРОПУЩЕНО ${linked.length} чужих номеров с привязкой к сотруднику — проверьте руками (hash-префиксы):`);
    for (const r of linked) console.log(`  ${r.msisdn_hash.slice(0, 12)}…`);
  }

  if (!APPLY) {
    console.log('DRY-RUN завершён. Для удаления запустите с --apply.');
    return;
  }
  if (deletable.length > 0) {
    const deleted = await execute(
      `DELETE FROM mts_business_number_map WHERE msisdn_hash = ANY($1) AND employee_id IS NULL`,
      [deletable.map(r => r.msisdn_hash)],
    );
    console.log(`Удалено строк: ${deleted}`);
  }
  const after = await query<{ label: string; cnt: string }>(
    `SELECT coalesce(a.label, '(без аккаунта)') AS label, count(*)::text AS cnt
       FROM mts_business_number_map nm LEFT JOIN mts_business_accounts a ON a.id = nm.account_id
      GROUP BY 1 ORDER BY 1`,
  );
  console.log('number_map после чистки:', after.map(r => `${r.label}: ${r.cnt}`).join(', '));
};

main().then(() => process.exit(0)).catch(err => {
  console.error('Ошибка:', err instanceof Error ? err.message : err);
  process.exit(1);
});
