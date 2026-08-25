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

// Универсальные форматтеры переехали в utils/dateCompact — их использует и
// список заявлений, который теперь выглядит так же. Реэкспорт оставлен, чтобы
// не трогать импорты этой страницы.
export {
  WEEKDAY_SHORT_RU,
  MONTH_GENITIVE_SHORT_RU,
  formatDateCompact,
  formatDateTimeShort,
  formatHM,
} from '../../utils/dateCompact';

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
