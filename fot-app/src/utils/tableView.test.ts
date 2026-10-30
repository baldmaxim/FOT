import { describe, expect, it } from 'vitest';

import { registryRowGroups } from './tableView';

describe('группы строк таблицы-реестра', () => {
  const groups = (keys: number[]) => registryRowGroups(keys, key => key)
    .map(place => `${place.index}${place.first ? 'F' : ''}${place.last ? 'L' : ''}`);

  it('подряд идущие строки сотрудника — одна группа: первая, середина, последняя', () => {
    expect(groups([1, 1, 1, 2])).toEqual(['0F', '0', '0L', '1FL']);
  });

  it('строки сотрудника разошлись (сортировка по другому столбцу) — разные группы', () => {
    expect(groups([1, 2, 1])).toEqual(['0FL', '1FL', '2FL']);
  });

  it('один сотрудник и пустая таблица', () => {
    expect(groups([7])).toEqual(['0FL']);
    expect(groups([])).toEqual([]);
  });
});
