/**
 * Профайл «Единого 1С» (export-mass-unified) — где уходит время (READ-ONLY).
 *
 * Повторяет пайплайн exportTimesheetMassUnified для ООО СУ-10 и печатает мс по фазам,
 * чтобы понять, упирается ли генерация в JS (и в какую фазу) или БД. Ничего не пишет.
 *
 * Запуск (локально, БД — прод; подключение по приёму [[reference_prod_db_local_diagnostics]]):
 *   cd fot-server && npx tsx scripts/profile-unified-export.ts [YYYY-MM]
 */
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { performance } from 'node:perf_hooks';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1) env ДО импорта app-модулей: NODE_ENV=test (чтобы env.ts не перетёр override'ом),
// чистим ssl-параметры из DATABASE_URL и подсовываем локальный CA.
process.env.NODE_ENV = 'test';

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

const envFile = parseEnvLastWins(fs.readFileSync(path.resolve(__dirname, '../.env'), 'utf8'));
const rawUrl = envFile.DATABASE_URL;
if (!rawUrl) {
  console.error('DATABASE_URL не найден в fot-server/.env');
  process.exit(1);
}
try {
  const u = new URL(rawUrl);
  for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) u.searchParams.delete(k);
  process.env.DATABASE_URL = u.toString();
} catch {
  process.env.DATABASE_URL = rawUrl;
}
process.env.DATABASE_SSL = 'true';
process.env.DATABASE_SSL_CA_PATH = path.resolve(__dirname, '../../.migration/yandex-ca.pem');

const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const ms = (a: number, b: number): string => `${(b - a).toFixed(0)}ms`;

async function main(): Promise<void> {
  // Динамический импорт ПОСЛЕ настройки env.
  const { query } = await import('../src/config/postgres.js');
  const { listScopedMembersByDepartment, resolveTimesheetPeriodRange } =
    await import('../src/services/timesheet-department-assignments.service.js');
  const { fetchTimesheetDataForEmployees, sliceTimesheetDataByEmployees } =
    await import('../src/services/timesheet-export.service.js');
  type IDepartmentTimesheetData =
    Awaited<ReturnType<typeof fetchTimesheetDataForEmployees>>;
  const { buildUnified1CWorkbook } = await import('../src/services/timesheet-1c-unified.service.js');
  const { writeTimesheetWorkbookBuffer } = await import('../src/services/timesheet-excel.service.js');

  const argMonth = process.argv[2];
  const month = /^\d{4}-\d{2}$/.test(argMonth ?? '') ? argMonth : '2026-05';
  const period = resolveTimesheetPeriodRange(month, 'FULL');
  if (!period) throw new Error(`bad month: ${month}`);
  const { year, month: mon, startDate, endDate } = period;
  console.log(`profile export-mass-unified — СУ-10, период ${startDate}..${endDate}`);

  // scope = поддерево СУ-10 (то, что UI шлёт как department_ids)
  let t0 = performance.now();
  const deptRows = await query<{ id: string }>(
    `WITH RECURSIVE tree AS (
       SELECT id FROM org_departments WHERE id = $1
       UNION ALL
       SELECT d.id FROM org_departments d JOIN tree t ON d.parent_id = t.id
     ) SELECT id FROM tree`,
    [SU10],
  );
  const scopedDeptIds = deptRows.map(r => r.id);
  const nameRows = await query<{ id: string; name: string }>(
    'SELECT id, name FROM org_departments WHERE id = ANY($1::uuid[])',
    [scopedDeptIds],
  );
  const deptNameById = new Map(nameRows.map(r => [r.id, r.name]));
  console.log(`scope: ${scopedDeptIds.length} отделов — ${ms(t0, performance.now())}`);

  // 1) членство
  t0 = performance.now();
  const memberByEmp = await listScopedMembersByDepartment(scopedDeptIds, startDate, endDate);
  console.log(`1) membership: ${memberByEmp.size} сотр. — ${ms(t0, performance.now())}`);

  const empIdsByDept = new Map<string, number[]>();
  for (const [empId, deptId] of memberByEmp) {
    const list = empIdsByDept.get(deptId);
    if (list) list.push(empId);
    else empIdsByDept.set(deptId, [empId]);
  }
  const allEmployeeIds = [...memberByEmp.keys()];

  // 2) bulk attendance (внутри — buildAttendanceEntries → buildObjectAttendanceData)
  t0 = performance.now();
  const bulk = await fetchTimesheetDataForEmployees(month, allEmployeeIds, 'Сводный 1С', 'FULL', 'actual', true);
  console.log(`2) fetchTimesheetDataForEmployees: emp=${bulk.employees.length}, objectEntries=${bulk.objectEntries.length}, entries=${bulk.entries.length} — ${ms(t0, performance.now())}`);

  // 3) нарезка по отделам
  t0 = performance.now();
  const collected: IDepartmentTimesheetData[] = [...empIdsByDept].map(([deptId, ids]) =>
    sliceTimesheetDataByEmployees(bulk, ids, deptNameById.get(deptId) ?? 'Без названия', deptId));
  console.log(`3) slice: ${collected.length} срезов — ${ms(t0, performance.now())}`);

  // 4) сборка книги 1С
  t0 = performance.now();
  const workbook = await buildUnified1CWorkbook(mon, year, collected);
  console.log(`4) buildUnified1CWorkbook — ${ms(t0, performance.now())}`);

  // 5) запись xlsx в буфер
  t0 = performance.now();
  const buffer = await writeTimesheetWorkbookBuffer(workbook);
  console.log(`5) writeTimesheetWorkbookBuffer: ${(buffer.length / 1024).toFixed(0)} KB — ${ms(t0, performance.now())}`);

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
