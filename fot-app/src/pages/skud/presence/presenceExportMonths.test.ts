import { describe, expect, it } from 'vitest';
import {
  buildMonthOptions,
  formatMonthLabel,
  monthFileSuffix,
  monthRange,
  shiftMonth,
} from './presenceExportMonths';

describe('presenceExportMonths', () => {
  it('12 месяцев: текущий и 11 предыдущих, через границу года', () => {
    const options = buildMonthOptions('2026-11-09');
    expect(options).toHaveLength(12);
    expect(options[0]).toEqual({ value: '2026-11', label: 'Ноябрь 2026' });
    expect(options[1].value).toBe('2026-10');
    expect(options[11]).toEqual({ value: '2025-12', label: 'Декабрь 2025' });
  });

  it('январь → декабрь прошлого года и обратно', () => {
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
  });

  it('диапазон: прошлый месяц целиком, текущий — по сегодня', () => {
    expect(monthRange('2026-09', '2026-11-09')).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(monthRange('2026-11', '2026-11-09')).toEqual({ from: '2026-11-01', to: '2026-11-09' });
    expect(monthRange('2026-12', '2026-12-01')).toEqual({ from: '2026-12-01', to: '2026-12-01' });
  });

  it('февраль високосного и обычного года', () => {
    expect(monthRange('2028-02', '2028-05-01').to).toBe('2028-02-29');
    expect(monthRange('2027-02', '2027-05-01').to).toBe('2027-02-28');
  });

  it('подписи', () => {
    expect(formatMonthLabel('2026-09')).toBe('Сентябрь 2026');
    expect(monthFileSuffix('2026-09')).toBe('сентябрь_2026');
  });
});
