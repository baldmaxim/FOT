import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Журнал «Корректировки»: чьи правки идут в журнал (руководители, у заявления — согласовавший), окно дня или
 * объекта (перенесённая дневная правка — окно дня), владение отделом с охватом после, часы по СКУД без правки.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  ownership: vi.fn(),
  describe: vi.fn(),
  attachments: vi.fn(),
  build: vi.fn(),
  schedules: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('./staff-branch-ownership.service.js', () => ({ loadBranchOwnership: h.ownership, describeBranches: h.describe }));
vi.mock('./correction-attachments.service.js', () => ({ countCorrectionAttachmentsLikeWindow: h.attachments }));
vi.mock('./attendance.service.js', () => ({ buildAttendanceEntries: h.build }));
vi.mock('./schedule.service.js', () => ({
  resolveSchedulesForPeriod: h.schedules,
  loadCalendarMonth: vi.fn(async () => null),
  getDayNormHours: vi.fn(() => 8),
}));
vi.mock('./timesheet-object.service.js', () => ({
  isMigratedDayLevelAdjustment: (adjustment: { source_type: string; metadata?: Record<string, unknown> | null }) => (
    adjustment.source_type === 'manual_object' && adjustment.metadata?.migrated_from_day_level === true
  ),
}));

const { computeStaffCorrectionSkud, listStaffCorrections } = await import('./staff-corrections.service.js');

const LINE = 'line';
const BRIGADE = 'brigade';
const SCOPE = { ownershipBranchIds: [LINE, BRIGADE], visibleBranchIds: [LINE, BRIGADE] };

const adjustment = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  employee_id: 1,
  work_date: '2026-11-06',
  status: 'manual',
  hours_override: '10.00',
  source_type: 'manual',
  source_id: 'manual',
  reason: 'вышел позже',
  metadata: null,
  changed_at: new Date('2026-11-07T07:15:00Z'),
  author_profile_id: 'mgr',
  author_name: 'Иванов И. И.',
  author_role: 'manager',
  employee_name: 'Пахомов В. В.',
  object_name: null,
  ...extra,
});

const givenDb = (adjustments: unknown[], requests: unknown[] = []): void => {
  h.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes('JOIN leave_requests lr')) return requests;
    if (String(sql).includes('FROM attendance_adjustments a')) return adjustments;
    throw new Error(`неожиданный запрос: ${sql}`);
  });
};

beforeEach(() => {
  h.query.mockReset();
  h.ownership.mockReset().mockResolvedValue({ employeeIds: [1, 2], ownerOf: (employeeId: number) => (employeeId === 1 ? LINE : BRIGADE) });
  h.describe.mockReset().mockImplementation(async (ids: string[]) => ids.map(id => ({ id, name: id })));
  h.attachments.mockReset().mockImplementation(async (rows: Array<{ id: number }>) => new Map(rows.map(row => [row.id, 2])));
  h.build.mockReset();
  h.schedules.mockReset().mockResolvedValue(new Map([[1, new Map([['2026-11-06', { id: 's' }]])]]));
});

describe('listStaffCorrections', () => {
  it('правка руководителя в табеле: строка с отделом, автором, временем, файлами; окно дня', async () => {
    givenDb([adjustment(1)]);

    const { branches, rows } = await listStaffCorrections('2026-11', SCOPE);

    expect(branches).toEqual([{ id: LINE, name: LINE }]);
    expect(rows).toEqual([{
      id: 1, branch_id: LINE, employee_id: 1, full_name: 'Пахомов В. В.', work_date: '2026-11-06', status: 'manual',
      hours: 10, source: 'table', window: 'day', object_id: null, object_name: null, author_name: 'Иванов И. И.',
      applicant_name: null, changed_at: '2026-11-07T07:15:00.000Z', reason: 'вышел позже', attachments_count: 2,
    }]);
  });

  it('правки админа, кадрового админа, кадров, табельщицы и системные не попадают', async () => {
    givenDb([
      adjustment(1, { author_role: 'admin' }),
      adjustment(2, { author_role: 'hr_admin' }),
      adjustment(3, { author_role: 'hr' }),
      adjustment(4, { author_role: 'timekeeper' }),
      adjustment(5, { author_profile_id: null, author_name: null, author_role: null }),
      adjustment(6, { author_role: 'site_supervisor' }),
    ]);

    const { rows } = await listStaffCorrections('2026-11', SCOPE);

    expect(rows.map(row => row.id)).toEqual([6]);
  });

  it('настоящая объектная правка — окно объекта с объектом; перенесённая дневная — окно дня без объекта', async () => {
    givenDb([
      adjustment(1, { source_type: 'manual_object', source_id: 'obj-1', object_name: 'ЖК Дом 56' }),
      adjustment(2, { source_type: 'manual_object', source_id: 'obj-2', object_name: 'ЖК Alia', metadata: { migrated_from_day_level: true } }),
    ]);

    const { rows } = await listStaffCorrections('2026-11', SCOPE);

    expect(rows[0]).toMatchObject({ window: 'object', object_id: 'obj-1', object_name: 'ЖК Дом 56' });
    expect(rows[1]).toMatchObject({ window: 'day', object_id: null, object_name: null });
  });

  it('из заявления: подавший и согласовавший, отбор — по согласовавшему', async () => {
    givenDb(
      [
        adjustment(1, { source_type: 'manual_object', source_id: 'obj-1', author_profile_id: 'worker', author_role: 'worker', author_name: 'Пахомов В. В.' }),
        adjustment(2, { source_type: 'manual_object', source_id: 'obj-1', author_profile_id: 'worker', author_role: 'worker' }),
      ],
      [
        { adjustment_id: 1, applicant_name: 'Пахомов В. В.', reviewer_profile_id: 'mgr', reviewer_name: 'Иванов И. И.', reviewer_role: 'manager_obj' },
        { adjustment_id: 2, applicant_name: 'Пахомов В. В.', reviewer_profile_id: 'hra', reviewer_name: 'Кадры', reviewer_role: 'hr_admin' },
      ],
    );

    const { rows } = await listStaffCorrections('2026-11', SCOPE);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, source: 'request', author_name: 'Иванов И. И.', applicant_name: 'Пахомов В. В.' });
  });

  it('охват после владения: правка бригады не переезжает в видимый отдел', async () => {
    givenDb([adjustment(1, { employee_id: 2 })]);

    const result = await listStaffCorrections('2026-11', { ...SCOPE, visibleBranchIds: [LINE] });

    expect(result).toEqual({ branches: [], rows: [] });
  });

  it('день без владельца (подрядчик) — не попадает', async () => {
    h.ownership.mockResolvedValue({ employeeIds: [1], ownerOf: () => null });
    givenDb([adjustment(1)]);
    expect((await listStaffCorrections('2026-11', SCOPE)).rows).toEqual([]);
  });

  it('вне охвата, неверный месяц — пусто без запросов', async () => {
    expect(await listStaffCorrections('2026-11', { ...SCOPE, visibleBranchIds: [] })).toEqual({ branches: [], rows: [] });
    expect(await listStaffCorrections('2026-13', SCOPE)).toEqual({ branches: [], rows: [] });
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('computeStaffCorrectionSkud', () => {
  const dayRow = { id: 1, employee_id: 1, work_date: '2026-11-06', window: 'day' as const, object_id: null };
  const objectRow = { id: 2, employee_id: 1, work_date: '2026-11-06', window: 'object' as const, object_id: 'obj-1' };
  const emptyObjectRow = { id: 3, employee_id: 1, work_date: '2026-11-06', window: 'object' as const, object_id: 'obj-9' };

  beforeEach(() => {
    h.build.mockResolvedValue({
      entries: [{ employee_id: 1, work_date: '2026-11-06', hours_worked: 6.5, display_hours_worked: 6, first_entry: '08:12:00', last_exit: '15:20:00' }],
      objectEntries: [
        { employee_id: 1, work_date: '2026-11-06', object_id: 'obj-1', hours_worked: 4.25, display_hours_worked: 4 },
        { employee_id: 1, work_date: '2026-11-06', object_id: 'obj-2', hours_worked: 2.25, display_hours_worked: 2 },
      ],
    });
  });

  it('день — по СКУД без правки (факт или урезанное — как у роли), вход–выход; расчёт без правок и без записи «Дороги»', async () => {
    expect((await computeStaffCorrectionSkud('2026-11', [dayRow], true))[1])
      .toEqual({ norm_hours: 8, skud_hours: 6.5, first_entry: '08:12:00', last_exit: '15:20:00' });
    expect((await computeStaffCorrectionSkud('2026-11', [dayRow], false))[1]?.skud_hours).toBe(6);
    expect(h.build).toHaveBeenCalledWith(expect.objectContaining({
      ignoreAdjustments: true, persistTravelSegments: false, includeObjectDetails: true,
    }));
  });

  it('объектная правка — часы её объекта; проходов на объекте нет — 0 и пустой вход–выход', async () => {
    const result = await computeStaffCorrectionSkud('2026-11', [objectRow, emptyObjectRow], true);
    expect(result[2]).toEqual({ norm_hours: 8, skud_hours: 4.25, first_entry: null, last_exit: null });
    expect(result[3]).toEqual({ norm_hours: 8, skud_hours: 0, first_entry: null, last_exit: null });
  });

  it('нет строк — без расчёта', async () => {
    expect(await computeStaffCorrectionSkud('2026-11', [], true)).toEqual({});
    expect(h.build).not.toHaveBeenCalled();
  });
});
