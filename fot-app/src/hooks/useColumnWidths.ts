import { useCallback, useState } from 'react';

import { readColumnWidths, writeColumnWidths, type ColumnWidths } from '../utils/columnWidths';

const NONE: ColumnWidths = {};

export interface IColumnWidthsState {
  /** Заданные пользователем ширины по ключу столбца, px. */
  widths: ColumnWidths;
  /** Задать ширину столбца; без storageKey — undefined (ширина не меняется). */
  setWidth?: (columnKey: string, width: number) => void;
}

/**
 * Ширины столбцов таблицы-реестра, заданные пользователем (как в Excel): в localStorage по ключу таблицы
 * (storageKey — «housing.dormitory»). Без ключа — ширины считает таблица сама («Справочник» «Зарплаты»).
 */
export const useColumnWidths = (storageKey: string | undefined): IColumnWidthsState => {
  const [widths, setWidths] = useState<ColumnWidths>(() => (storageKey ? readColumnWidths(storageKey) : NONE));

  const setWidth = useCallback((columnKey: string, width: number) => {
    if (!storageKey) return;
    const next = { ...widths, [columnKey]: width };
    setWidths(next);
    writeColumnWidths(storageKey, next);
  }, [storageKey, widths]);

  return storageKey ? { widths, setWidth } : { widths: NONE };
};
