/**
 * Одноразовая чистка KPI объектов: удаляет тестовые данные «База Химки» и «База Мытищи»
 * (14.08 и 21.08.2026 их внёс «Постоев Админ»: договор «123» на 5 млрд, ДС, акты КС-2).
 * Из-за них в таблице «Все объекты» висели две лишние строки и «План за период» был завышен.
 *
 * Удаляется весь KPI-контур этих двух объектов: КС-2, КС-6, ДС, зафиксированные планы месяцев,
 * закрепления, договоры и журнал object_kpi_history. Сами объекты СКУД (skud_objects) не трогаем.
 * Без договора объект выпадает из таблицы (summarizeByObject), и фризер больше не заморозит
 * ему план (замораживает только объекты с активным договором).
 *
 * Гарды (иначе выход без изменений): имена объектов совпадают; у каждого объекта ровно один
 * договор с номером «123»; все договоры, ДС, КС-2 и КС-6 созданы и правлены только
 * «Постоев Админ»; закреплений нет. Если появились чужие данные — разбираться вручную.
 *
 * Перед удалением все строки пишутся в JSON-бэкап (--backup=<путь>, по умолчанию во временную папку).
 * Идемпотентно: повторный запуск найдёт 0 строк.
 *
 *   cd fot-server && npx tsx scripts/delete-kpi-test-data-khimki-mytishchi.ts            # DRY-RUN
 *   cd fot-server && npx tsx scripts/delete-kpi-test-data-khimki-mytishchi.ts --apply    # удаление
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PoolClient } from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = '[kpi-test-cleanup]';
const APPLY = process.argv.includes('--apply');
const BACKUP_ARG = process.argv.find(arg => arg.startsWith('--backup='))?.slice('--backup='.length);

const TEST_OBJECTS: Record<string, string> = {
  'd81b6b4e-6ffb-47d0-bfb1-90bcbc9f3918': 'База Химки',
  '96dd7d3c-e5ce-4ba6-890f-1232ce640754': 'База Мытищи',
};
const OBJECT_IDS = Object.keys(TEST_OBJECTS);
const TEST_AUTHOR_NAME = 'Постоев Админ';
const TEST_CONTRACT_NUMBER = '123';

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

// Локальный запуск (как в repair-pass-sigur-profile): CA из репо, sslrootcert прода из URL убираем.
const LOCAL_CA = path.resolve(__dirname, '../../.migration/yandex-ca.pem');
if (fs.existsSync(LOCAL_CA)) {
  process.env.NODE_ENV = 'test';
  const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
  const u = new URL(envFile.DATABASE_URL);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
  if (!APPLY) u.searchParams.set('options', '-c default_transaction_read_only=on');
  process.env.DATABASE_URL = u.toString();
  process.env.DATABASE_SSL = 'true';
  process.env.DATABASE_SSL_CA_PATH = LOCAL_CA;
}

type Row = Record<string, unknown>;

/** Таблицы в порядке удаления (FK RESTRICT: сначала строки, ссылающиеся на договор). */
const TABLES: Array<{ name: string; where: string }> = [
  { name: 'object_ks2_entries', where: 'skud_object_id = ANY($1::uuid[])' },
  { name: 'object_ks6_entries', where: 'skud_object_id = ANY($1::uuid[])' },
  {
    name: 'object_contract_addenda',
    where: 'contract_id IN (SELECT id FROM object_contracts WHERE skud_object_id = ANY($1::uuid[]))',
  },
  { name: 'object_kpi_month_plans', where: 'skud_object_id = ANY($1::uuid[])' },
  { name: 'object_kpi_assignments', where: 'skud_object_id = ANY($1::uuid[])' },
  { name: 'object_contracts', where: 'skud_object_id = ANY($1::uuid[])' },
  { name: 'object_kpi_history', where: 'skud_object_id = ANY($1::uuid[])' },
];

/** Таблицы с авторством: всё должно быть внесено и правлено только тестовой учёткой. */
const AUTHORED = new Set(['object_ks2_entries', 'object_ks6_entries', 'object_contract_addenda', 'object_contracts']);

const loadRows = async (client: PoolClient): Promise<Record<string, Row[]>> => {
  const result: Record<string, Row[]> = {};
  for (const table of TABLES) {
    const { rows } = await client.query<Row>(
      `SELECT * FROM ${table.name} WHERE ${table.where} ORDER BY 1`,
      [OBJECT_IDS],
    );
    result[table.name] = rows;
  }
  return result;
};

/** Список нарушений гардов; пустой — можно удалять. */
const checkGuards = async (client: PoolClient, data: Record<string, Row[]>): Promise<string[]> => {
  const problems: string[] = [];

  const { rows: objects } = await client.query<{ id: string; name: string }>(
    'SELECT id, name FROM skud_objects WHERE id = ANY($1::uuid[])',
    [OBJECT_IDS],
  );
  for (const id of OBJECT_IDS) {
    const found = objects.find(item => item.id === id);
    if (!found) problems.push(`объект ${id} не найден`);
    else if (found.name !== TEST_OBJECTS[id]) problems.push(`объект ${id}: имя «${found.name}», ждали «${TEST_OBJECTS[id]}»`);
  }

  const { rows: authors } = await client.query<{ id: string }>(
    'SELECT id FROM user_profiles WHERE full_name = $1',
    [TEST_AUTHOR_NAME],
  );
  if (authors.length !== 1) {
    problems.push(`учётка «${TEST_AUTHOR_NAME}»: найдено ${authors.length}, ждали 1`);
    return problems;
  }
  const authorId = authors[0].id;

  for (const id of OBJECT_IDS) {
    const contracts = data.object_contracts.filter(row => row.skud_object_id === id);
    if (contracts.length > 1) problems.push(`${TEST_OBJECTS[id]}: договоров ${contracts.length}`);
    for (const contract of contracts) {
      if (contract.contract_number !== TEST_CONTRACT_NUMBER) {
        problems.push(`${TEST_OBJECTS[id]}: номер договора «${String(contract.contract_number)}», ждали «${TEST_CONTRACT_NUMBER}»`);
      }
    }
  }

  for (const table of AUTHORED) {
    for (const row of data[table]) {
      if (row.created_by !== authorId || row.updated_by !== authorId) {
        problems.push(`${table} ${String(row.id)}: автор не «${TEST_AUTHOR_NAME}»`);
      }
    }
  }

  if (data.object_kpi_assignments.length > 0) {
    problems.push(`закреплений: ${data.object_kpi_assignments.length} — это не тест, удалять вручную`);
  }
  return problems;
};

const printSummary = (data: Record<string, Row[]>): void => {
  for (const table of TABLES) {
    const rows = data[table.name];
    const byObject = OBJECT_IDS.map((id) => {
      const count = table.name === 'object_contract_addenda'
        ? rows.filter(row => data.object_contracts.some(c => c.id === row.contract_id && c.skud_object_id === id)).length
        : rows.filter(row => row.skud_object_id === id).length;
      return `${TEST_OBJECTS[id]} ${count}`;
    });
    console.log(`${LOG}   ${table.name.padEnd(26)} ${String(rows.length).padStart(3)}  (${byObject.join(', ')})`);
  }
};

const main = async (): Promise<void> => {
  const { withTransaction, closeDb } = await import('../src/config/postgres.js');
  console.log(`${LOG} режим: ${APPLY ? 'APPLY (удаление в БД)' : 'DRY-RUN (только чтение)'}`);

  try {
    await withTransaction(async (client) => {
      if (APPLY) {
        // Договоры блокируем: параллельная правка из портала дождётся конца транзакции.
        await client.query('SELECT id FROM object_contracts WHERE skud_object_id = ANY($1::uuid[]) FOR UPDATE', [OBJECT_IDS]);
      }
      const data = await loadRows(client);
      console.log(`${LOG} найдено строк:`);
      printSummary(data);

      const problems = await checkGuards(client, data);
      if (problems.length > 0) {
        console.log(`${LOG} ГАРДЫ НЕ ПРОЙДЕНЫ — ничего не меняю:`);
        for (const problem of problems) console.log(`${LOG}   - ${problem}`);
        throw new Error('guards failed');
      }
      console.log(`${LOG} гарды пройдены`);

      const total = TABLES.reduce((sum, table) => sum + data[table.name].length, 0);
      if (total === 0) {
        console.log(`${LOG} удалять нечего (уже чисто)`);
        return;
      }

      const backupPath = BACKUP_ARG
        ?? path.join(os.tmpdir(), `kpi-test-data-khimki-mytishchi-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(backupPath, JSON.stringify({ created_at: new Date().toISOString(), objects: TEST_OBJECTS, data }, null, 2));
      console.log(`${LOG} бэкап: ${backupPath}`);

      if (!APPLY) {
        console.log(`${LOG} DRY-RUN: для удаления повторите с --apply`);
        return;
      }

      for (const table of TABLES) {
        const result = await client.query(`DELETE FROM ${table.name} WHERE ${table.where}`, [OBJECT_IDS]);
        const expected = data[table.name].length;
        if (result.rowCount !== expected) {
          throw new Error(`${table.name}: удалено ${result.rowCount}, ждали ${expected}`);
        }
        console.log(`${LOG}   удалено ${table.name}: ${result.rowCount}`);
      }

      const left = await loadRows(client);
      const leftTotal = TABLES.reduce((sum, table) => sum + left[table.name].length, 0);
      if (leftTotal !== 0) throw new Error(`после удаления осталось строк: ${leftTotal}`);
      console.log(`${LOG} APPLY: удалено ${total} строк, остаток 0 — COMMIT`);
    });
  } finally {
    await closeDb();
  }
};

main().catch((error: unknown) => {
  console.error(`${LOG} ошибка:`, error instanceof Error ? error.message : error);
  process.exit(1);
});
