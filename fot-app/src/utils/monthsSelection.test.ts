import { describe, expect, it } from 'vitest';

import { formatMonthsLabel, toggleMonthSelection } from './monthsSelection';

describe('formatMonthsLabel', () => {
  it('подпись: один месяц, подряд — диапазоном, вразброс — перечнем', () => {
    expect(formatMonthsLabel(['2026-08'])).toBe('август 2026');
    expect(formatMonthsLabel(['2026-09', '2026-07', '2026-08'])).toBe('июль 2026 — сентябрь 2026');
    expect(formatMonthsLabel(['2026-09', '2026-07'])).toBe('июль 2026, сентябрь 2026');
    expect(formatMonthsLabel([])).toBe('');
  });
});

describe('toggleMonthSelection', () => {
  it('добавляет месяц по порядку', () => {
    expect(toggleMonthSelection(['2026-09'], '2026-07', false)).toEqual(['2026-07', '2026-09']);
    expect(toggleMonthSelection(['2026-01'], '2025-12', true)).toEqual(['2025-12', '2026-01']);
  });

  it('снимает отмеченный месяц', () => {
    expect(toggleMonthSelection(['2026-07', '2026-09'], '2026-07', false)).toEqual(['2026-09']);
  });

  it('без пустого выбора последний месяц не снимается', () => {
    expect(toggleMonthSelection(['2026-09'], '2026-09', false)).toEqual(['2026-09']);
  });

  it('с пустым выбором («Весь период») последний месяц снимается', () => {
    expect(toggleMonthSelection(['2026-09'], '2026-09', true)).toEqual([]);
  });
});
