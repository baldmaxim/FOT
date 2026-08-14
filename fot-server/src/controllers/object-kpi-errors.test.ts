/**
 * Разбор ошибок ввода в KPI-контуре.
 *
 * Оба кейса — из реального отказа на проде: договор с датой середины месяца в поле
 * «Первый расчётный месяц» нарушал CHECK, а необработанный код PostgreSQL превращался
 * в «Внутреннюю ошибку сервера», по которой понять причину было невозможно.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { mapDatabaseError } from './object-kpi.controller.js';
import { monthSchema } from './object-kpi-entries.controller.js';

describe('monthSchema', () => {
  it('дата середины месяца приводится к первому числу', () => {
    // Ровно то значение, на котором падало создание договора.
    expect(monthSchema.parse('2026-01-14')).toBe('2026-01-01');
  });

  it('месяц в формате YYYY-MM тоже принимается', () => {
    expect(monthSchema.parse('2025-01')).toBe('2025-01-01');
  });

  it('мусор отвергается до похода в БД', () => {
    expect(() => monthSchema.parse('январь')).toThrow();
    expect(() => monthSchema.parse('')).toThrow();
  });
});

describe('mapDatabaseError', () => {
  it('нарушенный CHECK отдаёт 400 с человеческим текстом', () => {
    const result = mapDatabaseError({
      code: '23514',
      constraint: 'object_contracts_plan_start_month_check',
    });

    expect(result).toMatchObject({ http: 400, code: 'check_violation' });
    expect(result?.message).toContain('месяц');
  });

  it('незнакомый CHECK всё равно 400, а не 500', () => {
    const result = mapDatabaseError({ code: '23514', constraint: 'some_future_check' });
    expect(result).toMatchObject({ http: 400, message: 'Данные не прошли проверку базы' });
  });

  it('пересечение периодов — 409', () => {
    expect(mapDatabaseError({ code: '23P01' })).toMatchObject({ http: 409, code: 'period_overlap' });
  });

  it('битая дата или переполнение суммы — 400', () => {
    expect(mapDatabaseError({ code: '22P02' })?.http).toBe(400);
    expect(mapDatabaseError({ code: '22003' })?.http).toBe(400);
  });

  it('всё остальное остаётся 500: сбой сервера не маскируем под ошибку ввода', () => {
    expect(mapDatabaseError({ code: '08006' })).toBeNull();
    expect(mapDatabaseError(new Error('boom'))).toBeNull();
  });
});
