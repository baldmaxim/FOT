import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Кнопки «Открыть табель» и «Закрыть табель» вкладки «Выходные» на НАСТОЯЩЕМ PostgreSQL.
 *
 * Мок не докажет главного: день держат сразу две подачи; открываются все или ни одна; запись об открытии совпадает с
 * подачей до микросекунд; подача, открытая вручную или закрытая и открытая заново, вкладке не принадлежит.
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/services/staff-weekends-periods.pg.test.ts
 * Без переменной набор скипается. БД — пустая тестовая: срез таблиц пересоздаётся.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 6 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});
vi.mock('./skud-shared.service.js', async (importActual) => ({
  ...(await importActual<typeof import('./skud-shared.service.js')>()),
  collectDeptIds: vi.fn(async (departmentId: string) => [departmentId]),
}));

const {
  listActiveUnlocks,
  listLockingApprovalIds,
  openApprovalsTogether,
  previewWeekendPeriod,
  WeekendPeriodConflictError,
} = await import('./staff-weekends-periods.service.js');
const {
  findApprovalLockForEmployeeDate,
  findApprovalLocksForEmployeeDates,
  listLockingApprovalsForEmployeeDates,
  lockKey,
} = await import('./timesheet-lock.service.js');

const LINE = '00000000-0000-4000-8000-0000000000a1';
const GENERAL = '00000000-0000-4000-8000-0000000000a2';
const USER = '00000000-0000-4000-8000-0000000000e1';
const OPERATION = '11111111-1111-4111-8111-111111111111';
const OPERATION_2 = '22222222-2222-4222-8222-222222222222';
const H1 = '2026-10-01';

// Сотрудник Общестроя, его личный руководитель, сотрудник ЛИНИИ из того же личного табеля.
const KABYKA = 1;
const BESHLEY = 2;
const SMIRNOV = 3;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const addApproval = async (fields: {
  departmentId?: string | null;
  managerEmployeeId?: number | null;
  status?: string;
  start?: string;
  end?: string;
  employees: number[];
}): Promise<number> => {
  const [row] = await q<{ id: number }>(
    `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [fields.departmentId ?? null, fields.managerEmployeeId ?? null, fields.start ?? '2026-10-01', fields.end ?? '2026-10-15', fields.status ?? 'approved'],
  );
  for (const employeeId of fields.employees) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)', [row!.id, employeeId]);
  }
  return Number(row!.id);
};

const open = (operationId: string, approvalIds: number[], overrides: { branchId?: string; periodStart?: string } = {}) => openApprovalsTogether({
  operationId,
  branchId: overrides.branchId ?? GENERAL,
  periodStart: overrides.periodStart ?? H1,
  approvalIds,
  userId: USER,
  reason: 'правка выходных',
});

const isUnlocked = async (id: number): Promise<boolean> => {
  const [row] = await q<{ unlocked_at: Date | null }>('SELECT unlocked_at FROM timesheet_approvals WHERE id = $1', [id]);
  return row?.unlocked_at != null;
};

const kabykaDay = { employeeId: KABYKA, workDate: '2026-10-10' };
const kabykaRow = { employee_id: KABYKA, full_name: 'Кабыка', position: null, days: ['2026-10-10'] };

describeIf('кнопки «Открыть табель» и «Закрыть табель» на настоящей БД', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      CREATE SCHEMA IF NOT EXISTS app_auth;
      DROP TABLE IF EXISTS staff_weekend_unlocks, timesheet_approval_employees, timesheet_approvals,
        employee_dismissal_events, employee_assignments, employee_department_access,
        user_profiles, system_roles, employees, org_departments, system_settings, app_auth.users CASCADE;
      CREATE TABLE system_settings (key text PRIMARY KEY, value text NULL);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL,
        is_archived boolean NOT NULL DEFAULT false, employment_status text NOT NULL DEFAULT 'active', dismissal_date date,
        excluded_from_timesheet boolean NOT NULL DEFAULT false, excluded_from_timesheet_date date
      );
      CREATE TABLE system_roles (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, is_admin boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, employee_id integer NULL, system_role_id uuid NULL, is_approved boolean NOT NULL DEFAULT true);
      CREATE TABLE app_auth.users (id uuid PRIMARY KEY, is_disabled boolean NOT NULL DEFAULT false);
      CREATE TABLE employee_department_access (
        id serial PRIMARY KEY, employee_id integer NOT NULL, department_id uuid NOT NULL,
        access_level text NOT NULL DEFAULT 'full', source text NOT NULL DEFAULT 'manual_admin_ui', is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE employee_assignments (
        id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid NULL,
        effective_from date NOT NULL, effective_to date NULL
      );
      CREATE TABLE employee_dismissal_events (
        id bigserial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid,
        dismissal_date date, cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid, manager_employee_id integer,
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
        unlocked_at timestamptz, unlocked_by uuid, unlock_reason text, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_approval_employees (approval_id bigint NOT NULL, employee_id integer NOT NULL);
    `);
    // Таблица вкладки — строго из файла миграции, а не копией здесь.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    await pg.pool!.query(readFileSync(resolve(process.cwd(), '../docs/migrations/350_staff_weekend_unlocks.sql'), 'utf8'));
  });

  beforeEach(async () => {
    await pg.pool!.query(`TRUNCATE staff_weekend_unlocks, timesheet_approval_employees, timesheet_approvals,
      employee_assignments, employee_dismissal_events, employees, org_departments RESTART IDENTITY CASCADE`);
    await q(`INSERT INTO org_departments (id, name) VALUES ($1, 'ЛИНИЯ'), ($2, 'ЛИНИЯ-Общестрой')`, [LINE, GENERAL]);
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES
      ($1, 'Кабыка Дмитрий', $4), ($2, 'Бешлей Олег', $4), ($3, 'Смирнов Евгений', $5)`, [KABYKA, BESHLEY, SMIRNOV, GENERAL, LINE]);
    for (const [employeeId, departmentId] of [[KABYKA, GENERAL], [BESHLEY, GENERAL], [SMIRNOV, LINE]] as const) {
      await q('INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, $3)', [employeeId, departmentId, '2026-01-01']);
    }
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  describe('какие подачи держат день', () => {
    it('день в табеле отдела и в личном табеле: новая функция отдаёт обе, прежняя — приоритетную', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA, BESHLEY] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, status: 'submitted', employees: [KABYKA, BESHLEY] });

      const all = await listLockingApprovalsForEmployeeDates([kabykaDay]);
      expect(all.get(lockKey(KABYKA, '2026-10-10'))?.map(lock => lock.id).sort((a, b) => a - b)).toEqual([department, personal]);

      const first = await findApprovalLocksForEmployeeDates([kabykaDay]);
      expect(first.get(lockKey(KABYKA, '2026-10-10'))).toMatchObject({ id: department, status: 'approved' });
    });

    it('после снятия замка с отдельской подачи день всё ещё держит личная: нужно открыть обе', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA, BESHLEY] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, status: 'submitted', employees: [KABYKA, BESHLEY] });

      await open(OPERATION, [department]);
      expect((await findApprovalLockForEmployeeDate(KABYKA, '2026-10-10'))?.id).toBe(personal);

      await open(OPERATION_2, [personal]);
      expect(await findApprovalLockForEmployeeDate(KABYKA, '2026-10-10')).toBeNull();
    });

    it('кнопка половины берёт только дни этой половины', async () => {
      const first = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      const second = await addApproval({ departmentId: GENERAL, start: '2026-10-16', end: '2026-10-31', employees: [KABYKA] });
      const row = { ...kabykaRow, days: ['2026-10-10', '2026-10-24'] };

      expect(await listLockingApprovalIds([row], 1)).toEqual([first]);
      expect(await listLockingApprovalIds([row], 2)).toEqual([second]);
    });

    it('чужие и открытые подачи в кнопку не попадают', async () => {
      const opened = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [opened]);
      await addApproval({ departmentId: LINE, employees: [SMIRNOV] });
      await addApproval({ departmentId: GENERAL, status: 'draft', employees: [KABYKA] });

      expect(await listLockingApprovalIds([kabykaRow], 1)).toEqual([]);
    });
  });

  describe('открыть вместе', () => {
    it('все подачи открыты, статус не меняется, причина и автор записаны', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, status: 'submitted', employees: [KABYKA] });

      const updated = await open(OPERATION, [department, personal]);

      expect(updated).toHaveLength(2);
      const rows = await q<{ status: string; unlocked_by: string; unlock_reason: string }>(
        'SELECT status, unlocked_by, unlock_reason FROM timesheet_approvals ORDER BY id',
      );
      expect(rows.map(row => row.status)).toEqual(['approved', 'submitted']);
      expect(rows.every(row => row.unlocked_by === USER && row.unlock_reason === 'правка выходных')).toBe(true);
    });

    it('одну успели открыть вручную — откат: не открыта ни одна, записей нет', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, employees: [KABYKA] });
      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [personal]);

      await expect(open(OPERATION, [department, personal])).rejects.toBeInstanceOf(WeekendPeriodConflictError);

      expect(await isUnlocked(department)).toBe(false);
      expect(await q('SELECT 1 FROM staff_weekend_unlocks')).toHaveLength(0);
    });

    it('одну успели вернуть на доработку — откат', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, status: 'rejected', employees: [KABYKA] });

      await expect(open(OPERATION, [department, personal])).rejects.toBeInstanceOf(WeekendPeriodConflictError);
      expect(await isUnlocked(department)).toBe(false);
    });

    it('два одновременных открытия: выигрывает одно, второе ничего не меняет', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, employees: [KABYKA] });

      const results = await Promise.allSettled([open(OPERATION, [department, personal]), open(OPERATION_2, [personal, department])]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const operations = await q<{ operation_id: string }>('SELECT DISTINCT operation_id FROM staff_weekend_unlocks');
      expect(operations).toHaveLength(1);
    });
  });

  describe('что закрывает кнопка', () => {
    it('запись совпадает с подачей до микросекунд: подача считается открытой вкладкой', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await open(OPERATION, [department]);

      expect((await listActiveUnlocks([GENERAL], [H1])).map(row => Number(row.id))).toEqual([department]);
    });

    it('открытую вручную в «Табеле» не закрывает', async () => {
      const manual = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [manual]);

      expect(await listActiveUnlocks([GENERAL], [H1])).toEqual([]);
    });

    it('закрытую и открытую заново в «Табеле» не закрывает: это уже чужая работа', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await open(OPERATION, [department]);
      await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [department]);
      expect(await listActiveUnlocks([GENERAL], [H1])).toEqual([]);

      await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [department]);
      expect(await listActiveUnlocks([GENERAL], [H1])).toEqual([]);
    });

    it('другой отдел и другая половина кнопке не принадлежат', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await open(OPERATION, [department]);

      expect(await listActiveUnlocks([LINE], [H1])).toEqual([]);
      expect(await listActiveUnlocks([GENERAL], ['2026-10-16'])).toEqual([]);
    });

    it('удаление подачи убирает и запись', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA] });
      await open(OPERATION, [department]);
      await q('DELETE FROM timesheet_approvals WHERE id = $1', [department]);

      expect(await q('SELECT 1 FROM staff_weekend_unlocks')).toHaveLength(0);
    });
  });

  describe('окно подтверждения показывает, кого это затронет', () => {
    const branch = { id: GENERAL, name: 'ЛИНИЯ-Общестрой', rows: [kabykaRow] };

    it('личный табель с человеком другого отдела: состав и этот человек видны', async () => {
      const department = await addApproval({ departmentId: GENERAL, employees: [KABYKA, BESHLEY] });
      const personal = await addApproval({ managerEmployeeId: BESHLEY, status: 'submitted', employees: [KABYKA, BESHLEY, SMIRNOV] });

      const preview = await previewWeekendPeriod('2026-10', 1, branch);

      expect(preview?.expected_approval_ids).toEqual([department, personal].sort((a, b) => a - b));
      expect(preview?.approvals.map(item => item.label)).toEqual(['Табель отдела: ЛИНИЯ-Общестрой', 'Личный табель: Бешлей Олег']);
      expect(preview?.approvals.map(item => item.people_count)).toEqual([2, 3]);
      expect(preview?.others).toEqual([{ department: 'ЛИНИЯ', count: 1, names: ['Смирнов Евгений'] }]);
      expect(preview).toMatchObject({ start_date: '2026-10-01', end_date: '2026-10-15' });
    });

    it('все люди подач — этого отдела: других нет', async () => {
      await addApproval({ departmentId: GENERAL, employees: [KABYKA, BESHLEY] });
      const preview = await previewWeekendPeriod('2026-10', 1, branch);
      expect(preview?.others).toEqual([]);
    });

    it('нечего открывать — пустой состав', async () => {
      const preview = await previewWeekendPeriod('2026-10', 2, branch);
      expect(preview).toMatchObject({ expected_approval_ids: [], approvals: [], others: [], start_date: '2026-10-16', end_date: '2026-10-31' });
    });
  });
});
