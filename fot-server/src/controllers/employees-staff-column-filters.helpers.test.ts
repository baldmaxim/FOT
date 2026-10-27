import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadActiveSnapshotRun: vi.fn(),
  getAllDepartmentsTree: vi.fn(),
}));
vi.mock('../services/employee-main-object-snapshot.service.js', () => ({ loadActiveSnapshotRun: h.loadActiveSnapshotRun }));
vi.mock('../services/skud-shared.service.js', () => ({ getAllDepartmentsTree: h.getAllDepartmentsTree }));

const {
  appendColumnFilters,
  countActiveColumnFilters,
  parseStaffColumnFilters,
  StaffFilterUnavailableError,
} = await import('./employees-staff-column-filters.helpers.js');
const { buildStaffSiteIndex } = await import('../services/staff-site.service.js');

const BAROTOV = '00000000-0000-0000-0000-0000000000b1';
const OTHER = '00000000-0000-0000-0000-0000000000b2';
// Бригада двух начальников + бригада одного из них.
const SITE_INDEX = buildStaffSiteIndex({
  departmentLinks: [
    { employee_id: 10, department_id: BAROTOV, full_name: 'Журавлев Владимир Сергеевич', email: null },
    { employee_id: 11, department_id: BAROTOV, full_name: 'Пудовкин Александр Александрович', email: null },
    { employee_id: 11, department_id: OTHER, full_name: 'Пудовкин Александр Александрович', email: null },
  ],
  directLinks: [],
});
const ctx = { siteIndex: async () => SITE_INDEX };

const expectPlaceholdersMatch = (sql: string, params: unknown[]) => {
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  expect(Math.max(0, ...used)).toBe(params.length);
  for (let i = 1; i <= params.length; i += 1) expect(used.has(i)).toBe(true);
};

beforeEach(() => {
  h.loadActiveSnapshotRun.mockReset().mockResolvedValue({ id: 5 });
  h.getAllDepartmentsTree.mockReset().mockResolvedValue([]);
});

describe('parseStaffColumnFilters', () => {
  it('нет параметра или пусто — без фильтров', () => {
    expect(parseStaffColumnFilters(undefined)).toEqual({ ok: true, filters: {} });
    expect(parseStaffColumnFilters('')).toEqual({ ok: true, filters: {} });
    expect(parseStaffColumnFilters('{}')).toEqual({ ok: true, filters: {} });
  });

  it('корректные фильтры всех типов', () => {
    const cf = {
      values: { department: ['Склад', null], sign: ['Работает'] },
      dates: { hire_date: { from: '2026-09-01', to: '2026-09-30', empty: true } },
      text: { name: 'Иван', comment: 'проверить' },
      has_comment: true,
    };
    expect(parseStaffColumnFilters(JSON.stringify(cf))).toEqual({ ok: true, filters: cf });
  });

  it('неверный JSON, лишние ключи, неизвестный столбец, from > to, лимиты — ошибка', () => {
    const bad = [
      '{',
      '[]',
      JSON.stringify({ values: { cost_item: ['x'] } }),
      JSON.stringify({ other: 1 }),
      JSON.stringify({ values: { department: [] } }),
      JSON.stringify({ values: { department: Array.from({ length: 201 }, (_, i) => `d${i}`) } }),
      JSON.stringify({ values: { department: ['x'.repeat(301)] } }),
      JSON.stringify({ dates: { hire_date: { from: '2026-10-01', to: '2026-09-01' } } }),
      JSON.stringify({ dates: { hire_date: { from: '01.09.2026' } } }),
      JSON.stringify({ text: { name: 'x'.repeat(201) } }),
      'x'.repeat(8193),
    ];
    for (const raw of bad) expect(parseStaffColumnFilters(raw)).toEqual({ ok: false });
    expect(parseStaffColumnFilters(['{}'])).toEqual({ ok: false });
  });
});

describe('appendColumnFilters', () => {
  it('все типы: согласованные плейсхолдеры, «пусто» через IS NULL, «ФИО» — точным поиском ФИО', async () => {
    const whereParts = ['is_archived = $1'];
    const params: unknown[] = [false];
    await appendColumnFilters(whereParts, params, {
      values: { department: ['Склад', 'Склад', null], position: [null], main_object: ['ЖК Альфа'] },
      dates: { hire_date: { from: '2026-09-01', empty: true }, birth_date: { to: '2000-01-01' } },
      text: { name: '50%_А', comment: '  ' },
      has_comment: false,
    }, { ctx });
    const sql = whereParts.join(' AND ');
    expectPlaceholdersMatch(sql, params);
    expect(params).toContainEqual(['Склад']);
    // ё = е, регистр, раскладка — регулярным выражением; % и _ — буквально, без опечаток.
    expect(params).toContain('50%_а');
    expect(sql).toMatch(/\(full_name ~\* \$\d+\)/);
    expect(params).toContain(5);
    expect(sql).toMatch(/= ANY\(\$\d+::text\[\]\) OR \(SELECT NULLIF\(btrim\(d\.name\), ''\)[\s\S]*IS NULL\)/);
    expect(sql).toContain('employees.hire_date >= $');
    expect(sql).toContain('OR employees.hire_date IS NULL');
    expect(sql).toContain('employees.birth_date <= $');
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM employee_staff_comments');
    // Пустой текст комментария не добавляет условия.
    expect(sql.match(/ILIKE/g)).toBeNull();
  });

  it('exclude пропускает только свой столбец', async () => {
    const filters = { values: { department: ['Склад'], position: ['Мастер'] }, text: { name: 'А' } };
    const withAll: string[] = [];
    await appendColumnFilters(withAll, [], filters, { ctx });
    const withoutDept: string[] = [];
    const params: unknown[] = [];
    await appendColumnFilters(withoutDept, params, filters, { exclude: 'department', ctx });
    expect(withAll).toHaveLength(3);
    expect(withoutDept).toHaveLength(2);
    expect(withoutDept.join(' ')).not.toContain('org_departments');
    expect(params).toContainEqual(['Мастер']);
  });

  it('объект без опубликованного снимка — фильтр недоступен', async () => {
    h.loadActiveSnapshotRun.mockResolvedValue(null);
    await expect(appendColumnFilters([], [], { values: { main_object: ['ЖК'] } }, { ctx })).rejects.toBeInstanceOf(StaffFilterUnavailableError);
    // Без фильтра объекта снимок не нужен.
    await expect(appendColumnFilters([], [], { values: { sign: ['Работает'] } }, { ctx })).resolves.toBeUndefined();
  });

  it('без фильтров — ничего не добавляет', async () => {
    const whereParts: string[] = [];
    const params: unknown[] = [];
    await appendColumnFilters(whereParts, params, {}, { ctx });
    expect(whereParts).toEqual([]);
    expect(params).toEqual([]);
  });
});

describe('appendColumnFilters — участок', () => {
  it('по отдельному начальнику: бригада двух начальников попадает под каждого', async () => {
    const whereParts = ['is_archived = $1'];
    const params: unknown[] = [false];
    await appendColumnFilters(whereParts, params, { values: { site: ['Журавлев В. С.'] } }, { ctx });
    expectPlaceholdersMatch(whereParts.join(' AND '), params);
    expect(params.slice(1)).toEqual([[BAROTOV], []]);

    const pudovkin: unknown[] = [];
    await appendColumnFilters([], pudovkin, { values: { site: ['Пудовкин А. А.'] } }, { ctx });
    expect((pudovkin[0] as string[]).sort()).toEqual([BAROTOV, OTHER]);
  });

  it('«Без участка» — ключ участка IS NULL; вместе с именем — через OR', async () => {
    const whereParts: string[] = [];
    const params: unknown[] = [];
    await appendColumnFilters(whereParts, params, { values: { site: [null, 'Журавлев В. С.'] } }, { ctx });
    expect(whereParts).toHaveLength(1);
    expectPlaceholdersMatch(whereParts[0], params);
    expect(whereParts[0]).toMatch(/employees\.org_department_id = ANY\(\$1::uuid\[\]\) OR employees\.id = ANY\(\$2::int\[\]\)\) OR COALESCE\(/);
    expect(whereParts[0]).toMatch(/\) IS NULL\)$/);
  });
});

describe('countActiveColumnFilters', () => {
  it('считает только непустые фильтры', () => {
    expect(countActiveColumnFilters({})).toBe(0);
    expect(countActiveColumnFilters({
      values: { department: ['А'] },
      dates: { hire_date: {}, birth_date: { empty: true } },
      text: { name: ' ', comment: 'x' },
      has_comment: true,
    })).toBe(4);
  });
});
