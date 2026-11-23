import { useCallback, useRef, useState } from 'react';

import { readColumnWidths, writeColumnWidths, type ColumnWidths } from '../utils/columnWidths';

const NONE: ColumnWidths = {};

export interface IColumnWidthsState {
  /** Заданные пользователем ширины по ключу столбца, px. */
  widths: ColumnWidths;
  /** Задать ширину столбца; без storageKey — undefined (ширина не меняется). */
  setWidth?: (columnKey: string, width: number) => void;
  /**
   * Задать ширины нескольких столбцов разом (слиянием с прежними, одной записью в хранилище): «Расчёты» при первой
   * правке запоминают фактические ширины всех видимых столбцов. Без storageKey — undefined.
   */
  setWidths?: (patch: ColumnWidths) => void;
}

/**
 * Ширины столбцов таблицы-реестра, заданные пользователем (как в Excel): в localStorage по ключу таблицы
 * (storageKey — «housing.dormitory»). Без ключа — ширины считает таблица сама («Справочник» «Зарплаты»).
 */
export const useColumnWidths = (storageKey: string | undefined): IColumnWidthsState => {
  const [widths, setWidthsState] = useState<ColumnWidths>(() => (storageKey ? readColumnWidths(storageKey) : NONE));
  // Последний записанный снимок, а не захваченный в замыкании: два вызова подряд не затирают друг друга.
  const latestRef = useRef(widths);

  const setWidths = useCallback((patch: ColumnWidths) => {
    if (!storageKey) return;
    const next = { ...latestRef.current, ...patch };
    latestRef.current = next;
    setWidthsState(next);
    writeColumnWidths(storageKey, next);
  }, [storageKey]);

  const setWidth = useCallback((columnKey: string, width: number) => {
    setWidths({ [columnKey]: width });
  }, [setWidths]);

  return storageKey ? { widths, setWidth, setWidths } : { widths: NONE };
};
