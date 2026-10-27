import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: h.query }));

const {
  buildStaffSiteFacetJoinSql,
  buildStaffSiteIndex,
  buildStaffSiteKeySql,
  createStaffSqlContext,
  staffSiteLabel,
} = await import('./staff-site.service.js');
type Links = Parameters<typeof buildStaffSiteIndex>[0];

const D1 = '00000000-0000-0000-0000-0000000000d1';
const D2 = '00000000-0000-0000-0000-0000000000d2';

const dept = (employeeId: number, departmentId: string, fullName: string | null) => (
  { employee_id: employeeId, department_id: departmentId, full_name: fullName, email: null }
);
const direct = (leaderId: number, directId: number, fullName: string | null, departmentId: string | null) => (
  { leader_employee_id: leaderId, direct_employee_id: directId, leader_full_name: fullName, leader_email: null, direct_department_id: departmentId }
);
const index = (links: Partial<Links>) => buildStaffSiteIndex({ departmentLinks: [], directLinks: [], ...links });

beforeEach(() => {
  h.query.mockReset();
});

describe('buildStaffSiteIndex / staffSiteLabel', () => {
  it('ФИО как в списке «По участкам»; два начальника отдела — по алфавиту через запятую', () => {
    const idx = index({ departmentLinks: [dept(11, D1, 'Пудовкин Александр Александрович'), dept(10, D1, '  Журавлев  Владимир Сергеевич ')] });
    expect(staffSiteLabel(idx, 1, D1)).toBe('Журавлев В. С., Пудовкин А. А.');
    expect(staffSiteLabel(idx, 1, D2)).toBeNull();
  });

  it('сотрудник без отдела и без личного назначения — без участка', () => {
    const idx = index({ departmentLinks: [dept(10, D1, 'Журавлев Владимир Сергеевич')] });
    expect(staffSiteLabel(idx, 1, null)).toBeNull();
  });

  it('личное назначение объединяется с начальником отдела; один начальник обоими путями — без дубля', () => {
    const idx = index({
      departmentLinks: [dept(10, D1, 'Журавлев Владимир Сергеевич')],
      directLinks: [direct(12, 5, 'Абаев Борис', D1), direct(10, 5, 'Журавлев Владимир Сергеевич', D1), direct(12, 6, 'Абаев Борис', null)],
    });
    expect(staffSiteLabel(idx, 5, D1)).toBe('Абаев Б., Журавлев В. С.');
    // Личное назначение без отдела — только личный начальник; по отделу соседи не затрагиваются.
    expect(staffSiteLabel(idx, 6, null)).toBe('Абаев Б.');
    expect(staffSiteLabel(idx, 7, D1)).toBe('Журавлев В. С.');
    // Для фасетов личные начальники хранятся отдельно от начальников отдела.
    expect(idx.directOnly.get(5)?.map(item => item.id)).toEqual([12, 10]);
  });

  it('дубли — по id: одинаковые ФИО разных людей не склеиваются, повтор связи одного — склеивается', () => {
    const idx = index({ departmentLinks: [dept(10, D1, 'Иванов Иван Иванович'), dept(20, D1, 'Иванов Иван Игоревич'), dept(10, D1, 'Иванов Иван Иванович')] });
    expect(idx.byDepartment.get(D1)?.map(item => item.id)).toEqual([10, 20]);
    expect(staffSiteLabel(idx, 1, D1)).toBe('Иванов И. И., Иванов И. И.');
  });

  it('пустое ФИО начальника не показывается', () => {
    const idx = index({ departmentLinks: [dept(10, D1, '  '), dept(11, D2, null)], directLinks: [direct(12, 5, '', null)] });
    expect(staffSiteLabel(idx, 1, D1)).toBeNull();
    expect(staffSiteLabel(idx, 5, D2)).toBeNull();
  });
});

describe('SQL участка', () => {
  const idx = index({
    departmentLinks: [dept(10, D1, 'Журавлев Владимир Сергеевич'), dept(11, D1, 'Пудовкин Александр')],
    directLinks: [direct(12, 5, 'Абаев Борис', D1)],
  });

  it('ключ сортировки = текст ячейки; плейсхолдеры после уже занятых', () => {
    const params: unknown[] = ['x'];
    const sql = buildStaffSiteKeySql(idx, params);
    expect(params.slice(1)).toEqual([[5], ['Абаев Б., Журавлев В. С., Пудовкин А.'], [D1], ['Журавлев В. С., Пудовкин А.']]);
    expect(sql).toContain('unnest($2::int[], $3::text[])');
    expect(sql).toContain('unnest($4::uuid[], $5::text[])');
  });

  it('фасеты — по строке на начальника, личные отдельно (UNION схлопывает совпадение с отделом)', () => {
    const params: unknown[] = [];
    const sql = buildStaffSiteFacetJoinSql(idx, params);
    expect(params).toEqual([[D1, D1], ['Журавлев В. С.', 'Пудовкин А.'], [5], ['Абаев Б.']]);
    expect(sql).toMatch(/^LEFT JOIN LATERAL/);
    expect(sql).toContain('UNION');
  });
});

describe('createStaffSqlContext', () => {
  it('один запрос связей на контекст, у нового контекста — свой', async () => {
    h.query.mockResolvedValue([]);
    const ctx = createStaffSqlContext();
    const [a, b] = await Promise.all([ctx.siteIndex(), ctx.siteIndex()]);
    expect(a).toBe(b);
    // Две связи (отделы + личные) на одну загрузку индекса.
    expect(h.query).toHaveBeenCalledTimes(2);
    await createStaffSqlContext().siteIndex();
    expect(h.query).toHaveBeenCalledTimes(4);
  });

  it('условия — как в «По участкам»: full-доступ не из Sigur, активный начальник участка', async () => {
    h.query.mockResolvedValue([]);
    await createStaffSqlContext().siteIndex();
    const [edaSql, edaParams] = h.query.mock.calls[0] as [string, unknown[]];
    expect(edaSql).toContain(`eda.access_level = 'full'`);
    expect(edaSql).toContain(`eda.source <> 'sigur_sync'`);
    expect(edaSql).toContain(`sr.code = 'site_supervisor'`);
    expect(edaSql).toContain('e.excluded_from_timesheet = false');
    expect(edaParams).toEqual([]);
    const [ueaSql] = h.query.mock.calls[1] as [string];
    expect(ueaSql).toContain('uea.is_active = true');
    expect(ueaSql).toContain('direct.org_department_id AS direct_department_id');
  });
});
