/**
 * Порядок столбцов таблицы, переставленный пользователем (как в Excel): сохранённый список ключей поверх столбцов по
 * умолчанию. Сохранённых, которых нет в таблице (столбец «Общежитие» при выбранном общежитии), — пропускаем; новых в
 * сохранённом нет — ставим сразу после их соседа слева по умолчанию (в начало, если соседа нет).
 */

export const orderColumns = <Column extends { key: string }>(
  columns: ReadonlyArray<Column>,
  order: ReadonlyArray<string>,
): Column[] => {
  if (order.length === 0) return [...columns];
  const byKey = new Map(columns.map(column => [column.key, column]));
  const result: Column[] = [];
  for (const key of order) {
    const column = byKey.get(key);
    if (column && !result.includes(column)) result.push(column);
  }
  columns.forEach((column, index) => {
    if (result.includes(column)) return;
    const left = columns.slice(0, index).reverse().find(item => result.includes(item));
    result.splice(left ? result.indexOf(left) + 1 : 0, 0, column);
  });
  return result;
};

/** Ключ from — на место ключа to: перед ним (before) или после него; порядок остальных не меняется. */
export const moveColumnKey = (
  keys: ReadonlyArray<string>,
  from: string,
  to: string,
  side: 'before' | 'after',
): string[] => {
  if (from === to || !keys.includes(from) || !keys.includes(to)) return [...keys];
  const rest = keys.filter(key => key !== from);
  const index = rest.indexOf(to) + (side === 'after' ? 1 : 0);
  return [...rest.slice(0, index), from, ...rest.slice(index)];
};

const STORAGE_PREFIX = 'registry-column-order:';

export const readColumnOrder = (storageKey: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${STORAGE_PREFIX}${storageKey}`) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

export const writeColumnOrder = (storageKey: string, keys: ReadonlyArray<string>): void => {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${storageKey}`, JSON.stringify(keys));
  } catch {
    // Хранилище недоступно (приватный режим) — порядок живёт до перезагрузки.
  }
};
