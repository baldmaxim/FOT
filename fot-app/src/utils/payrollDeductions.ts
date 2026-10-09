/**
 * Фильтр «Удержания» на «Расчётах»: набор отмеченных видов справочника.
 * Порядок набора — как в справочнике, чтобы подпись и ключ запроса не зависели от порядка кликов.
 */
import type { IPayrollDeductionKind } from '../services/payrollService';

/** Отметить или снять вид; результат — в порядке справочника. Вида нет в справочнике — в конец. */
export const toggleDeductionKind = (
  selected: readonly number[],
  kindId: number,
  checked: boolean,
  kinds: readonly IPayrollDeductionKind[],
): number[] => {
  const next = new Set(selected);
  if (checked) next.add(kindId);
  else next.delete(kindId);
  const order = new Map(kinds.map((kind, index) => [kind.id, index]));
  return [...next].sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a - b);
};

/** Подпись кнопки «Удержания»: «Питание, Спецодежда»; ничего не отмечено — ''. Неизвестные id пропускаются. */
export const formatDeductionKinds = (
  selected: readonly number[],
  kinds: readonly IPayrollDeductionKind[],
): string => {
  const names = new Map(kinds.map(kind => [kind.id, kind.name]));
  return selected.map(id => names.get(id)).filter((name): name is string => Boolean(name)).join(', ');
};
