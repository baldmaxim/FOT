import { describe, expect, it } from 'vitest';
import {
  countActiveColumnFilters,
  getColumnFilter,
  isColumnFilterActive,
  normalizeColumnFilters,
  parseColumnFilters,
  serializeColumnFilters,
  setColumnFilter,
} from './staffColumnFilters';

describe('staffColumnFilters', () => {
  it('нормализация: пустые убираются, значения без дублей и в стабильном порядке, «пусто» в конце', () => {
    expect(normalizeColumnFilters({
      values: { department: [null, 'Склад', 'Бухгалтерия', 'Склад'], position: [] },
      dates: { hire_date: { from: '', to: '' }, birth_date: { from: '2001-01-01', to: '2000-01-01' } },
      text: { name: '  ', comment: ' текст ' },
    })).toEqual({
      values: { department: ['Бухгалтерия', 'Склад', null] },
      dates: { birth_date: { from: '2000-01-01', to: '2001-01-01' } },
      text: { comment: 'текст' },
    });
  });

  it('сериализация стабильна и пустая для отсутствия фильтров', () => {
    expect(serializeColumnFilters({})).toBe('');
    expect(serializeColumnFilters({ values: { position: [] } })).toBe('');
    const a = serializeColumnFilters({ text: { name: 'Ив' }, values: { sign: ['Уволен', 'Работает'] } });
    const b = serializeColumnFilters({ values: { sign: ['Работает', 'Уволен'] }, text: { name: 'Ив' } });
    expect(a).toBe(b);
  });

  it('разбор URL: круговой путь, мусор — без фильтров', () => {
    const filters = { values: { sign: ['Декрет', null] }, dates: { hire_date: { from: '2026-09-01', empty: true } }, has_comment: false };
    expect(parseColumnFilters(serializeColumnFilters(filters))).toEqual(normalizeColumnFilters(filters));
    expect(parseColumnFilters('{bad')).toEqual({});
    expect(parseColumnFilters('[1]')).toEqual({});
    expect(parseColumnFilters(JSON.stringify({ values: { department: [1, 'А'] }, dates: { hire_date: { from: '01.09.2026' } } })))
      .toEqual({ values: { department: ['А'] } });
  });

  it('активность и счётчик, комментарий активен и по «есть/нет»', () => {
    const filters = setColumnFilter({}, 'comment', { text: '', hasComment: true });
    expect(isColumnFilterActive(filters, 'comment')).toBe(true);
    expect(isColumnFilterActive(filters, 'name')).toBe(false);
    const more = setColumnFilter(filters, 'hire_date', { dates: { empty: true } });
    expect(countActiveColumnFilters(more)).toBe(2);
  });

  it('установка и снятие фильтра одного столбца не трогает остальные', () => {
    let filters = setColumnFilter({}, 'department', { values: ['Склад'] });
    filters = setColumnFilter(filters, 'name', { text: 'Ив' });
    expect(getColumnFilter(filters, 'department')).toEqual({ values: ['Склад'] });
    filters = setColumnFilter(filters, 'department', null);
    expect(filters).toEqual({ text: { name: 'Ив' } });
    expect(getColumnFilter(filters, 'comment')).toEqual({ text: '', hasComment: undefined });
  });
});
