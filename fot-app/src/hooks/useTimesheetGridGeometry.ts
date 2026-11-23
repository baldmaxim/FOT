import { useEffect, useState } from 'react';

/** Ширины столбцов сетки табеля по факту отрисовки, px. */
export interface ITimesheetGridGeometry {
  /** Всё до первого дня («Сотрудник»). */
  first: number;
  /** День месяца → ширина столбца. */
  days: ReadonlyMap<number, number>;
  /** Столбцы после дней («Дни / Часы / Откл.») по порядку. */
  totals: readonly number[];
}

/** Расхождение меньше сотой пикселя — та же сетка: без лишней перерисовки на каждый тик ResizeObserver. */
const SAME_WIDTH = 0.01;

const sameWidths = (left: readonly number[], right: readonly number[]): boolean => (
  left.length === right.length && left.every((width, index) => Math.abs(width - right[index]) < SAME_WIDTH)
);

const sameGeometry = (left: ITimesheetGridGeometry | null, right: ITimesheetGridGeometry | null): boolean => {
  if (!left || !right) return left === right;
  return Math.abs(left.first - right.first) < SAME_WIDTH
    && sameWidths(left.totals, right.totals)
    && sameWidths([...left.days.keys()], [...right.days.keys()])
    && sameWidths([...left.days.values()], [...right.days.values()]);
};

/**
 * Сетка из шапки таблицы табеля: дни — заголовки с data-day, до них — «Сотрудник», после — итоги. Ширина заголовка
 * равна шагу столбца и не зависит от прокрутки (закреплённые столбцы сдвигаются, но не меняют ширину).
 */
const readGeometry = (table: HTMLTableElement): ITimesheetGridGeometry | null => {
  const cells = table.tHead?.rows[0]?.cells;
  if (!cells) return null;
  let first = 0;
  const days = new Map<number, number>();
  const totals: number[] = [];
  for (const cell of cells) {
    const width = cell.getBoundingClientRect().width;
    const day = Number(cell.dataset.day);
    if (Number.isInteger(day) && day > 0) days.set(day, width);
    else if (days.size === 0) first += width;
    else totals.push(width);
  }
  return days.size > 0 ? { first, days, totals } : null;
};

/**
 * Фактические ширины столбцов сетки табеля в её блоке прокрутки («По сотруднику»): «График работы» под ней повторяет
 * их день в день. Таблица табеля растягивается на ширину экрана (width: 100%) — и дни, и итоги шире 42 / 64px, а при
 * «1–15» / «16–конец» — заметно; поэтому замер, а не те же числа в CSS. Пересчёт — при любом изменении размера таблицы.
 */
export const useTimesheetGridGeometry = (scrollElement: HTMLElement | null): ITimesheetGridGeometry | null => {
  const [geometry, setGeometry] = useState<ITimesheetGridGeometry | null>(null);

  useEffect(() => {
    if (!scrollElement || typeof ResizeObserver === 'undefined') return undefined;
    let observedTable: HTMLTableElement | null = null;
    const update = () => {
      const table = scrollElement.querySelector<HTMLTableElement>(':scope > table');
      // Таблицу могли заменить (смена режима сетки) — следить за новой.
      if (table !== observedTable) {
        if (observedTable) tableObserver.unobserve(observedTable);
        if (table) tableObserver.observe(table);
        observedTable = table;
      }
      const next = table ? readGeometry(table) : null;
      setGeometry(prev => (sameGeometry(prev, next) ? prev : next));
    };
    const tableObserver = new ResizeObserver(update);
    const scrollObserver = new ResizeObserver(update);
    // Шапка перерисовалась при той же ширине таблицы (другие дни периода) — тоже пересчёт.
    const mutationObserver = new MutationObserver(update);
    scrollObserver.observe(scrollElement);
    mutationObserver.observe(scrollElement, { childList: true, subtree: true });
    update();
    return () => {
      tableObserver.disconnect();
      scrollObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [scrollElement]);

  return scrollElement ? geometry : null;
};
