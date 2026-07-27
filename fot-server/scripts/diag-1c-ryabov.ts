/**
 * Диагностика (read-only): проверка пост-фикс поведения единого файла 1С для
 * уволенного Рябова А.Г. (id 1540, бр.Пшиков А.С.). Ничего не пишет в БД.
 *
 * Имитация пост-фикса: текущий код вырезает fired в buildRowsForDepartment по
 * employees[].employment_status. Чтобы увидеть, что даст билдер ПОСЛЕ снятия
 * фильтра, локально в срезе подменяем статус Рябова на 'active' — cutoffByEmployeeId
 * (реальный, из fetch) при этом сохраняется, поэтому механика cutoff проверяется честно.
 *
 * Запуск: cd fot-server && npx tsx scripts/diag-1c-ryabov.ts
 */
import {
  listScopedMembersByDepartment,
  resolveTimesheetPeriodRange,
} from '../src/services/timesheet-department-assignments.service.js';
import {
  fetchTimesheetDataForEmployees,
  sliceTimesheetDataByEmployees,
  type IDepartmentTimesheetData,
  type TimesheetExportHalf,
} from '../src/services/timesheet-export.service.js';
import { listBrigadeSupervisorEmployeeIdsForDepartments } from '../src/controllers/timesheet-assigned-export.controller.js';
import { buildUnified1CWorkbook } from '../src/services/timesheet-1c-unified.service.js';
import { query } from '../src/config/postgres.js';

const BRIGADE_ID = '8297d20b-d629-4fc1-8254-86d300ff76c4'; // бр.Пшиков А.С.
const RYABOV_ID = 1540;
const MONTH = '2026-07';

// Колонки листа единого 1С (см. timesheet-excel.service.ts).
const COL_FIO = 2;
const COL_DAY1 = 3;
const COL_TOTAL = 34;
const COL_DEPT = 35;
const COL_ADDRESS = 36;
const DATA_START_ROW = 4;

async function diagForHalf(half: TimesheetExportHalf): Promise<void> {
  console.log(`\n================= period ${MONTH} half=${half} =================`);
  const range = resolveTimesheetPeriodRange(MONTH, half)!;
  const startDay = Number(range.startDate.slice(-2));
  const endDay = Number(range.endDate.slice(-2));
  console.log(`период: ${range.startDate} .. ${range.endDate} (дни ${startDay}..${endDay})`);

  const memberByEmp = await listScopedMembersByDepartment([BRIGADE_ID], range.startDate, range.endDate);
  const empIds = [...memberByEmp.keys()];

  const bulk = await fetchTimesheetDataForEmployees(
    MONTH, empIds, 'Сводный 1С', half, 'actual', true,
    {
      excludeZeroActivity: true,
      exemptEmployeeIds: await listBrigadeSupervisorEmployeeIdsForDepartments([BRIGADE_ID]),
    },
  );

  const cutoff = bulk.cutoffByEmployeeId?.get(RYABOV_ID) ?? null;
  const objEntriesForRyabov = bulk.objectEntries.filter(e => e.employee_id === RYABOV_ID);
  console.log(`cutoff Рябова: ${cutoff ?? '—'}; объектных записей: ${objEntriesForRyabov.length}`);
  if (objEntriesForRyabov.length > 0) {
    console.log(`  объектные дни: ${objEntriesForRyabov.map(e => `${e.work_date.slice(-2)}=${e.display_hours_worked ?? e.hours_worked}`).sort().join(' ')}`);
  }

  const sliced: IDepartmentTimesheetData = sliceTimesheetDataByEmployees(
    bulk, empIds, 'бр.Пшиков А.С.', BRIGADE_ID,
  );

  const workbook = await buildUnified1CWorkbook(7, 2026, [sliced]);
  const ws = workbook.worksheets[0];

  let found = 0;
  for (let r = DATA_START_ROW; r <= ws.rowCount; r++) {
    const fio = ws.getCell(r, COL_FIO).value;
    if (typeof fio !== 'string' || !fio.includes('Рябов')) continue;
    found++;
    // Лист единого 1С всегда имеет 31 колонку дней: день N → колонка COL_DAY1 + N − 1 (абсолютно).
    const days: string[] = [];
    for (let d = startDay; d <= endDay; d++) {
      const v = ws.getCell(r, COL_DAY1 + d - 1).value;
      days.push(`${d}:${v === null || v === undefined ? '·' : v}`);
    }
    console.log(`  строка ${found}: "${fio}" | отдел="${ws.getCell(r, COL_DEPT).value}" | адрес="${ws.getCell(r, COL_ADDRESS).value}"`);
    console.log(`    дни: ${days.join(' ')}`);
    console.log(`    ИТОГ (кол.34): ${ws.getCell(r, COL_TOTAL).value}`);
  }
  if (found === 0) console.log('  Рябов В КНИГЕ ОТСУТСТВУЕТ');
  else console.log(`  строк Рябова в книге: ${found}`);
}

async function main(): Promise<void> {
  const meta = await query<{ dismissal_date: string | null; excluded_from_timesheet_date: string | null }>(
    'SELECT dismissal_date, excluded_from_timesheet_date FROM employees WHERE id = $1',
    [RYABOV_ID],
  );
  console.log(`Рябов id ${RYABOV_ID}: dismissal_date=${meta[0]?.dismissal_date}, excluded_date=${meta[0]?.excluded_from_timesheet_date}`);
  await diagForHalf('H1');
  await diagForHalf('H2');
  await diagForHalf('FULL');
  console.log('\nГотово. БД не изменялась (только SELECT + сборка Excel в памяти).');
  process.exit(0);
}

main().catch(err => {
  console.error('diag error:', err);
  process.exit(1);
});
