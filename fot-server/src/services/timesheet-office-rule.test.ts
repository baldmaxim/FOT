import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «Офис» из окна «Режим табелирования» (миграция 291): правило отдела, блокировка выбора,
 * аудит. SQL проверяется по форме — поведение на настоящей БД в employee-timesheet-object.pg.test.ts.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  logWithClient: vi.fn(),
  logFromRequestWithClient: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query }));
vi.mock('./audit.service.js', () => ({
  AUDIT_ACTIONS: { TIMESHEET_OFFICE_UPDATED: 'TIMESHEET_OFFICE_UPDATED' },
  auditService: { logWithClient: h.logWithClient, logFromRequestWithClient: h.logFromRequestWithClient },
}));

const {
  enforceOfficeForDepartments,
  isTimesheetOfficeLocked,
  officeRuleAuditEntries,
  personalOfficeSql,
  writeOfficeAudit,
} = await import('./timesheet-office-rule.js');

const DEPT = '11111111-1111-4111-8111-111111111111';
const CONTRACTORS = ['22222222-2222-4222-8222-222222222222'];

function fakeClient(selected: Array<Record<string, unknown>>, updatedIds: number[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('FOR UPDATE OF e')) return { rows: selected };
    if (sql.startsWith('UPDATE employees')) return { rows: updatedIds.map(id => ({ id })) };
    return { rows: [] };
  });
  return { client: { query } as never, calls };
}

beforeEach(() => {
  Object.values(h).forEach(fn => fn.mockReset());
});

describe('personalOfficeSql', () => {
  it('NULL-безопасный признак: у строки без режима — false, а не NULL', () => {
    const sql = personalOfficeSql('e');
    expect(sql).toContain("e.timesheet_export_mode IS NOT DISTINCT FROM 'current_activity'");
    expect(sql).toContain('e.timesheet_export_set_by IS NULL');
    expect(sql).toContain('e.timesheet_export_set_at IS NOT NULL');
    // По автору не проверяем: при удалении учётки FK его обнуляет.
    expect(sql).not.toContain('set_by_user_id');
  });
});

describe('enforceOfficeForDepartments', () => {
  it('пустой список отделов — ни одного запроса', async () => {
    const { client, calls } = fakeClient([], []);
    expect(await enforceOfficeForDepartments(client, [], CONTRACTORS)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('«Офис» всем, кроме уже «Офиса» от авто и личного: FOR UPDATE по id, условия повторены в UPDATE', async () => {
    const { client, calls } = fakeClient([
      { id: 20, full_name: 'Шупта М. С.', department_id: DEPT, mode: 'object', object_id: 'o-metro', set_by: 'employee' },
      { id: 21, full_name: 'Новичок', department_id: DEPT, mode: null, object_id: null, set_by: null },
    ], [20, 21]);

    const changes = await enforceOfficeForDepartments(client, [DEPT], CONTRACTORS);

    const [select, update] = calls;
    expect(select.sql).toContain('JOIN timesheet_office_departments tod');
    expect(select.sql).toContain('ORDER BY e.id');
    expect(select.sql).toContain('FOR UPDATE OF e');
    expect(select.sql).toContain("e.employment_status = 'active'");
    expect(select.sql).toContain("NOT (e.timesheet_export_mode IS NOT DISTINCT FROM 'current_activity'");
    expect(select.params).toEqual([CONTRACTORS, false, [DEPT]]);

    expect(update.sql).toContain("timesheet_export_set_by = 'auto'");
    expect(update.sql).toContain('tod.org_department_id = e.org_department_id');
    expect(update.sql).toContain("e.employment_status = 'active'");
    expect(update.params).toEqual([CONTRACTORS, [20, 21]]);

    expect(changes).toEqual([
      { employeeId: 20, fullName: 'Шупта М. С.', departmentId: DEPT, fromMode: 'object', fromObjectId: 'o-metro', fromSetBy: 'employee' },
      { employeeId: 21, fullName: 'Новичок', departmentId: DEPT, fromMode: null, fromObjectId: null, fromSetBy: null },
    ]);
  });

  it('all — все отделы с правилом; в изменения попадают только реально обновлённые', async () => {
    const { client, calls } = fakeClient([
      { id: 30, full_name: 'А', department_id: DEPT, mode: 'object', object_id: 'o-dom', set_by: 'auto' },
      { id: 31, full_name: 'Б', department_id: DEPT, mode: 'object', object_id: 'o-dom', set_by: 'auto' },
    ], [31]);
    const changes = await enforceOfficeForDepartments(client, 'all', CONTRACTORS);
    expect(calls[0].params).toEqual([CONTRACTORS, true, []]);
    expect(changes.map(change => change.employeeId)).toEqual([31]);
  });

  it('некого менять — без UPDATE', async () => {
    const { client, calls } = fakeClient([], []);
    expect(await enforceOfficeForDepartments(client, 'all', CONTRACTORS)).toEqual([]);
    expect(calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
  });
});

describe('isTimesheetOfficeLocked', () => {
  it('личный «Офис» или отдел с «Офисом»; в транзакции — через её клиента', async () => {
    h.query.mockResolvedValue([{ locked: true }]);
    expect(await isTimesheetOfficeLocked(20)).toBe(true);
    expect(String(h.query.mock.calls[0][0])).toContain('FROM timesheet_office_departments tod');

    const clientQuery = vi.fn(async () => ({ rows: [{ locked: false }] }));
    expect(await isTimesheetOfficeLocked(20, { query: clientQuery } as never)).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE e.id = $1::int'), [20]);

    h.query.mockResolvedValue([]);
    expect(await isTimesheetOfficeLocked(999)).toBe(false);
  });
});

describe('аудит', () => {
  it('строка на сотрудника: прежнее значение, отдел, причина', () => {
    expect(officeRuleAuditEntries([
      { employeeId: 20, fullName: 'Шупта', departmentId: DEPT, fromMode: 'object', fromObjectId: 'o-metro', fromSetBy: 'employee' },
    ], 'current_month')).toEqual([{
      entityType: 'employee',
      entityId: '20',
      details: {
        employee_name: 'Шупта', via: 'department', department_id: DEPT, reason: 'current_month',
        old_mode: 'object', old_object_id: 'o-metro', old_set_by: 'employee',
        new_mode: 'current_activity', new_object_id: null, new_set_by: 'auto',
      },
    }]);
  });

  it('окно пишет от запроса, ночь — без пользователя', async () => {
    const client = {} as never;
    const entries = [{ entityType: 'employee' as const, entityId: '20', details: { via: 'personal' } }];
    const req = { ip: '1.1.1.1' } as never;

    await writeOfficeAudit(client, entries, { req, userId: 'user-1' });
    expect(h.logFromRequestWithClient).toHaveBeenCalledWith(
      client, req, 'user-1', 'TIMESHEET_OFFICE_UPDATED',
      { entityType: 'employee', entityId: '20', details: { via: 'personal' } },
    );

    await writeOfficeAudit(client, entries, { req: null, userId: null });
    expect(h.logWithClient).toHaveBeenCalledWith(client, {
      user_id: null, action: 'TIMESHEET_OFFICE_UPDATED', entity_type: 'employee', entity_id: '20',
      details: { via: 'personal' },
    });
  });
});
