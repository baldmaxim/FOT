import { describe, expect, it, vi } from 'vitest';
import type { IPresenceExportDay, IPresenceExportEmployee } from './skud-presence-export.service.js';

/**
 * Статистика «Сотрудники на объектах» за месяц: граница месяцев, «Всего» без двойного
 * счёта, компании и порядок строк, компания внешних и обязательность архива «Уволенные».
 */

const archive = vi.hoisted(() => ({ value: { id: 'dept-archive' } as { id: string } | null, fail: false }));

vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(async () => {
    if (archive.fail) throw new Error('settings down');
    return archive.value;
  }),
}));

vi.mock('./skud-presence-company-on-date.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./skud-presence-company-on-date.service.js')>()),
  loadCompanyOnDateSource: vi.fn(async () => ({
    assignmentsByEmployee: new Map(),
    currentDeptByEmployee: new Map([[1, 'dept-su10']]),
    dismissalsByEmployee: new Map(),
    archiveDeptId: 'dept-archive',
    companyOfDept: (deptId: string) => (deptId === 'dept-su10' ? { key: 'local:c-su10', name: 'СУ-10' } : null),
  })),
}));

vi.mock('./skud-shared.service.js', () => ({
  getCompanyResolveIndex: vi.fn(async () => ({
    rootId: 'root',
    companyByDeptId: new Map(),
    companyMeta: new Map([['c-podr', { id: 'c-podr', name: 'Подрядные организации', sigur_department_id: 5 }]]),
    companyBySigurId: new Map(),
    companyByNormalizedName: new Map([['подрядные организации', 'c-podr']]),
  })),
}));

const {
  buildExternalCompanyResolver,
  buildPresenceMonthStats,
  computePresenceMonthStats,
  formatMonthLabel,
  resolveMonthPeriod,
  PresenceMonthStatsError,
} = await import('./skud-presence-month-stats.service.js');
const { NO_OBJECT_KEY } = await import('./skud-presence-export.service.js');
const { NO_COMPANY } = await import('./skud-presence-company-on-date.service.js');

const emp = (employeeId: number | null, name = `Человек ${employeeId}`): IPresenceExportEmployee => ({
  entry_time: '07:00:00',
  full_name: name,
  person_key: employeeId !== null ? `emp:${employeeId}` : `ext:${name.toLowerCase()}`,
  employee_id: employeeId,
});

const day = (
  date: string,
  objects: Array<{ key: string; name: string; groups: Array<{ company: string | null; employees: IPresenceExportEmployee[] }> }>,
): IPresenceExportDay => ({
  date,
  objects: objects.map(object => ({
    object_key: object.key,
    object_name: object.name,
    total: object.groups.reduce((sum, group) => sum + group.employees.length, 0),
    groups: object.groups.map((group, index) => ({
      key: `g-${object.key}-${index}`,
      name: `Группа ${index}`,
      company_name: group.company,
      employees: group.employees,
    })),
  })),
});

describe('resolveMonthPeriod', () => {
  it('прошлый месяц — целиком, текущий — по «сегодня» включительно', () => {
    expect(resolveMonthPeriod('2026-09', '2026-11-09')).toMatchObject({ dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    const current = resolveMonthPeriod('2026-11', '2026-11-09');
    expect(current.dateTo).toBe('2026-11-09');
    expect(current.dates).toHaveLength(9);
  });

  it('1-е число текущего месяца — один день', () => {
    expect(resolveMonthPeriod('2026-12', '2026-12-01').dates).toEqual(['2026-12-01']);
  });

  it('январь — 11 месяцев назад через границу года; 12 — уже нельзя', () => {
    expect(resolveMonthPeriod('2025-12', '2026-11-09').dates).toHaveLength(31);
    expect(() => resolveMonthPeriod('2025-11', '2026-11-09')).toThrowError(
      expect.objectContaining({ code: 'INVALID_MONTH' }),
    );
    expect(resolveMonthPeriod('2025-12', '2026-01-15').dateTo).toBe('2025-12-31');
  });

  it('февраль високосного и обычного года', () => {
    expect(resolveMonthPeriod('2028-02', '2028-03-01').dateTo).toBe('2028-02-29');
    expect(resolveMonthPeriod('2027-02', '2027-03-01').dateTo).toBe('2027-02-28');
  });

  it('будущий месяц и кривой формат — INVALID_MONTH', () => {
    for (const month of ['2026-12', '2026-13', '2026-9', 'сентябрь']) {
      expect(() => resolveMonthPeriod(month, '2026-11-09')).toThrow(PresenceMonthStatsError);
    }
  });

  it('подпись месяца', () => {
    expect(formatMonthLabel('2026-09')).toBe('Сентябрь 2026');
  });
});

describe('buildPresenceMonthStats', () => {
  const dates = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const companyOf = (employee: IPresenceExportEmployee, group: { company_name: string | null }) => (
    group.company_name
      ? { key: `c:${group.company_name}`, name: group.company_name }
      : NO_COMPANY
  );

  it('«Всего» — уникальные люди за день, а не сумма объектов; компании в сумме = объект', () => {
    const stats = buildPresenceMonthStats([
      day('2026-09-01', [
        { key: 'obj-1', name: 'ЖК Alia', groups: [{ company: 'СУ-10', employees: [emp(1), emp(2)] }] },
        { key: 'obj-2', name: 'ЖК Инжой', groups: [{ company: 'СУ-10', employees: [emp(1)] }] },
      ]),
      day('2026-09-03', [
        { key: 'obj-1', name: 'ЖК Alia', groups: [
          { company: 'СУ-10', employees: [emp(1)] },
          { company: 'ЛИНИЯ', employees: [emp(3)] },
        ] },
      ]),
    ], dates, companyOf);

    expect(stats.total).toEqual([2, 0, 2]);
    const alia = stats.objects.find(o => o.key === 'obj-1')!;
    expect(alia.counts).toEqual([2, 0, 2]);
    const companySum = alia.companies.reduce(
      (acc, company) => acc.map((value, index) => value + company.counts[index]),
      [0, 0, 0],
    );
    expect(companySum).toEqual(alia.counts);
  });

  it('порядок: по сумме за период, «Без объекта» и «Без компании» — в конце', () => {
    const stats = buildPresenceMonthStats([
      day('2026-09-01', [
        { key: NO_OBJECT_KEY, name: 'Без объекта', groups: [{ company: 'СУ-10', employees: [emp(1), emp(2), emp(3)] }] },
        { key: 'obj-2', name: 'ЖК Инжой', groups: [{ company: 'СУ-10', employees: [emp(4)] }] },
        { key: 'obj-1', name: 'ЖК Alia', groups: [
          { company: null, employees: [emp(5), emp(6), emp(7)] },
          { company: 'ЛИНИЯ', employees: [emp(8)] },
        ] },
      ]),
    ], dates, companyOf);

    expect(stats.objects.map(o => o.key)).toEqual(['obj-1', 'obj-2', NO_OBJECT_KEY]);
    expect(stats.objects[0].companies.map(c => c.name)).toEqual(['ЛИНИЯ', 'Без компании']);
  });

  it('дни вне периода не учитываются, пустые дни — нули', () => {
    const stats = buildPresenceMonthStats([
      day('2026-08-31', [{ key: 'obj-1', name: 'ЖК Alia', groups: [{ company: 'СУ-10', employees: [emp(1)] }] }]),
    ], dates, companyOf);
    expect(stats.objects).toEqual([]);
    expect(stats.total).toEqual([0, 0, 0]);
  });
});

describe('buildExternalCompanyResolver', () => {
  const resolve = buildExternalCompanyResolver(
    new Map([['подрядные организации', 'c-podr']]),
    id => (id === 'c-podr' ? 'Подрядные организации' : undefined),
  );
  const group = (company_name: string | null) => ({ key: 'g', name: 'g', company_name, employees: [] });

  it('имя совпало с локальной компанией — сливается с ней', () => {
    expect(resolve(group('ПОДРЯДНЫЕ  организации'))).toEqual({ key: 'local:c-podr', name: 'Подрядные организации' });
  });

  it('незнакомая Sigur-компания — свой ключ, без компании — «Без компании»', () => {
    expect(resolve(group('ООО Ромашка'))).toEqual({ key: 'sigur-root:ооо ромашка', name: 'ООО Ромашка' });
    expect(resolve(group(null))).toEqual(NO_COMPANY);
  });
});

describe('computePresenceMonthStats', () => {
  const period = resolveMonthPeriod('2026-09', '2026-11-09');
  const days = [day('2026-09-01', [{ key: 'obj-1', name: 'ЖК Alia', groups: [
    { company: 'Подрядные организации', employees: [emp(1), emp(null, 'Гость Внешний')] },
  ] }])];

  it('сотруднику — компания на дату, внешнему — из группы Sigur', async () => {
    archive.value = { id: 'dept-archive' };
    archive.fail = false;
    const stats = await computePresenceMonthStats(days, period);
    expect(stats.objects[0].companies.map(c => [c.name, c.counts[0]])).toEqual([
      ['Подрядные организации', 1],
      ['СУ-10', 1],
    ]);
  });

  it('архив «Уволенные» не определён — ARCHIVE_UNKNOWN, а не тихий счёт в «Уволенных»', async () => {
    archive.value = null;
    await expect(computePresenceMonthStats(days, period)).rejects.toMatchObject({ code: 'ARCHIVE_UNKNOWN' });
    archive.value = { id: 'dept-archive' };
    archive.fail = true;
    await expect(computePresenceMonthStats(days, period)).rejects.toMatchObject({ code: 'ARCHIVE_UNKNOWN' });
    archive.fail = false;
  });
});
