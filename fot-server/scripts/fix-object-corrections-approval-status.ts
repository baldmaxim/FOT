import { query } from '../src/config/postgres.js';
import { resolveSchedulesForPeriod } from '../src/services/schedule.service.js';
import { loadCalendarMonth } from '../src/services/schedule.service.js';
import { isWorkingDay } from '../src/services/schedule.service.js';

async function fixObjectCorrectionsApprovalStatus() {
  console.log('🔍 Ищу объектные корректировки со статусом work и auto_approved...');

  const rows = await query<{
    id: number;
    employee_id: number;
    work_date: string;
  }>(
    `SELECT id, employee_id, work_date
       FROM attendance_adjustments
      WHERE source_type = 'manual_object'
        AND status = 'work'
        AND approval_status = 'auto_approved'
      ORDER BY work_date DESC`
  );

  if (rows.length === 0) {
    console.log('✅ Нет корректировок для обновления');
    return;
  }

  console.log(`📊 Найдено ${rows.length} корректировок`);

  // Группируем по сотрудникам и месяцам
  const byEmployeeMonth = new Map<string, typeof rows>();
  for (const row of rows) {
    const [year, month] = row.work_date.split('-');
    const key = `${row.employee_id}_${year}_${month}`;
    if (!byEmployeeMonth.has(key)) byEmployeeMonth.set(key, []);
    byEmployeeMonth.get(key)!.push(row);
  }

  let updatedCount = 0;

  for (const [key, records] of byEmployeeMonth.entries()) {
    const [empIdStr, yearStr, monthStr] = key.split('_');
    const empId = Number(empIdStr);
    const year = Number(yearStr);
    const month = Number(monthStr);

    // Загружаем расписание и календарь
    const schedules = await resolveSchedulesForPeriod(
      [{ id: empId }],
      `${year}-${String(month).padStart(2, '0')}-01`,
      `${year}-${String(month).padStart(2, '0')}-28`
    );
    const calendar = await loadCalendarMonth(year, month);
    const schedule = schedules.get(empId)?.get(records[0].work_date);

    if (!schedule) {
      console.log(`⚠️  Нет расписания для сотрудника ${empId} (${records.length} корректировок)`);
      continue;
    }

    // Проверяем каждую корректировку
    for (const record of records) {
      const dateObj = new Date(`${record.work_date}T00:00:00`);
      const isWorking = isWorkingDay(schedule, dateObj, calendar);

      if (!isWorking) {
        // День выходной → обновляем на pending
        await query(
          `UPDATE attendance_adjustments SET approval_status = 'pending' WHERE id = $1`,
          [record.id]
        );
        updatedCount++;
        console.log(`✅ ID ${record.id}: ${record.work_date} → pending`);
      }
    }
  }

  console.log(`\n✨ Обновлено ${updatedCount} из ${rows.length} корректировок`);
}

fixObjectCorrectionsApprovalStatus()
  .catch(err => {
    console.error('❌ Ошибка:', err);
    process.exit(1);
  })
  .then(() => process.exit(0));
