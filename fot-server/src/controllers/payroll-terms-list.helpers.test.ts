import { describe, expect, it } from 'vitest';

import {
  appendPayrollColumnFilters,
  buildPayrollCursorSql,
  buildPayrollOrderSql,
  isPayrollValueFilterColumn,
  parsePayrollColumnFilters,
  parsePayrollSort,
  parsePayrollSortCursor,
  payrollSortKeySql,
  payrollValueKeySql,
  payrollValueOrderSql,
} from './payroll-terms-list.helpers.js';

describe('parsePayrollSort', () => {
  it('без sort и dir — прежний порядок; неизвестный ключ или направление — ошибка', () => {
    expect(parsePayrollSort({})).toEqual({ ok: true, sort: null });
    expect(parsePayrollSort({ sort: 'salary' })).toEqual({ ok: true, sort: { key: 'salary', dir: 'asc' } });
    expect(parsePayrollSort({ sort: 'housing', dir: 'desc' })).toEqual({ ok: true, sort: { key: 'housing', dir: 'desc' } });
    expect(parsePayrollSort({ dir: 'asc' })).toEqual({ ok: false });
    expect(parsePayrollSort({ sort: 'effective_from' })).toEqual({ ok: false });
    expect(parsePayrollSort({ sort: 'name', dir: 'DESC' })).toEqual({ ok: false });
    expect(parsePayrollSort({ sort: ['name'] })).toEqual({ ok: false });
  });
});

describe('parsePayrollSortCursor', () => {
  it('курсора нет — первая порция', () => {
    expect(parsePayrollSortCursor({}, 'text')).toEqual({ ok: true, after: null });
  });

  it('текстовый и пустой ключ', () => {
    expect(parsePayrollSortCursor({ after_null: '0', after_key: 'бр.Закиров С.Ф.', after_id: '12' }, 'text'))
      .toEqual({ ok: true, after: { key: 'бр.Закиров С.Ф.', id: 12 } });
    // Пустая строка — допустимый текстовый ключ (отличается от NULL).
    expect(parsePayrollSortCursor({ after_null: '0', after_key: '', after_id: '12' }, 'text'))
      .toEqual({ ok: true, after: { key: '', id: 12 } });
    expect(parsePayrollSortCursor({ after_null: '1', after_id: '5' }, 'numeric'))
      .toEqual({ ok: true, after: { key: null, id: 5 } });
  });

  it('числовой ключ проверяется до SQL: иначе вместо 400 был бы 500 от ::numeric', () => {
    for (const key of ['175000.00', '450.1234', '0', '-5.5']) {
      expect(parsePayrollSortCursor({ after_null: '0', after_key: key, after_id: '1' }, 'numeric').ok, key).toBe(true);
    }
    for (const key of ['', 'abc', '1e5', '1,5', '175 000', 'NaN', '1.1234567']) {
      expect(parsePayrollSortCursor({ after_null: '0', after_key: key, after_id: '1' }, 'numeric'), key).toEqual({ ok: false });
    }
  });

  it('неполный или противоречивый курсор — ошибка', () => {
    const bad: Array<Record<string, unknown>> = [
      { after_key: 'А', after_id: '1' },
      { after_null: '0', after_id: '1' },
      { after_null: '1', after_key: 'А', after_id: '1' },
      { after_null: '0', after_key: 'А' },
      { after_null: '0', after_key: 'А', after_id: '0' },
      { after_null: '0', after_key: 'А', after_id: '-1' },
      { after_null: '0', after_key: 'А', after_id: '1.5' },
      { after_null: '0', after_key: 'А', after_id: '99999999999999999999' },
      { after_name: 'А', after_id: '1' },
      { after_null: '2', after_key: 'А', after_id: '1' },
    ];
    for (const query of bad) expect(parsePayrollSortCursor(query, 'text'), JSON.stringify(query)).toEqual({ ok: false });
  });
});

describe('курсор и порядок', () => {
  it('asc: больше ключа, равный ключ — больше id, пустые ключи — после всех', () => {
    const params: unknown[] = ['p1'];
    const sql = buildPayrollCursorSql('k', { key: 'department', dir: 'asc' }, { key: 'А', id: 7 }, params);
    expect(params).toEqual(['p1', 7, 'А']);
    expect(sql).toMatch(/k\.sort_key IS NOT NULL AND k\.sort_key > \$3::text/);
    expect(sql).toMatch(/k\.sort_key = \$3::text AND k\.employee_id > \$2::int/);
    expect(sql).toMatch(/OR k\.sort_key IS NULL\)$/);
  });

  it('desc по числу: сравнение «меньше» с приведением к numeric', () => {
    const params: unknown[] = [];
    const sql = buildPayrollCursorSql('k', { key: 'bonus', dir: 'desc' }, { key: '50000.00', id: 3 }, params);
    expect(sql).toMatch(/k\.sort_key < \$2::numeric/);
    expect(sql).toMatch(/k\.sort_key = \$2::numeric AND k\.employee_id < \$1::int/);
  });

  it('курсор на пустом ключе — только пустые ключи дальше по id', () => {
    const params: unknown[] = [];
    expect(buildPayrollCursorSql('k', { key: 'salary', dir: 'desc' }, { key: null, id: 9 }, params))
      .toBe('(k.sort_key IS NULL AND k.employee_id < $1::int)');
    expect(params).toEqual([9]);
  });

  it('порядок: пустые всегда в конце, тай-брейк по id в том же направлении', () => {
    expect(buildPayrollOrderSql('k', 'asc')).toBe('(k.sort_key IS NULL) ASC, k.sort_key ASC, k.employee_id ASC');
    expect(buildPayrollOrderSql('p', 'desc')).toBe('(p.sort_key IS NULL) ASC, p.sort_key DESC, p.employee_id DESC');
  });

  it('ключи сумм — числовые, текстовые пустую строку считают отсутствием значения', () => {
    expect(payrollSortKeySql('salary')).toEqual({ sql: 'COALESCE(monthly_salary, hourly_rate)', cast: 'numeric' });
    expect(payrollSortKeySql('housing').cast).toBe('numeric');
    expect(payrollSortKeySql('schedule')).toEqual({ sql: "NULLIF(btrim(schedule_name), '')", cast: 'text' });
  });
});

describe('значения фильтра', () => {
  it('оклад различает вид оплаты: 450 ₽/час и 450 ₽/мес — разные значения', () => {
    const sql = payrollValueKeySql('salary');
    expect(sql).toMatch(/'мес:' \|\| monthly_salary::text/);
    expect(sql).toMatch(/'час:' \|\| hourly_rate::text/);
    expect(payrollValueOrderSql('salary')).toBe('COALESCE(monthly_salary, hourly_rate)');
    expect(payrollValueOrderSql('position')).toBe(payrollValueKeySql('position'));
  });

  it('whitelist столбцов фильтра значений', () => {
    expect(isPayrollValueFilterColumn('schedule')).toBe(true);
    expect(isPayrollValueFilterColumn('name')).toBe(false);
    expect(isPayrollValueFilterColumn('department_name')).toBe(false);
    expect(isPayrollValueFilterColumn(undefined)).toBe(false);
  });
});

describe('parsePayrollColumnFilters', () => {
  it('пусто — без фильтров; корректный JSON принимается', () => {
    expect(parsePayrollColumnFilters(undefined)).toEqual({ ok: true, filters: {} });
    expect(parsePayrollColumnFilters('')).toEqual({ ok: true, filters: {} });
    const filters = { values: { position: ['Монтажник', null], bonus: ['0.00'] }, text: { name: 'ов' } };
    expect(parsePayrollColumnFilters(JSON.stringify(filters))).toEqual({ ok: true, filters });
  });

  it('неизвестные столбцы, лишние ключи, пустые и слишком большие списки — ошибка', () => {
    const bad = [
      '{not json',
      JSON.stringify([]),
      JSON.stringify({ values: { tab_number: ['1'] } }),
      JSON.stringify({ values: { position: [] } }),
      JSON.stringify({ values: { position: Array.from({ length: 201 }, (_, i) => `p${i}`) } }),
      JSON.stringify({ values: { position: ['x'.repeat(301)] } }),
      JSON.stringify({ values: { position: [1] } }),
      JSON.stringify({ text: { department: 'x' } }),
      JSON.stringify({ text: { name: 'x'.repeat(201) } }),
      JSON.stringify({ dates: {} }),
      'x'.repeat(8193),
    ];
    for (const raw of bad) expect(parsePayrollColumnFilters(raw).ok, raw.slice(0, 60)).toBe(false);
    expect(parsePayrollColumnFilters(42).ok).toBe(false);
  });
});

describe('appendPayrollColumnFilters', () => {
  it('значения и «(пусто)» — параметрами; пустое «содержит» не добавляет условие', () => {
    const where: string[] = [];
    const params: unknown[] = ['base'];
    appendPayrollColumnFilters(where, params, {
      values: { schedule: ['6+0 (10ч)', '6+0 (10ч)', null], housing: [null] },
      text: { name: '   ' },
    });
    expect(where).toEqual([
      "(NULLIF(btrim(schedule_name), '') = ANY($2::text[]) OR NULLIF(btrim(schedule_name), '') IS NULL)",
      '(housing_compensation::text IS NULL)',
    ]);
    // Дубликаты значений схлопываются.
    expect(params).toEqual(['base', ['6+0 (10ч)']]);
  });

  it('«содержит» по ФИО экранирует шаблон; exclude пропускает свой столбец', () => {
    const where: string[] = [];
    const params: unknown[] = [];
    appendPayrollColumnFilters(where, params, {
      values: { position: ['Монтажник'], department: ['Мех.цех'] },
      text: { name: ' 100%_ ' },
    }, { exclude: 'position' });
    expect(where).toEqual([
      "(NULLIF(btrim(department_name), '') = ANY($1::text[]))",
      "NULLIF(btrim(full_name), '') ILIKE $2",
    ]);
    expect(params).toEqual([['Мех.цех'], '%100\\%\\_%']);

    const noName: string[] = [];
    appendPayrollColumnFilters(noName, [], { text: { name: 'ов' } }, { exclude: 'name' });
    expect(noName).toEqual([]);
  });
});
