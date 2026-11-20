import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  autofitColumnWidth,
  clampColumnWidth,
  COLUMN_AUTOFIT_MAX_WIDTH,
  COLUMN_MAX_WIDTH,
  COLUMN_MIN_WIDTH,
  readColumnWidths,
  writeColumnWidths,
} from './columnWidths';

describe('ширина столбцов, как в Excel («Проживание»)', () => {
  it('тянуть — не уже минимума и не шире максимума, целые пиксели', () => {
    expect(clampColumnWidth(20)).toBe(COLUMN_MIN_WIDTH);
    expect(clampColumnWidth(5000)).toBe(COLUMN_MAX_WIDTH);
    expect(clampColumnWidth(212.6)).toBe(213);
  });

  it('двойной клик — по самому длинному тексту с отступами или по подписи, что шире; не шире предела', () => {
    // «Абдувохидов Хайрулла Шаробидинович» одной строкой.
    expect(autofitColumnWidth([120, 241.3, 90], 28, 130)).toBe(270);
    // Короткие значения — по подписи с иконками.
    expect(autofitColumnWidth([40, 52], 28, 150.2)).toBe(151);
    // Длинный комментарий — не шире предела; пустой столбец — не уже минимума.
    expect(autofitColumnWidth([1200], 28, 100)).toBe(COLUMN_AUTOFIT_MAX_WIDTH);
    expect(autofitColumnWidth([], 28, 0)).toBe(COLUMN_MIN_WIDTH);
  });

  describe('localStorage', () => {
    // Тесты фронта — в node: хранилище — простая подмена.
    beforeEach(() => {
      const store = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('по ключу таблицы; мусор — пропускается, значения — в пределах', () => {
      writeColumnWidths('housing.dormitory', { full_name: 270, passport: 120 });
      expect(readColumnWidths('housing.dormitory')).toEqual({ full_name: 270, passport: 120 });
      expect(readColumnWidths('housing.compensation')).toEqual({});
      localStorage.setItem('registry-column-widths:housing.apartments', '{oops');
      expect(readColumnWidths('housing.apartments')).toEqual({});
      localStorage.setItem('registry-column-widths:housing.apartments', '{"a": 10, "b": "x", "c": 300}');
      expect(readColumnWidths('housing.apartments')).toEqual({ a: COLUMN_MIN_WIDTH, c: 300 });
      localStorage.setItem('registry-column-widths:housing.apartments', '[1, 2]');
      expect(readColumnWidths('housing.apartments')).toEqual({});
    });
  });
});
