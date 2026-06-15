import type { TimeStatus } from '../../types/index.js';

// Округление десятичных часов до 0.01ч (≈36 сек). Защита от float-дрейфа при
// агрегации: `* 100 → Math.round → / 100` даёт точные центичасы, без накопления
// двоичных хвостов. Применяется на ВЫХОДЕ — после сложений/конвертаций.
export const roundHours = (value: number): number => Math.round(value * 100) / 100;

// Минуты → часы с тем же округлением. Используется там, где исходные данные —
// минуты (СКУД-присутствие, travel-кредиты): чтобы не плодить выражение
// `roundHours(minutes / 60)` по коду.
export const minutesToHours = (minutes: number): number => roundHours(minutes / 60);

// Какая корректировка дня авторитетна (определяет entry.hours_worked).
// manual — ручная правка руководителя, перекрывает всё.
// leave_request — одобренная заявка на отпуск/больничный.
// legacy_tender_timesheet — историческая корректировка из старого табеля.
// Используется и для агрегации по дню (attendance.service), и для разбивки
// по объектам (timesheet-object.service): обе ветки должны выбирать одну
// и ту же запись, иначе табель и разрез «по объектам» покажут разные часы.
export const ADJUSTMENT_PRIORITY: Record<string, number> = {
  manual: 300,
  leave_request: 200,
  legacy_tender_timesheet: 100,
};

export const getAdjustmentPriority = (sourceType: string): number => (
  ADJUSTMENT_PRIORITY[sourceType] ?? 0
);

// Статусы без реально отработанного времени. В выходной/праздник такие
// корректировки дают 0 часов: иначе при норме 0 любые часы превращаются
// в переработку.
export const NON_WORK_ADJUSTMENT_STATUSES = new Set<TimeStatus>([
  'absent', 'sick', 'vacation', 'dayoff', 'unpaid', 'educational_leave', 'remote', 'sick_worked',
]);

// Статусы отсутствия, которые засчитываются как полный рабочий день при
// пустом hours_override: часы берутся из планового графика. Для удалёнки
// исторически уже работало; то же распространено на отпуск/больничный и т.п. —
// иначе в табеле они показывались как недоработка.
export const ABSENCE_STATUSES_AS_WORKED = new Set<TimeStatus>([
  'vacation', 'sick', 'dayoff', 'remote', 'educational_leave', 'unpaid', 'absent', 'sick_worked',
]);
