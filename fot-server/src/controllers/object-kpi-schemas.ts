import { z } from 'zod';

/**
 * Общие zod-примитивы KPI-контура.
 *
 * Вынесены из object-kpi-entries.controller.ts, чтобы контроллер КС-6 не тянул за собой
 * весь ввод договоров и не заводил собственные копии: разъехавшиеся регулярки дат и денег
 * дают разное поведение на соседних формах одной карточки.
 */

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ожидается YYYY-MM-DD');
export const moneySchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d{1,2})?$/)]);

/**
 * «Первый расчётный месяц» — это МЕСЯЦ, а не дата: в БД на колонке стоит
 * CHECK (EXTRACT(day FROM plan_start_month) = 1). Приводим к 1-му числу здесь, а не
 * надеемся на форму: клиент не единственный источник запросов, а нарушение констрейнта
 * пользователю ничего не объясняет.
 */
export const monthSchema = z.string()
  .regex(/^\d{4}-\d{2}(-\d{2})?$/, 'Ожидается YYYY-MM')
  .transform((value) => `${value.slice(0, 7)}-01`);

export const versionSchema = z.coerce.number().int().min(1);
export const uuidSchema = z.string().uuid();
