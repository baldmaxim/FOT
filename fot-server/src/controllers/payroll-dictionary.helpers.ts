/**
 * Общее для справочников «Зарплаты» (виды удержаний, ставки): схема названия, id из пути,
 * ответ на ошибку проверки.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';

/** Пробелы внутри схлопываются: «Штраф  за мусор» и «Штраф за мусор» — одно название. */
export const payrollDictionaryNameSchema = (emptyMessage: string) => z.string()
  .transform(value => value.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1, emptyMessage).max(100, 'Не больше 100 символов'));

/** :id записи справочника; не целое положительное — null (записи с таким id быть не может). */
export const parsePayrollDictionaryId = (req: AuthenticatedRequest): number | null => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export const handlePayrollZodError = (error: unknown, res: Response): boolean => {
  if (error instanceof z.ZodError) {
    res.status(400).json({ success: false, error: error.errors[0]?.message ?? 'Некорректные данные' });
    return true;
  }
  return false;
};
