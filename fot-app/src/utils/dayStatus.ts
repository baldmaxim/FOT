import type { TimesheetEntry } from '../types/timesheet';
import { selectVisibleHours } from './hoursDisplay';

// Канонический набор статусов дня — единый источник правды для окраски в табеле,
// боковой панели табеля и календаре карточки сотрудника. Каждое UI-место мапит
// этот статус в свой набор CSS-классов (см. STATUS_TO_GRID_CLASS,
// STATUS_TO_DETAIL_HOURS_CLASS), но сама логика принятия решения — здесь.
export type DayStatus =
  | 'present'           // полная норма часов в рабочий день (зелёный)
  | 'underwork'         // недобор часов / span смены не покрыт (жёлтый)
  | 'absent'            // прогул, нет присутствия (красный)
  | 'incomplete_skud'   // СКУД-события есть, но часов нет (magenta)
  | 'sick'              // больничный (синий)
  | 'vacation'          // отпуск / отгул (фиолетовый)
  | 'remote'            // удалёнка (светло-зелёный)
  | 'unpaid'            // за свой счёт (жёлтый)
  | 'educational_leave' // учебный отпуск (фиолетовый)
  | 'weekend'           // плановый выходной без entry (серый)
  | 'future'            // будущий день
  | 'empty';            // прошлый день без entry и без СКУД-сигналов (нейтрально)

export interface IGetDayStatusOptions {
  // Per-role «Факт / Урезанные часы» (system_roles.show_actual_hours):
  // влияет на то, какое поле часов считать видимым.
  showActualHours: boolean;
  // Порог «полного дня» в часах с учётом графика, предпраздничного дня (-1ч)
  // и day_overrides — должен совпадать с тем, что использует Grid и Calendar.
  fullDayThresholdHours: number;
  // День помечен как выходной по графику сотрудника (с учётом производственного календаря).
  isScheduledDayOff: boolean;
  // День в будущем (текущий месяц, > today). Для прошлых месяцев — false.
  isFuture?: boolean;
  // Есть СКУД-события (внешние) на дату, но в табеле нет entry — используется
  // карточкой сотрудника, чтобы пустой день с проходами помечался incomplete_skud,
  // а не absent. Для табеля можно не передавать.
  hasExternalSkud?: boolean;
}

export const getDayStatus = (
  entry: TimesheetEntry | null | undefined,
  options: IGetDayStatusOptions,
): DayStatus => {
  const { showActualHours, fullDayThresholdHours, isScheduledDayOff, isFuture, hasExternalSkud } = options;

  if (!entry) {
    if (isFuture) return 'future';
    if (isScheduledDayOff) return 'weekend';
    if (hasExternalSkud) return 'incomplete_skud';
    return 'absent';
  }

  const visibleHours = selectVisibleHours(entry, showActualHours);
  // hasExternalSkud (карточка сотрудника, today): живые СКУД-события могут уже идти,
  // даже если бэк ещё не положил их в entry.first_entry / last_exit.
  const hasSkudEvents = Boolean(entry.first_entry || entry.last_exit) || Boolean(hasExternalSkud);
  const zeroHours = visibleHours == null || visibleHours <= 0;
  const incompleteSkud = hasSkudEvents && zeroHours;

  switch (entry.status) {
    case 'work':
    case 'manual': {
      if (incompleteSkud) return 'incomplete_skud';
      const hoursOk = visibleHours != null && visibleHours >= fullDayThresholdHours;
      // Корректировка от руководителя — авторитетна, span смены не валидируем.
      // Для обычных work-записей: если присутствие не покрыло смену (open-entry без exit
      // и shiftDuration > totalMinutes) — день недоработан.
      const spanOk = entry.is_correction || entry.presence_covers_shift !== false;
      return hoursOk && spanOk ? 'present' : 'underwork';
    }
    case 'remote':
      return 'remote';
    case 'sick':
      return 'sick';
    case 'vacation':
    case 'dayoff':
      return 'vacation';
    case 'absent':
      // Если есть СКУД-проходы, но руководитель пометил «неявка» — показываем
      // incomplete_skud как сигнал «есть события, но не учтены».
      return hasSkudEvents ? 'incomplete_skud' : 'absent';
    case 'unpaid':
      return 'unpaid';
    case 'educational_leave':
      return 'educational_leave';
    default:
      return isScheduledDayOff ? 'weekend' : 'absent';
  }
};

// Маппинг статуса в CSS-класс ячейки основной таблицы табеля (TimesheetGrid).
export const STATUS_TO_GRID_CLASS: Record<DayStatus, string> = {
  present: 'ts-day--full',
  underwork: 'ts-day--partial',
  absent: 'ts-day--absent',
  incomplete_skud: 'ts-day--incomplete-skud',
  sick: 'ts-day--sick',
  vacation: 'ts-day--vacation',
  remote: 'ts-day--remote',
  unpaid: 'ts-day--unpaid',
  educational_leave: 'ts-day--educational',
  weekend: 'ts-day--weekend',
  future: 'ts-day--empty',
  empty: 'ts-day--empty',
};

// Маппинг статуса в CSS-класс часов в боковой панели табеля (TimesheetSidePanel).
export const STATUS_TO_DETAIL_HOURS_CLASS: Record<DayStatus, string> = {
  present: 'ts-day-detail-hours--full',
  underwork: 'ts-day-detail-hours--partial',
  absent: 'ts-day-detail-hours--absent',
  incomplete_skud: 'ts-day-detail-hours--incomplete-skud',
  sick: 'ts-day-detail-hours--sick',
  vacation: 'ts-day-detail-hours--vacation',
  remote: 'ts-day-detail-hours--remote',
  unpaid: 'ts-day-detail-hours--unpaid',
  educational_leave: 'ts-day-detail-hours--educational',
  weekend: 'ts-day-detail-hours--absent',
  future: 'ts-day-detail-hours--absent',
  empty: 'ts-day-detail-hours--absent',
};
