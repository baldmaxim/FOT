import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Сбор датасета выгрузки «Сотрудники на объектах»: схлопывание проходов,
 * ключи отделов, построчная авторизация (union из четырёх режимов) и кэш.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

interface IEventRow {
  event_date: string;
  employee_id: number | null;
  physical_person: string | null;
  access_point: string | null;
  first_entry: string;
}
interface IEmployeeRow {
  id: number;
  full_name: string | null;
  org_department_id: string | null;
  sigur_employee_id: number | null;
}
interface IDeptRow {
  id: string;
  parent_id: string | null;
  name: string | null;
  sigur_department_id: number | null;
  is_active: boolean | null;
}
interface ISigurResolution {
  root: { sigur_department_id: number; name: string };
  department: { sigur_department_id: number; name: string };
}

const state = vi.hoisted(() => ({
  events: [] as IEventRow[],
  employees: [] as IEmployeeRow[],
  depts: [] as IDeptRow[],
  internalPoints: new Set<string>(),
  travelObjects: [] as Array<{ id: string; name: string; access_points: string[]; has_map: boolean }>,
  companyByDeptId: new Map<string, string>(),
  companyMeta: new Map<string, { id: string; name: string; sigur_department_id: number | null }>(),
  sigurById: new Map<number, ISigurResolution>(),
  sigurByName: new Map<string, ISigurResolution>(),
}));

vi.mock('./skud-shared.service.js', () => ({
  getInternalAccessPoints: vi.fn(async () => state.internalPoints),
  getCompanyResolveIndex: vi.fn(async () => ({
    rootId: 'root',
    companyByDeptId: state.companyByDeptId,
    companyMeta: state.companyMeta,
    companyBySigurId: new Map(),
    companyByNormalizedName: new Map(),
  })),
}));

vi.mock('./skud-travel.service.js', () => ({
  listTravelObjects: vi.fn(async () => state.travelObjects),
}));

vi.mock('./sigur-presence-resolver.service.js', () => ({
  resolveSigurEmployeesByIds: vi.fn(async () => state.sigurById),
  resolveSigurEmployeesByNames: vi.fn(async () => state.sigurByName),
  normalizeMatchName: (value: string) =>
    value.toLowerCase().trim().replace(/\s+/g, ' ').replace(/ё/g, 'е'),
}));

const {
  collectPresenceExport,
  buildCacheKey,
  invalidatePresenceExportCache,
  validatePeriod,
  PresenceExportError,
  NO_OBJECT_KEY,
} = await import('./skud-presence-export.service.js');

type Visibility = Parameters<typeof collectPresenceExport>[0]['visibility'];

const unrestricted: Visibility = {
  isUnrestricted: true,
  assignedObjectIds: new Set(),
  allowedEmployeeIds: 'all',
  hasObjectViewScope: false,
};

beforeEach(() => {
  invalidatePresenceExportCache();
  state.events = [];
  state.employees = [];
  state.depts = [
    { id: 'dept-a', parent_id: 'company-1', name: 'бр.Тоштемиров', sigur_department_id: 501, is_active: true },
    { id: 'dept-b', parent_id: 'company-2', name: 'бр.Тоштемиров', sigur_department_id: 502, is_active: true },
    { id: 'company-1', parent_id: 'root', name: 'СУ-10', sigur_department_id: 10, is_active: true },
    { id: 'company-2', parent_id: 'root', name: 'ЛИНИЯ', sigur_department_id: 20, is_active: true },
  ];
  state.internalPoints = new Set();
  state.travelObjects = [
    { id: 'obj-1', name: 'ЖК Alia', access_points: ['ALIA', 'ALIA кпп-2'], has_map: false },
    { id: 'obj-2', name: 'ЖК Инжой', access_points: ['INJOY'], has_map: false },
  ];
  state.companyByDeptId = new Map([
    ['dept-a', 'company-1'],
    ['dept-b', 'company-2'],
    ['company-1', 'company-1'],
    ['company-2', 'company-2'],
  ]);
  state.companyMeta = new Map([
    ['company-1', { id: 'company-1', name: 'СУ-10', sigur_department_id: 10 }],
    ['company-2', { id: 'company-2', name: 'ЛИНИЯ', sigur_department_id: 20 }],
  ]);
  state.sigurById = new Map();
  state.sigurByName = new Map();

  pgQuery.mockReset();
  pgQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM skud_events')) return state.events;
    if (sql.includes('FROM employees')) return state.employees;
    if (sql.includes('FROM org_departments')) return state.depts;
    return [];
  });
});

describe('validatePeriod', () => {
  it('пропускает ровно 62 дня и режет 63', () => {
    expect(validatePeriod('2026-01-01', '2026-03-03')).toBe(62);
    expect(() => validatePeriod('2026-01-01', '2026-03-04')).toThrowError(
      expect.objectContaining({ code: 'PERIOD_TOO_LONG' }),
    );
  });

  it('отбивает несуществующую дату и перевёрнутый период', () => {
    expect(() => validatePeriod('2026-13-01', '2026-13-02')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PERIOD' }),
    );
    expect(() => validatePeriod('2026-02-30', '2026-03-01')).toThrowError(PresenceExportError);
    expect(() => validatePeriod('2026-03-05', '2026-03-01')).toThrowError(
      expect.objectContaining({ code: 'INVALID_PERIOD' }),
    );
  });
});

describe('buildCacheKey', () => {
  it('различает скоупы (регресс на JSON.stringify(Set) === "{}")', () => {
    const a = buildCacheKey('2026-08-01', '2026-08-02', {
      isUnrestricted: false,
      assignedObjectIds: new Set(['obj-1']),
      allowedEmployeeIds: new Set([1]),
      hasObjectViewScope: false,
    });
    const b = buildCacheKey('2026-08-01', '2026-08-02', {
      isUnrestricted: false,
      assignedObjectIds: new Set(['obj-2']),
      allowedEmployeeIds: new Set([1]),
      hasObjectViewScope: false,
    });
    const c = buildCacheKey('2026-08-01', '2026-08-02', {
      isUnrestricted: false,
      assignedObjectIds: new Set(['obj-1']),
      allowedEmployeeIds: new Set([2]),
      hasObjectViewScope: false,
    });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('не зависит от порядка элементов в наборах', () => {
    const base = {
      isUnrestricted: false,
      hasObjectViewScope: true,
      allowedEmployeeIds: new Set([2, 1]),
      assignedObjectIds: new Set(['b', 'a']),
    };
    const swapped = {
      isUnrestricted: false,
      hasObjectViewScope: true,
      allowedEmployeeIds: new Set([1, 2]),
      assignedObjectIds: new Set(['a', 'b']),
    };
    expect(buildCacheKey('2026-08-01', '2026-08-02', base))
      .toBe(buildCacheKey('2026-08-01', '2026-08-02', swapped));
  });
});

describe('collectPresenceExport', () => {
  it('схлопывает проходы по разным точкам одного объекта в минимальное время', async () => {
    state.employees = [
      { id: 1, full_name: 'Иванов Иван', org_department_id: 'dept-a', sigur_employee_id: null },
    ];
    state.events = [
      { event_date: '2026-08-04', employee_id: 1, physical_person: 'Иванов Иван', access_point: 'ALIA', first_entry: '08:20:00' },
      { event_date: '2026-08-04', employee_id: 1, physical_person: 'Иванов Иван', access_point: 'ALIA кпп-2', first_entry: '07:19:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });

    expect(days).toHaveLength(1);
    expect(days[0].objects).toHaveLength(1);
    expect(days[0].objects[0].total).toBe(1);
    expect(days[0].objects[0].groups[0].employees).toEqual([
      { entry_time: '07:19:00', full_name: 'Иванов Иван' },
    ]);
  });

  it('схлопывает unsynced-написания (регистр, пробелы, ё) в одну строку', async () => {
    state.events = [
      { event_date: '2026-08-04', employee_id: null, physical_person: 'Пётр  Сидоров', access_point: 'ALIA', first_entry: '09:00:00' },
      { event_date: '2026-08-04', employee_id: null, physical_person: 'петр сидоров', access_point: 'ALIA кпп-2', first_entry: '08:00:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });

    const employees = days[0].objects[0].groups[0].employees;
    expect(employees).toHaveLength(1);
    expect(employees[0].entry_time).toBe('08:00:00');
    expect(employees[0].full_name).toBe('петр сидоров');
  });

  it('исключает внутренние точки доступа', async () => {
    state.internalPoints = new Set(['ALIA кпп-2']);
    state.events = [
      { event_date: '2026-08-04', employee_id: null, physical_person: 'Гость Один', access_point: 'ALIA кпп-2', first_entry: '08:00:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });
    expect(days).toEqual([]);
  });

  it('известный, но не назначенный объект не превращается в «Без объекта»', async () => {
    state.employees = [
      { id: 1, full_name: 'Иванов Иван', org_department_id: 'dept-a', sigur_employee_id: null },
    ];
    state.events = [
      { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'INJOY', first_entry: '07:00:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04',
      dateTo: '2026-08-04',
      visibility: {
        isUnrestricted: false,
        assignedObjectIds: new Set(['obj-1']),
        allowedEmployeeIds: new Set([1]),
        hasObjectViewScope: false,
      },
    });

    expect(days[0].objects.map(o => o.object_key)).toEqual(['obj-2']);
    expect(days[0].objects[0].object_name).toBe('ЖК Инжой');
  });

  it('одноимённые отделы разных компаний не сливаются', async () => {
    state.employees = [
      { id: 1, full_name: 'Первый Сотрудник', org_department_id: 'dept-a', sigur_employee_id: null },
      { id: 2, full_name: 'Второй Сотрудник', org_department_id: 'dept-b', sigur_employee_id: null },
    ];
    state.events = [
      { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'ALIA', first_entry: '07:00:00' },
      { event_date: '2026-08-04', employee_id: 2, physical_person: null, access_point: 'ALIA', first_entry: '07:10:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });

    const groups = days[0].objects[0].groups;
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map(g => g.key))).toEqual(new Set(['local:dept-a', 'local:dept-b']));
    expect(new Set(groups.map(g => g.company_name))).toEqual(new Set(['СУ-10', 'ЛИНИЯ']));
  });

  it('ключ отдела следует за Sigur-матчем, а не за устаревшим org_department_id', async () => {
    state.employees = [
      { id: 1, full_name: 'Иванов Иван', org_department_id: 'dept-a', sigur_employee_id: 777 },
    ];
    // В Sigur сотрудник уже переведён в бр.Тоштемиров компании ЛИНИЯ (sigur 502 → dept-b).
    state.sigurById = new Map([[777, {
      root: { sigur_department_id: 20, name: 'ЛИНИЯ' },
      department: { sigur_department_id: 502, name: 'бр.Тоштемиров' },
    }]]);
    state.events = [
      { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'ALIA', first_entry: '07:00:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });

    expect(days[0].objects[0].groups[0].key).toBe('local:dept-b');
    expect(days[0].objects[0].groups[0].company_name).toBe('ЛИНИЯ');
  });

  it('unsynced без Sigur-матча падает в «Без компании»', async () => {
    state.events = [
      { event_date: '2026-08-04', employee_id: null, physical_person: 'Никто Неизвестный', access_point: 'ALIA', first_entry: '07:00:00' },
    ];

    const days = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });
    expect(days[0].objects[0].groups[0].key).toBe('nocompany');
  });

  describe('построчная авторизация', () => {
    beforeEach(() => {
      state.employees = [
        { id: 1, full_name: 'Свой Сотрудник', org_department_id: 'dept-a', sigur_employee_id: null },
        { id: 2, full_name: 'Чужой Сотрудник', org_department_id: 'dept-b', sigur_employee_id: null },
      ];
      state.events = [
        // назначенный объект
        { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'ALIA', first_entry: '07:00:00' },
        { event_date: '2026-08-04', employee_id: 2, physical_person: null, access_point: 'ALIA', first_entry: '07:05:00' },
        { event_date: '2026-08-04', employee_id: null, physical_person: 'Внешний Гость', access_point: 'ALIA', first_entry: '07:10:00' },
        // чужой объект
        { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'INJOY', first_entry: '12:00:00' },
        { event_date: '2026-08-04', employee_id: 2, physical_person: null, access_point: 'INJOY', first_entry: '12:05:00' },
        // неизвестная точка → «Без объекта»
        { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'НЕИЗВЕСТНАЯ', first_entry: '13:00:00' },
      ];
    });

    const namesByObject = (days: Awaited<ReturnType<typeof collectPresenceExport>>) => {
      const result: Record<string, string[]> = {};
      for (const object of days[0]?.objects ?? []) {
        result[object.object_key] = object.groups
          .flatMap(g => g.employees.map(e => e.full_name))
          .sort();
      }
      return result;
    };

    it('all — видит всё, включая «Без объекта» и unsynced', async () => {
      const days = await collectPresenceExport({
        dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
      });
      expect(namesByObject(days)).toEqual({
        'obj-1': ['Внешний Гость', 'Свой Сотрудник', 'Чужой Сотрудник'],
        'obj-2': ['Свой Сотрудник', 'Чужой Сотрудник'],
        [NO_OBJECT_KEY]: ['Свой Сотрудник'],
      });
    });

    it('object — назначенный объект целиком, «Без объекта» отсутствует', async () => {
      const days = await collectPresenceExport({
        dateFrom: '2026-08-04',
        dateTo: '2026-08-04',
        visibility: {
          isUnrestricted: false,
          assignedObjectIds: new Set(['obj-1']),
          allowedEmployeeIds: 'all',
          hasObjectViewScope: false,
        },
      });
      expect(namesByObject(days)).toEqual({
        'obj-1': ['Внешний Гость', 'Свой Сотрудник', 'Чужой Сотрудник'],
        'obj-2': ['Свой Сотрудник', 'Чужой Сотрудник'],
      });
    });

    it('object + view-скоуп — на своём объекте только свои, unsynced отброшены', async () => {
      const days = await collectPresenceExport({
        dateFrom: '2026-08-04',
        dateTo: '2026-08-04',
        visibility: {
          isUnrestricted: false,
          assignedObjectIds: new Set(['obj-1']),
          allowedEmployeeIds: new Set([1]),
          hasObjectViewScope: true,
        },
      });
      expect(namesByObject(days)).toEqual({
        'obj-1': ['Свой Сотрудник'],
        'obj-2': ['Свой Сотрудник'],
      });
    });

    it('employee — без назначенных объектов видит своих людей на любых объектах', async () => {
      const days = await collectPresenceExport({
        dateFrom: '2026-08-04',
        dateTo: '2026-08-04',
        visibility: {
          isUnrestricted: false,
          assignedObjectIds: new Set(),
          allowedEmployeeIds: new Set([1]),
          hasObjectViewScope: false,
        },
      });
      expect(namesByObject(days)).toEqual({
        'obj-1': ['Свой Сотрудник'],
        'obj-2': ['Свой Сотрудник'],
      });
    });

    it('object_employee — union: свой объект целиком + свои люди на чужих', async () => {
      const days = await collectPresenceExport({
        dateFrom: '2026-08-04',
        dateTo: '2026-08-04',
        visibility: {
          isUnrestricted: false,
          assignedObjectIds: new Set(['obj-1']),
          allowedEmployeeIds: new Set([1]),
          hasObjectViewScope: false,
        },
      });
      expect(namesByObject(days)).toEqual({
        'obj-1': ['Внешний Гость', 'Свой Сотрудник', 'Чужой Сотрудник'],
        'obj-2': ['Свой Сотрудник'],
      });
    });
  });

  it('кэширует датасет по fingerprint и не ходит в БД повторно', async () => {
    state.events = [
      { event_date: '2026-08-04', employee_id: null, physical_person: 'Гость Один', access_point: 'ALIA', first_entry: '07:00:00' },
    ];
    const params = { dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted };

    await collectPresenceExport(params);
    const callsAfterFirst = pgQuery.mock.calls.length;
    await collectPresenceExport(params);

    expect(pgQuery.mock.calls.length).toBe(callsAfterFirst);
  });

  it('разные скоупы не делят кэш', async () => {
    state.employees = [
      { id: 1, full_name: 'Свой Сотрудник', org_department_id: 'dept-a', sigur_employee_id: null },
    ];
    state.events = [
      { event_date: '2026-08-04', employee_id: 1, physical_person: null, access_point: 'ALIA', first_entry: '07:00:00' },
    ];

    const all = await collectPresenceExport({
      dateFrom: '2026-08-04', dateTo: '2026-08-04', visibility: unrestricted,
    });
    const none = await collectPresenceExport({
      dateFrom: '2026-08-04',
      dateTo: '2026-08-04',
      visibility: {
        isUnrestricted: false,
        assignedObjectIds: new Set(),
        allowedEmployeeIds: new Set([999]),
        hasObjectViewScope: false,
      },
    });

    expect(all).toHaveLength(1);
    expect(none).toEqual([]);
  });
});
