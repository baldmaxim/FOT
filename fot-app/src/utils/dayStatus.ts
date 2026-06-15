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
  | 'sick_worked'       // работал на больничном — полный день по графику (бирюзовый)
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
      // На плановый выходной любые часы > 0 = выход на работу (нет смысла сравнивать с нормой дня)
      if (isScheduledDayOff && visibleHours != null && visibleHours > 0) return 'present';
      const hoursOk = visibleHours != null && visibleHours >= fullDayThresholdHours;
      // На выходном/праздничном дне ожидаемой смены нет — span смены не валидируем.
      // Корректировка от руководителя — авторитетна. Для обычных work-записей в рабочий
      // день: если присутствие не покрыло смену (open-entry без exit и shiftDuration > totalMinutes) —
      // день недоработан.
      const spanOk = isScheduledDayOff || entry.is_correction || entry.presence_covers_shift !== false;
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
      // incomplete_skud как сигнал «есть события, но не учтены». На плановом
      // выходном/празднике (график + произв. календарь) неявки быть не может —
      // показываем выходной (зеркалит ветку «нет entry» и default-ветку).
      if (hasSkudEvents) return 'incomplete_skud';
      return isScheduledDayOff ? 'weekend' : 'absent';
    case 'unpaid':
      return 'unpaid';
    case 'educational_leave':
      return 'educational_leave';
    case 'sick_worked':
      return 'sick_worked';
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
  sick_worked: 'ts-day--sick-worked',
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
  sick_worked: 'ts-day-detail-hours--sick-worked',
  weekend: 'ts-day-detail-hours--weekend',
  future: 'ts-day-detail-hours--empty',
  empty: 'ts-day-detail-hours--empty',
};

// Маппинг статуса в CSS-класс ячейки календаря карточки сотрудника (AttendanceCalendar).
// Зеркалит другие маппинги: одно изменение DayStatus = одно место правки.
export const STATUS_TO_CALENDAR_CLASS: Record<DayStatus, string> = {
  present: 'ec-cal-day--full',
  underwork: 'ec-cal-day--partial',
  absent: 'ec-cal-day--absent',
  incomplete_skud: 'ec-cal-day--incomplete-skud',
  sick: 'ec-cal-day--sick',
  vacation: 'ec-cal-day--vacation',
  remote: 'ec-cal-day--remote',
  unpaid: 'ec-cal-day--unpaid',
  educational_leave: 'ec-cal-day--educational',
  sick_worked: 'ec-cal-day--sick-worked',
  weekend: 'ec-cal-day--weekend',
  future: 'ec-cal-day--empty',
  empty: 'ec-cal-day--empty',
};

// Человекочитаемые подписи статусов (для чипа в модалке корректировки и др.).
export const STATUS_LABEL_RU: Record<DayStatus, string> = {
  present: 'Полный день',
  underwork: 'Недобор',
  absent: 'Прогул',
  incomplete_skud: 'СКУД без часов',
  sick: 'Больничный',
  vacation: 'Отпуск',
  remote: 'Удалёнка',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
  sick_worked: 'Работал на больничном',
  weekend: 'Выходной',
  future: 'Будущий день',
  empty: '—',
};
