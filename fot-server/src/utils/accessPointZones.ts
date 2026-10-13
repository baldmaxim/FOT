// Тип зоны точки доступа («внутренняя» / «внешняя») с датой начала действия.
//
// Раньше у точки был один флаг без дат, и любой расчёт за любую дату брал текущее значение:
// 12.10.2026 «кпп ASTERUS» переключили на «внешнюю», и табели за все прошлые месяцы пересчитались.
// Теперь у точки история (skud_access_point_zone_periods, миграция 305), а тип определяется по
// РАБОЧЕЙ ДАТЕ — дню табеля, к которому относится смена. Проход 01.10, закрывающий ночную смену
// 30.09, оценивается по правилу 30.09: иначе смена на границе считалась бы наполовину по-старому.

export interface IAccessPointZonePeriod {
  access_point_name: string;
  is_internal: boolean;
  /** YYYY-MM-DD: с этого рабочего дня (включительно) действует is_internal. */
  effective_from: string;
}

/** Отрезок рабочих дней с неизменным набором внутренних точек. */
export interface IInternalPointsRange {
  from: string;
  to: string;
  internal: ReadonlySet<string>;
}

export interface IInternalPoints {
  /** Внутренняя ли точка для рабочего дня. Точек без истории нет в наборе — они внешние. */
  has: (point: string | null | undefined, workDate: string) => boolean;
  /** Внутренние точки на рабочий день. */
  onDate: (workDate: string) => ReadonlySet<string>;
  /** Период [start; end], разбитый на отрезки с одинаковым набором внутренних точек. */
  ranges: (start: string, end: string) => IInternalPointsRange[];
  periods: () => IAccessPointZonePeriod[];
}

/** Начало истории: точки, отмеченные внутренними до появления дат, считаются такими «с самого начала». */
export const ZONE_HISTORY_START = '2000-01-01';

const isoDay = (value: string): string => String(value).slice(0, 10);

const shiftDay = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export const buildInternalPoints = (source: readonly IAccessPointZonePeriod[]): IInternalPoints => {
  const periods = source
    .map(period => ({
      access_point_name: period.access_point_name.trim(),
      is_internal: Boolean(period.is_internal),
      effective_from: isoDay(period.effective_from),
    }))
    .filter(period => period.access_point_name)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  // Границы — даты, с которых меняется хотя бы одна точка. Между соседними границами набор постоянен.
  const boundaries = [...new Set(periods.map(period => period.effective_from))];
  const sets = new Map<number, ReadonlySet<string>>();

  /** Сколько границ уже наступило к рабочему дню: 0 — до первой записи истории. */
  const epochOf = (workDate: string): number => {
    const day = isoDay(workDate);
    let low = 0;
    let high = boundaries.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (boundaries[middle] <= day) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const setOf = (epoch: number): ReadonlySet<string> => {
    const cached = sets.get(epoch);
    if (cached) return cached;
    const state = new Map<string, boolean>();
    // periods отсортированы по дате: более поздняя запись точки перекрывает раннюю.
    for (const period of periods) {
      if (epoch === 0 || period.effective_from > boundaries[epoch - 1]) break;
      state.set(period.access_point_name, period.is_internal);
    }
    const internal = new Set([...state].filter(([, isInternal]) => isInternal).map(([name]) => name));
    sets.set(epoch, internal);
    return internal;
  };

  return {
    has: (point, workDate) => {
      const name = typeof point === 'string' ? point.trim() : '';
      return name !== '' && setOf(epochOf(workDate)).has(name);
    },
    onDate: workDate => setOf(epochOf(workDate)),
    ranges: (start, end) => {
      const from = isoDay(start);
      const to = isoDay(end);
      if (from > to) return [];
      const result: IInternalPointsRange[] = [];
      let cursor = from;
      for (const boundary of boundaries) {
        if (boundary <= cursor) continue;
        if (boundary > to) break;
        result.push({ from: cursor, to: shiftDay(boundary, -1), internal: setOf(epochOf(cursor)) });
        cursor = boundary;
      }
      result.push({ from: cursor, to, internal: setOf(epochOf(cursor)) });
      return result;
    },
    periods: () => periods.map(period => ({ ...period })),
  };
};

/** Точки, внутренние «всегда» — для тестов и мест, где история не нужна. */
export const alwaysInternalPoints = (names: Iterable<string>): IInternalPoints =>
  buildInternalPoints([...names].map(name => ({ access_point_name: name, is_internal: true, effective_from: ZONE_HISTORY_START })));
