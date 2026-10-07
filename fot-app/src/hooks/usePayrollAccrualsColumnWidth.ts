import { useMemo } from 'react';

import type { IPayrollTermsRow } from '../services/payrollService';
import { accrualsByMonthParts, accrualsCellWidth, type AccrualTextKind } from '../utils/payrollAccruals';

/** Нет canvas — прежняя ширина под три суммы в строке. */
const FALLBACK_WIDTH = 260;
/** Не уже шапки «НАЧИСЛЕНИЯ, ТЫС. ₽». */
const MIN_WIDTH = 180;
/** Паддинги ячейки (12 + 12) и запас на округление шрифта. */
const CELL_EXTRA = 24 + 4;

/** Шрифты кусков ячейки — как в PayrollTermsTable.module.css (`.accrualMonth`, `.accrualAmount`, `.table`). */
const FONTS: Record<AccrualTextKind, string> = {
  month: 'italic 12px',
  amount: '600 14px',
  text: '13px',
};

let measureContext: CanvasRenderingContext2D | null | undefined;

/** Один canvas на всё приложение — только для measureText. */
const getMeasureContext = (): CanvasRenderingContext2D | null => {
  if (measureContext === undefined) measureContext = document.createElement('canvas').getContext('2d');
  return measureContext;
};

const measureColumnWidth = (rows: IPayrollTermsRow[], months: string[]): number => {
  const context = getMeasureContext();
  if (!context) return FALLBACK_WIDTH;
  const family = getComputedStyle(document.body).fontFamily;
  const cache = new Map<string, number>();
  const measure = (text: string, kind: AccrualTextKind): number => {
    // tabular-nums: все цифры шириной с «0», canvas этого не умеет
    const sample = kind === 'amount' ? text.replace(/\d/g, '0') : text;
    const key = `${kind}|${sample}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    context.font = `${FONTS[kind]} ${family}`;
    const width = context.measureText(sample).width;
    cache.set(key, width);
    return width;
  };

  let widest = 0;
  for (const row of rows) {
    const parts = accrualsByMonthParts(months, row.accruals);
    if (parts !== null) widest = Math.max(widest, accrualsCellWidth(parts, measure));
  }
  return Math.max(MIN_WIDTH, Math.ceil(widest) + CELL_EXTRA);
};

/**
 * Ширина столбца «Начисления» по самой длинной строке среди загруженных сотрудников:
 * пока сумм мало — столбец узкий, появятся суммы за все месяцы — расширится, раскладка 3 + 3 не ломается.
 */
export const usePayrollAccrualsColumnWidth = (rows: IPayrollTermsRow[], months: string[]): number => (
  useMemo(() => measureColumnWidth(rows, months), [rows, months])
);
