import type { ICorrectionDepartmentGroup } from '../../services/correctionApprovalService';

// На согласование выходных дней попадают только статусы work/remote, а также
// manual (work, прицепленная к СКУД-объекту в POST /api/timesheet). Все они по
// смыслу = «Работа» или «Удалёнка», поэтому manual/work показываем как «Работа».
export const STATUS_LABELS: Record<string, string> = {
  work: 'Дополнительная плата',
  remote: 'Удалёнка',
  sick: 'Больничный',
  vacation: 'Отпуск',
  absent: 'Неявка',
  manual: 'Работа',
  dayoff: 'Отгул',
  unpaid: 'За свой счёт',
  educational_leave: 'Учебный отпуск',
};

export const STATUS_ICONS: Record<string, string> = {
  work: '✔',
  remote: '🏠',
  sick: '🏥',
  vacation: '🏖',
  absent: '❌',
  manual: '✔',
  dayoff: '📅',
  unpaid: '💸',
  educational_leave: '🎓',
};

export const WEEKDAY_SHORT_RU = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
export const MONTH_GENITIVE_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export const formatDateCompact = (iso: string): { day: string; weekday: string } => {
  const d = new Date(iso + 'T00:00:00');
  return {
    day: `${d.getDate()} ${MONTH_GENITIVE_SHORT_RU[d.getMonth()]}`,
    weekday: WEEKDAY_SHORT_RU[d.getDay()].toLowerCase(),
  };
};

export const formatDateTimeShort = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDate();
  const m = MONTH_GENITIVE_SHORT_RU[d.getMonth()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${m}, ${hh}:${mm}`;
};

export const formatHM = (decimal: number | null): string => {
  if (decimal == null) return '—';
  const h = Math.floor(decimal);
  const m = Math.round((decimal - h) * 60);
  if (m === 0) return `${h}ч`;
  return `${h}ч ${m}м`;
};

// Оптимистичное удаление обработанных записей из кэша списка: строки пропадают
// с экрана сразу, не дожидаясь фонового refetch'а. Пустые группы выкидываются,
// счётчики пересчитываются.
export const removeItemsByIds = (
  groups: ICorrectionDepartmentGroup[] | undefined,
  ids: number[],
): ICorrectionDepartmentGroup[] | undefined => {
  if (!groups) return groups;
  const toRemove = new Set(ids);
  return groups
    .map(group => {
      const items = group.items.filter(item => !toRemove.has(item.id));
      if (items.length === group.items.length) return group;
      const employees = new Set(items.map(it => it.employee_id));
      return { ...group, items, pending_count: items.length, employees_count: employees.size };
    })
    .filter(group => group.items.length > 0);
};
