import { query } from '../src/config/postgres.js';
import { resolveSchedulesForPeriod } from '../src/services/schedule.service.js';
import { loadCalendarMonth } from '../src/services/schedule.service.js';
import { isWorkingDay } from '../src/services/schedule.service.js';

async function fixObjectCorrectionsApprovalStatus() {
  console.log('🔍 Ищу корректировки со статусом work и auto_approved...');

  const rows = await query<{
    id: number;
    employee_id: number;
    work_date: string;
    source_type: string;
  }>(
    `SELECT id, employee_id, work_date, source_type
       FROM attendance_adjustments
      WHERE status = 'work'
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
    const lastDay = new Date(year, month, 0).getDate();
    const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;

    // Загружаем расписание и календарь
    const schedules = await resolveSchedulesForPeriod(
      [{ id: empId }],
      `${monthPrefix}-01`,
      `${monthPrefix}-${String(lastDay).padStart(2, '0')}`
    );
    const calendar = await loadCalendarMonth(year, month);

    // Проверяем каждую корректировку
    for (const record of records) {
      const schedule = schedules.get(empId)?.get(record.work_date);
      if (!schedule) {
        console.log(`⚠️  Нет расписания для сотрудника ${empId} на ${record.work_date} (ID ${record.id})`);
        continue;
      }

      const dateObj = new Date(`${record.work_date}T00:00:00`);
      const isWorking = isWorkingDay(schedule, dateObj, calendar);

      if (!isWorking) {
        // День выходной → обновляем на pending
        await query(
          `UPDATE attendance_adjustments SET approval_status = 'pending' WHERE id = $1`,
          [record.id]
        );
        updatedCount++;
        console.log(`✅ ID ${record.id} (${record.source_type}): ${record.work_date} → pending`);
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
