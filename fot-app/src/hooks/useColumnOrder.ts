import { useCallback, useMemo, useState } from 'react';

import { moveColumnKey, orderColumns, readColumnOrder, writeColumnOrder } from '../utils/columnOrder';

export interface IColumnOrder<Column> {
  /** Столбцы в порядке пользователя (без storageKey — как переданы). */
  columns: Column[];
  /** Переставить столбец from к столбцу to; без storageKey — undefined (перестановки нет). */
  move?: (from: string, to: string, side: 'before' | 'after') => void;
}

/**
 * Порядок столбцов таблицы-реестра, переставленный пользователем: в localStorage по ключу таблицы
 * (storageKey — «housing.dormitory»). Без ключа — таблица как есть («Справочник» «Зарплаты»).
 */
export const useColumnOrder = <Column extends { key: string }>(
  storageKey: string | undefined,
  columns: ReadonlyArray<Column>,
): IColumnOrder<Column> => {
  const [order, setOrder] = useState<string[]>(() => (storageKey ? readColumnOrder(storageKey) : []));
  const ordered = useMemo(() => (storageKey ? orderColumns(columns, order) : [...columns]), [storageKey, columns, order]);

  const move = useCallback((from: string, to: string, side: 'before' | 'after') => {
    if (!storageKey) return;
    const next = moveColumnKey(ordered.map(column => column.key), from, to, side);
    setOrder(next);
    writeColumnOrder(storageKey, next);
  }, [storageKey, ordered]);

  return storageKey ? { columns: ordered, move } : { columns: ordered };
};
