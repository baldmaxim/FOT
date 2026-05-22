/**
 * Одноразовая ремедиация: удалёнка (`remote`) в выходной день, созданная до
 * фикса nullish-coalescing, сохранена с `hours_override = 0`. Из-за нулевых
 * часов `resolveAdjustmentApprovalStatus` ставил `auto_approved` вместо
 * `pending`, и корректировка не попадала на страницу «Согласование
 * корректировок».
 *
 * У статуса `remote` часы всегда деривируются из графика — значение `0`
 * возможно ТОЛЬКО из-за этой ошибки (в отличие от `work`, где 0 ч легитимен:
 * «не работал»). Поэтому `status='remote' AND hours_override=0` однозначно
 * идентифицирует баг.
 *
 * Шаги:
 *   1. hours_override 0 → 8 для всех таких записей.
 *   2. reapproveAdjustmentsForRange пересчитывает approval_status по штатной
 *      логике (учитывает бригады и зачётные субботы) уже на 8 ч.
 *
 * Запуск (на проде, после деплоя бэка): cd fot-server && npx tsx scripts/fix-remote-weekend-hours.ts
 * Идемпотентен — повторный запуск не найдёт записей с 0 ч.
 */
import { query } from '../src/config/postgres.js';
import { reapproveAdjustmentsForRange } from '../src/controllers/timesheet.controller.js';

interface IFixedRow {
  id: number;
  employee_id: number;
  work_date: string;
}

const main = async (): Promise<void> => {
  const fixed = await query<IFixedRow>(
    `UPDATE attendance_adjustments
        SET hours_override = 8, updated_at = now()
      WHERE status = 'remote' AND hours_override = 0
      RETURNING id, employee_id, work_date::text AS work_date`,
  );

  if (fixed.length === 0) {
    console.log('[fix-remote-weekend-hours] нечего чинить — записей remote с 0 ч нет.');
    return;
  }

  const employeeIds = [...new Set(fixed.map(r => Number(r.employee_id)))];
  const dates = fixed.map(r => r.work_date).sort();
  const minDate = dates[0];
  const maxDate = dates[dates.length - 1];

  console.log(`[fix-remote-weekend-hours] hours_override 0 → 8: ${fixed.length} записей, `
    + `${employeeIds.length} сотрудников, диапазон ${minDate}..${maxDate}`);
  for (const r of fixed) {
    console.log(`  id=${r.id} employee_id=${r.employee_id} work_date=${r.work_date}`);
  }

  const changed = await reapproveAdjustmentsForRange(employeeIds, minDate, maxDate);
  console.log(`[fix-remote-weekend-hours] approval_status пересчитан: изменено ${changed} строк.`);
  console.log('[fix-remote-weekend-hours] готово.');
};

main().catch(err => {
  console.error('[fix-remote-weekend-hours] фатальная ошибка:', err);
  process.exit(1);
});
