/** Строка распределения часов по объектам в форме корректировки. */
export interface IAllocationDraft {
  object_id: string;
  hours: number;
}

/** Вес объекта из подсказки СКУД — в минутах. */
export interface IAllocationWeight {
  object_id: string;
  minutes: number;
}

/**
 * Раскладывает введённые часы по весам подсказки методом наибольшего остатка:
 * сумма долей точно равна итогу, копейки не теряются. Нулевые веса (объект известен,
 * минут нет) делят часы поровну.
 */
export const distributeHours = (
  slices: ReadonlyArray<IAllocationWeight>,
  hours: number,
): IAllocationDraft[] => {
  if (slices.length === 0) return [];
  const total = Math.round(hours * 100);
  const weights = slices.map(slice => Math.max(0, slice.minutes));
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const effective = weightSum > 0 ? weights : slices.map(() => 1);
  const effectiveSum = effective.reduce((sum, value) => sum + value, 0);

  const exact = effective.map(value => (total * value) / effectiveSum);
  const centi = exact.map(value => Math.floor(value));
  let distributed = centi.reduce((sum, value) => sum + value, 0);
  const byFraction = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((left, right) => right.frac - left.frac);
  for (let k = 0; distributed < total; k += 1) {
    centi[byFraction[k % centi.length].index] += 1;
    distributed += 1;
  }
  return slices.map((slice, index) => ({ object_id: slice.object_id, hours: centi[index] / 100 }));
};

/**
 * Распределение после смены итога часов.
 *
 * «Весь день на одном объекте» следует за итогом всегда, даже если объект выбран
 * вручную: иначе порядок «объект → часы» оставлял на объекте старые часы, сумма
 * расходилась с итогом, и «Сохранить» гасла без подсказки. Разбивку, которую человек
 * правил руками, не трогаем — расхождение там видно в строке «Распределено X из Y ч».
 * Нетронутая разбивка идёт по весам подсказки.
 *
 * Если менять нечего, возвращает тот же массив — React пропустит перерисовку.
 */
export const syncAllocationsWithHours = (
  prev: IAllocationDraft[],
  hours: number,
  mode: 'single' | 'split',
  touched: boolean,
  suggested: ReadonlyArray<IAllocationWeight>,
): IAllocationDraft[] => {
  if (touched && mode === 'split') return prev;
  if (prev.length === 0) return prev;
  if (prev.length === 1) return prev[0].hours === hours ? prev : [{ ...prev[0], hours }];
  const slices = prev.map(item => {
    const hint = suggested.find(slice => slice.object_id === item.object_id);
    return { object_id: item.object_id, minutes: hint?.minutes ?? Math.round(item.hours * 60) };
  });
  return distributeHours(slices, hours);
};
