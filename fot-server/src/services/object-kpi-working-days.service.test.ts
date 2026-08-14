/**
 * Срок фиксации плана — N-й рабочий день месяца. Правила «не суббота/воскресенье и
 * не праздник» недостаточно: в месяце с перенесённой рабочей субботой вычисленный
 * день разошёлся бы с официальным календарём, и месяц закрылся бы не в тот день.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { queryOne } from '../config/postgres.js';
import { getNthWorkingDay } from './object-kpi-working-days.service.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getNthWorkingDay', () => {
  it('считает обычный месяц: сентябрь 2026 начинается со вторника', async () => {
    (queryOne as Mock).mockResolvedValue({ holidays: [], mandatory_holidays: [], working_weekends: [] });

    // 01.09 вт, 02 ср, 03 чт, 04 пт, 05-06 выходные, 07 пн — пятый рабочий.
    await expect(getNthWorkingDay(2026, 9, 5)).resolves.toBe('2026-09-07');
  });

  it('пропускает праздники', async () => {
    (queryOne as Mock).mockResolvedValue({
      holidays: ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'],
      mandatory_holidays: [],
      working_weekends: [],
    });

    // Январь 2026: 01-08 каникулы (03-04 — выходные), первый рабочий — 09.01.
    await expect(getNthWorkingDay(2026, 1, 1)).resolves.toBe('2026-01-09');
  });

  it('засчитывает перенесённую рабочую субботу', async () => {
    (queryOne as Mock).mockResolvedValue({
      holidays: ['2026-09-03'],           // будний день объявлен нерабочим
      mandatory_holidays: [],
      working_weekends: ['2026-09-05'],   // суббота отработана взамен
    });

    // 01, 02, 04, 05(сб) — четвёртый рабочий приходится на субботу.
    await expect(getNthWorkingDay(2026, 9, 4)).resolves.toBe('2026-09-05');
  });

  it('нет месяца в календаре → null (фиксация не выполняется)', async () => {
    (queryOne as Mock).mockResolvedValue(null);
    await expect(getNthWorkingDay(2030, 5, 5)).resolves.toBeNull();
  });

  it('рабочих дней меньше, чем N → null, а не последний день месяца', async () => {
    (queryOne as Mock).mockResolvedValue({
      holidays: Array.from({ length: 31 }, (_, i) => `2026-01-${String(i + 1).padStart(2, '0')}`),
      mandatory_holidays: [],
      working_weekends: [],
    });
    await expect(getNthWorkingDay(2026, 1, 5)).resolves.toBeNull();
  });
});
