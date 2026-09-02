import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

/**
 * Матрица решений materializeVersion после появления объектной разбивки.
 *
 * Зачем отдельный файл: timesheet-version.service.test.ts — чистые юниты на хэш и
 * resolveState, без БД. Здесь нужен фейковый клиент и замоканные сборщики, чтобы
 * проверить именно ветвление «дописать снимок / создать редакцию / не делать ничего».
 *
 * Ключевой инвариант: к УЖЕ ПОДТВЕРЖДЁННОЙ (ACK) версии снимок не дописывается никогда.
 * Состояние выгрузки считается сравнением ack.version_id с текущим version_id, поэтому
 * дописывание оставило бы подачу в exported — 1С об объектах не узнала бы, а старый ACK
 * выглядел бы подтверждением данных, которых на момент ACK не существовало.
 */

const APPROVAL = {
  id: 855,
  department_id: null,
  manager_employee_id: 2617,
  start_date: '2026-08-01',
  end_date: '2026-08-15',
  status: 'approved',
};

// ─── Моки сборщиков: сам расчёт табеля здесь не проверяется ───────────────────

const objectHours = { value: 8 };

vi.mock('./timesheet-approval-employees-snapshot.service.js', () => ({
  listApprovalEmployees: vi.fn(async () => [{ employee_id: 1, full_name: 'Иванов И. И.' }]),
}));

vi.mock('./timesheet-department-assignments.service.js', () => ({
  listEmployeeMembershipsForDepartmentPeriod: vi.fn(async () => []),
}));

vi.mock('../controllers/timesheet-assigned-export.controller.js', () => ({
  listBrigadeSupervisorEmployeeIdsForDepartments: vi.fn(async () => new Set<number>()),
}));

vi.mock('./timesheet-day-ownership.service.js', () => ({
  resolveDayOwnership: vi.fn(async () => new Map()),
  ownsDay: () => true,
  ownershipKey: (a: number, b: number, c: string) => `${a}|${b}|${c}`,
  enumerateDatesInclusive: () => ['2026-08-03'],
}));

vi.mock('./attendance.service.js', () => ({ hasRealActivity: () => true }));

vi.mock('./timesheet-lock.service.js', () => ({ findApprovalLocksForEmployeeDates: vi.fn(async () => new Map()) }));

vi.mock('./timesheet-export-mode.service.js', () => ({
  resolveExportModes: vi.fn(async () => new Map([[1, {
    mode: 'skud', pinnedObjectId: null, source: 'legacy_default',
  }]])),
  CURRENT_ACTIVITY_ADDRESS: 'Текущая деятельность',
  DEFAULT_EXPORT_MODE: { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' },
}));

vi.mock('./timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async () => ({
    employees: [{ id: 1, full_name: 'Иванов И. И.', sigur_employee_id: 42, position_id: null }],
    posMap: new Map(),
    entries: [],
    // Часы дня всегда 8 — меняется только раскладка по объектам.
    dataMap: new Map([[1, new Map([['2026-08-03', { status: 'work', hours: 8 }]])]]),
    objectEntries: [{
      adjustment_id: null,
      employee_id: 1,
      work_date: '2026-08-03',
      object_key: 'obj-a',
      object_id: null,
      object_name: 'Объект А',
      hours_worked: objectHours.value,
      display_hours_worked: objectHours.value,
      base_hours_worked: objectHours.value,
      is_correction: false,
    }],
  })),
}));

const { materializeVersion } = await import('./timesheet-version.service.js');

// ─── Фейковый клиент: хранит версии и снимки объектов в памяти ────────────────

interface IStoredVersion {
  id: number;
  revision: number;
  content_hash: string;
}

const store = {
  versions: [] as IStoredVersion[],
  objects: new Map<number, string>(),
  managers: new Map<number, string>(),
  acked: new Set<number>(),
  nextId: 9000,
  /** Кто числится руководителем отдела сотрудника. Меняем, чтобы двигать хэш. */
  departmentManagerIds: [501] as number[],
};

const client = {
  async query(sql: string, params?: unknown[]) {
    if (sql.includes('FROM org_departments')) {
      return { rows: [{ id: 'dept-1', name: 'бр. Тестовая' }] };
    }
    if (sql.includes('tab_number')) return { rows: [{ id: 1, tab_number: '01476' }] };
    if (sql.includes('FROM skud_objects')) return { rows: [] };

    // ── резолвинг отдела для персональной подачи ──
    if (sql.includes('hire_date')) {
      return { rows: [{
        id: 1, hire_date: '2020-01-01', org_department_id: 'dept-1',
        employment_status: 'active', dismissal_date: null,
        excluded_from_timesheet: false, excluded_from_timesheet_date: null,
      }] };
    }
    if (sql.includes('FROM employee_assignments')) return { rows: [] };
    if (sql.includes('FROM employee_dismissal_events')) return { rows: [] };

    // ── руководители отдела ──
    if (sql.includes('FROM employee_department_access')) {
      return { rows: store.departmentManagerIds.map(id => ({ employee_id: id, department_id: 'dept-1' })) };
    }
    if (sql.includes('employment_status')) {
      return { rows: store.departmentManagerIds.map(id => ({
        id, full_name: `Руководитель ${id}`, employment_status: 'active', is_archived: false,
      })) };
    }

    if (sql.includes('FROM timesheet_versions v')) {
      const latest = store.versions.at(-1);
      if (!latest) return { rows: [] };
      return {
        rows: [{
          ...latest,
          approval_id: APPROVAL.id,
          employees_count: 1,
          total_hours: 8,
          created_at: '2026-08-16T09:00:00.000Z',
          objects_content_hash: store.objects.get(latest.id) ?? null,
          managers_content_hash: store.managers.get(latest.id) ?? null,
          acked: store.acked.has(latest.id),
        }],
      };
    }

    if (sql.includes('INSERT INTO timesheet_versions')) {
      const row = {
        id: (store.nextId += 1),
        revision: Number(params![1]),
        content_hash: String(params![2]),
      };
      store.versions.push(row);
      return { rows: [{ ...row, approval_id: APPROVAL.id, employees_count: 1, total_hours: 8, created_at: 'now' }] };
    }

    if (sql.includes('INSERT INTO timesheet_version_objects')) {
      const versionId = Number(params![0]);
      if (!store.objects.has(versionId)) store.objects.set(versionId, String(params![1]));
      return { rows: [] };
    }

    if (sql.includes('INSERT INTO timesheet_version_managers')) {
      const versionId = Number(params![0]);
      if (!store.managers.has(versionId)) store.managers.set(versionId, String(params![1]));
      return { rows: [] };
    }

    throw new Error(`Неожиданный SQL в тесте: ${sql.slice(0, 80)}`);
  },
} as unknown as PoolClient;

const run = () => materializeVersion(client, APPROVAL, 'close', null);

beforeEach(() => {
  store.versions = [];
  store.objects = new Map();
  store.managers = new Map();
  store.acked = new Set();
  store.nextId = 9000;
  store.departmentManagerIds = [501];
  objectHours.value = 8;
});

describe('materializeVersion + объектная разбивка', () => {
  it('первая материализация: создаёт версию и снимок объектов', async () => {
    const { version, created } = await run();
    expect(created).toBe(true);
    expect(store.objects.get(version.id)).toBeTruthy();
  });

  it('повторное закрытие без изменений: ни новой редакции, ни новой строки', async () => {
    const first = await run();
    const second = await run();
    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
    expect(store.versions).toHaveLength(1);
  });

  it('снимка нет и версия НЕ подтверждена: дописывается на месте, revision не растёт', async () => {
    const first = await run();
    store.objects.delete(first.version.id); // эмулируем редакцию, созданную до внедрения

    const second = await run();

    expect(second.created).toBe(false);
    expect(store.versions).toHaveLength(1);
    expect(store.objects.get(first.version.id)).toBeTruthy();
  });

  it('снимка нет, но версия УЖЕ подтверждена: создаётся новая редакция', async () => {
    const first = await run();
    store.objects.delete(first.version.id);
    store.acked.add(first.version.id);

    const second = await run();

    expect(second.created).toBe(true);
    expect(store.versions).toHaveLength(2);
    expect(second.version.revision).toBe(2);
    // Табель не менялся — content_hash тот же, редакция другая.
    expect(second.version.content_hash).toBe(first.version.content_hash);
    expect(store.objects.get(second.version.id)).toBeTruthy();
  });

  it('часы дня прежние, но разбивка по объектам изменилась: новая редакция', async () => {
    const first = await run();
    const firstObjectsHash = store.objects.get(first.version.id);

    // Тот же день и те же 8 часов, но объект другой — content_hash табеля не изменится.
    const exportService = await import('./timesheet-export.service.js');
    vi.mocked(exportService.fetchTimesheetDataForEmployees).mockImplementation(async () => ({
      employees: [{ id: 1, full_name: 'Иванов И. И.', sigur_employee_id: 42, position_id: null }],
      posMap: new Map(),
      entries: [],
      dataMap: new Map([[1, new Map([['2026-08-03', { status: 'work', hours: 8 }]])]]),
      objectEntries: [{
        adjustment_id: null,
        employee_id: 1,
        work_date: '2026-08-03',
        object_key: 'obj-b',
        object_id: null,
        object_name: 'Объект Б',
        hours_worked: 8,
        display_hours_worked: 8,
        base_hours_worked: 8,
        is_correction: false,
      }],
    }) as never);

    const second = await run();

    expect(second.created).toBe(true);
    expect(second.version.content_hash).toBe(first.version.content_hash);
    expect(store.objects.get(second.version.id)).not.toBe(firstObjectsHash);
  });
  it('первая материализация пишет и снимок руководителей', async () => {
    const { version } = await run();
    expect(store.managers.get(version.id)).toBeTruthy();
  });

  it('часы и объекты прежние, но руководителя отдела сменили: новая редакция', async () => {
    // content_hash табеля и objects_content_hash не меняются — заметить правку может
    // только третий хэш. Без него документ в 1С навсегда остался бы со старым начальником.
    const first = await run();
    const firstManagersHash = store.managers.get(first.version.id);

    store.departmentManagerIds = [777];
    const second = await run();

    expect(second.created).toBe(true);
    expect(second.version.content_hash).toBe(first.version.content_hash);
    expect(store.managers.get(second.version.id)).not.toBe(firstManagersHash);
  });

  it('снимка руководителей нет и версия НЕ подтверждена: дописывается без роста revision', async () => {
    const first = await run();
    store.managers.delete(first.version.id); // редакция, созданная до внедрения

    const second = await run();

    expect(second.created).toBe(false);
    expect(store.versions).toHaveLength(1);
    expect(store.managers.get(first.version.id)).toBeTruthy();
  });

  it('снимка руководителей нет, но версия УЖЕ подтверждена: новая редакция', async () => {
    // Дописать к ACK-нутой нельзя: подача осталась бы exported и не вернулась в очередь.
    const first = await run();
    store.managers.delete(first.version.id);
    store.acked.add(first.version.id);

    const second = await run();

    expect(second.created).toBe(true);
    expect(second.version.revision).toBe(2);
    expect(second.version.content_hash).toBe(first.version.content_hash);
    expect(store.managers.get(second.version.id)).toBeTruthy();
  });
});
