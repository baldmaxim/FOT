import { describe, expect, it } from 'vitest';

import { columnFilterOptions, parseTableView, registryRowGroups, type ITableColumn } from './tableView';

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

describe('фильтр столбца: «—» первым (24.11.2026, «Проживание»)', () => {
  interface IRow { out: string | null }
  const columns: ITableColumn<IRow>[] = [{
    key: 'out',
    label: 'Дата выезда',
    type: 'text',
    text: row => row.out ?? '—',
    sortValue: row => row.out,
  }];
  const rows: IRow[] = [{ out: '2026-11-16' }, { out: null }, { out: '2026-11-02' }, { out: null }];

  it('без флага — пустое в конце, как было; с флагом — первым, потом даты по порядку', () => {
    expect(columnFilterOptions(rows, columns, {}, 'out').map(option => option.value))
      .toEqual(['2026-11-02', '2026-11-16', '—']);
    expect(columnFilterOptions(rows, columns, {}, 'out', { emptyFirst: true }))
      .toEqual([{ value: '—', count: 2 }, { value: '2026-11-02', count: 1 }, { value: '2026-11-16', count: 1 }]);
  });

  it('выбранное значение, которого больше нет в строках, наверх не встаёт — пустое определяется по тексту', () => {
    const options = columnFilterOptions(rows, columns, { out: ['2026-10-01'] }, 'out', { emptyFirst: true });
    expect(options.map(option => option.value)).toEqual(['—', '2026-11-02', '2026-11-16', '2026-10-01']);
  });

  it('сохранённый вид: сортировка и фильтры; чужая форма — null', () => {
    expect(parseTableView({ sort: 'out', dir: 'desc', filters: { out: ['—'], empty: [] } }))
      .toEqual({ sort: 'out', dir: 'desc', filters: { out: ['—'] } });
    expect(parseTableView({ sort: 'out', dir: 'up', filters: {} })).toBeNull();
    expect(parseTableView({ sort: 'out', dir: 'asc', filters: { out: [1] } })).toBeNull();
    expect(parseTableView('{"sort":"out"}')).toBeNull();
  });
});
