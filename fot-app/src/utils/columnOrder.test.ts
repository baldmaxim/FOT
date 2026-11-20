import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { moveColumnKey, orderColumns, readColumnOrder, writeColumnOrder } from './columnOrder';

const columns = (...keys: string[]) => keys.map(key => ({ key }));
const keysOf = (list: ReadonlyArray<{ key: string }>) => list.map(column => column.key);

describe('порядок столбцов («Проживание»)', () => {
  it('сохранённого нет — как по умолчанию; есть — в его порядке', () => {
    expect(keysOf(orderColumns(columns('a', 'b', 'c'), []))).toEqual(['a', 'b', 'c']);
    expect(keysOf(orderColumns(columns('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('сохранённых столбцов нет в таблице — пропускаются; нового нет в сохранённом — после соседа слева', () => {
    // «Общежитие» (address) скрыто при выбранном общежитии — порядок остальных тот же.
    expect(keysOf(orderColumns(columns('department', 'full_name', 'passport'), ['passport', 'full_name', 'address', 'department'])))
      .toEqual(['passport', 'full_name', 'department']);
    // Сохранили без «Общежития» — оно встаёт после «Сотрудника», как по умолчанию.
    expect(keysOf(orderColumns(columns('department', 'full_name', 'address', 'passport'), ['passport', 'full_name', 'department'])))
      .toEqual(['passport', 'full_name', 'address', 'department']);
    // Нового первого столбца в сохранённом нет — в начало.
    expect(keysOf(orderColumns(columns('n', 'a', 'b'), ['b', 'a']))).toEqual(['n', 'b', 'a']);
  });

  it('перестановка: перед / после столбца; на себя и неизвестный ключ — без изменений', () => {
    expect(moveColumnKey(['a', 'b', 'c', 'd'], 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c']);
    expect(moveColumnKey(['a', 'b', 'c', 'd'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveColumnKey(['a', 'b'], 'a', 'a', 'after')).toEqual(['a', 'b']);
    expect(moveColumnKey(['a', 'b'], 'x', 'a', 'before')).toEqual(['a', 'b']);
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

    it('сохраняется по ключу таблицы; мусор в хранилище — порядка нет', () => {
      writeColumnOrder('housing.dormitory', ['passport', 'full_name']);
      expect(readColumnOrder('housing.dormitory')).toEqual(['passport', 'full_name']);
      expect(readColumnOrder('housing.compensation')).toEqual([]);
      localStorage.setItem('registry-column-order:housing.apartments', '{oops');
      expect(readColumnOrder('housing.apartments')).toEqual([]);
      localStorage.setItem('registry-column-order:housing.apartments', '["a", 1, null]');
      expect(readColumnOrder('housing.apartments')).toEqual(['a']);
    });
  });
});
