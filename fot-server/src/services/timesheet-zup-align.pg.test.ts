import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import type { PoolClient } from 'pg';

/**
 * Выравнивание табеля ФОТ по 1С (ЗУП) на НАСТОЯЩЕМ PostgreSQL: запись, отказ при изменившемся дне, повтор,
 * откат один в один. Снимок дня (живой табель) подменён: отпечаток — строки дня и закрытые подачи; сама запись,
 * перенос вложений, аудит, пометка подач и откат — настоящий SQL.
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/services/timesheet-zup-align.pg.test.ts
 * Без переменной набор скипается. БД — пустая тестовая: срез таблиц пересоздаётся.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async (importActual) => {
  const actual = await importActual<typeof import('../config/postgres.js')>();
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 4 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    ...actual,
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
  };
});

import { applyZupPlan, ZupPlanStaleError, type IZupApplyDeps } from './timesheet-zup-align.apply.js';
import { revertZupBackup, ZupRevertConflictError } from './timesheet-zup-align.revert.js';
import { zupPairKey, type IZupDaySnapshot, type IZupPair } from './timesheet-zup-align.snapshot.js';
import { computeZupPlanSha, parseZupPlan, type IZupPlan, type IZupPlanItem, type ZupTarget } from './timesheet-zup-align.types.js';
import { liveDayMatches } from './timesheet-zup-align.verify.js';

const snap = (over: Partial<IZupDaySnapshot>): IZupDaySnapshot => ({
  employeeId: 1, date: '2026-10-04', status: null, hours: null, corrected: false, overridden: false, dropped: false,
  kind: null, absence: null, paidMinutes: null, overtimeMinutes: null, normHours: 0, workingDay: false,
  objects: [], adjustments: [], closedApprovalIds: [], fingerprint: '', ...over,
});

describe('liveDayMatches — день ФОТ после правки «ЗУП»', () => {
  it('удалёнка в выходной без часов не идёт в основу — расхождение', () => {
    expect(liveDayMatches(snap({ status: 'remote', kind: null }), { kind: 'status', status: 'remote', hours: 8 }))
      .toMatch(/рабочим днём/);
  });
  it('удалёнка с часами 1С — выход в выходной на эти часы', () => {
    expect(liveDayMatches(snap({ status: 'remote', kind: 'dayoff', paidMinutes: 480 }), { kind: 'status', status: 'remote', hours: 8 })).toBeNull();
    expect(liveDayMatches(snap({ status: 'remote', kind: 'dayoff', paidMinutes: 600 }), { kind: 'status', status: 'remote', hours: 8 }))
      .toMatch(/к оплате 10 ч, в 1С 8 ч/);
  });
  it('явка, обнуление, отсутствие', () => {
    expect(liveDayMatches(snap({ kind: 'workday', paidMinutes: 420 }), { kind: 'day', hours: 7 })).toBeNull();
    expect(liveDayMatches(snap({ kind: 'workday', paidMinutes: 600 }), { kind: 'day', hours: 7 })).toMatch(/к оплате 10 ч/);
    expect(liveDayMatches(snap({ status: 'manual', kind: null }), { kind: 'zero' })).toBeNull();
    expect(liveDayMatches(snap({ kind: 'absence', absence: 'unpaid' }), { kind: 'status', status: 'unpaid' })).toBeNull();
    expect(liveDayMatches(snap({ kind: null }), { kind: 'status', status: 'unpaid' })).toMatch(/ожидалось unpaid/);
  });
});

const ACTOR = { userId: '11111111-1111-4111-8111-111111111111', email: 'admin@example.test' };
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const EMP = 890;
const EMP2 = 425;
const APPROVAL = 2772;

const SLICE_SQL = `
DROP TABLE IF EXISTS audit_logs, document_links, documents, attendance_adjustments, timesheet_approval_employees,
  timesheet_approvals, employees, user_profiles CASCADE;
CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
CREATE TABLE employees (id integer PRIMARY KEY, full_name text);
CREATE TABLE attendance_adjustments (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date date NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['work','vacation','dayoff','remote','unpaid','absent','sick','manual',
    'educational_leave','sick_worked','study_day'])),
  hours_override numeric(5,2),
  source_type text NOT NULL,
  source_id text NOT NULL,
  reason text,
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  approval_status text NOT NULL DEFAULT 'auto_approved'
    CHECK (approval_status = ANY (ARRAY['auto_approved','pending','approved','rejected'])),
  approval_comment text,
  approved_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz
);
CREATE UNIQUE INDEX uq_attendance_adjustments_employee_date_source
  ON attendance_adjustments (employee_id, work_date, source_type, source_id);
CREATE TABLE documents (id bigserial PRIMARY KEY, name text);
CREATE TABLE document_links (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  purpose text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, entity_type, entity_id, purpose)
);
CREATE TABLE audit_logs (
  id serial PRIMARY KEY, user_id uuid, action varchar(100), entity_type varchar(100), entity_id varchar(255),
  details jsonb, ip_address inet, user_agent text, created_at timestamptz DEFAULT now()
);
CREATE TABLE timesheet_approvals (
  id bigint PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz,
  start_date date NOT NULL, end_date date NOT NULL,
  version_dirty_seq integer NOT NULL DEFAULT 0, version_dirty_at timestamptz,
  version_rebuild_attempts integer NOT NULL DEFAULT 0, version_rebuild_after timestamptz, version_rebuild_last_error text
);
CREATE TABLE timesheet_approval_employees (approval_id bigint NOT NULL, employee_id integer NOT NULL);
`;

/** Снимок дня для теста: отпечаток — строки дня (id, источник, статус, часы, updated_at) и закрытые подачи. */
const fakeDeps: IZupApplyDeps = {
  loadSnapshots: async (client: PoolClient, _month: string, pairs: readonly IZupPair[]) => {
    const map = new Map<string, IZupDaySnapshot>();
    for (const pair of pairs) {
      const rows = (await client.query(
        `SELECT id, source_type, source_id, status, hours_override::text, updated_at::text
           FROM attendance_adjustments WHERE employee_id = $1 AND work_date = $2 ORDER BY id`,
        [pair.employeeId, pair.date],
      )).rows;
      const approvals = (await client.query(
        `SELECT a.id FROM timesheet_approvals a JOIN timesheet_approval_employees s ON s.approval_id = a.id
          WHERE s.employee_id = $1 AND a.status = 'approved' AND a.unlocked_at IS NULL
            AND a.start_date <= $2::date AND a.end_date >= $2::date ORDER BY a.id`,
        [pair.employeeId, pair.date],
      )).rows.map(r => Number(r.id));
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ rows, approvals })).digest('hex');
      map.set(zupPairKey(pair.employeeId, pair.date), {
        employeeId: pair.employeeId, date: pair.date, status: null, hours: null, corrected: false, overridden: false,
        dropped: false, kind: null, absence: null, paidMinutes: null, overtimeMinutes: null, normHours: 10,
        workingDay: true, objects: [], adjustments: [], closedApprovalIds: approvals, fingerprint,
      });
    }
    return map;
  },
};

const withTx = async <T>(fn: (client: PoolClient) => Promise<T>, commit = true): Promise<T> => {
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const buildPlan = async (targets: Array<{ employee_id: number; date: string; target: ZupTarget }>): Promise<IZupPlan> => {
  const snaps = await withTx(client => fakeDeps.loadSnapshots(
    client, '2026-10', targets.map(t => ({ employeeId: t.employee_id, date: t.date })),
  ), false);
  const items: IZupPlanItem[] = [];
  for (const t of targets) {
    const ids = (await pg.pool!.query(
      'SELECT id FROM attendance_adjustments WHERE employee_id = $1 AND work_date = $2 ORDER BY id', [t.employee_id, t.date],
    )).rows.map(r => Number(r.id));
    items.push({
      employee_id: t.employee_id, date: t.date, rows: [14497], target: t.target,
      expected_fingerprint: snaps.get(zupPairKey(t.employee_id, t.date))!.fingerprint, remove_adjustment_ids: ids,
    });
  }
  return parseZupPlan({
    run_id: crypto.randomUUID(), month: '2026-10', created_at: new Date().toISOString(),
    source: { file: 'ТАБЕЛЬ за октябрь от_13_11_26.xlsx', sha256: 'f'.repeat(64), sheet: 'sheet1' },
    plan_sha256: computeZupPlanSha(items), items,
  });
};

const allRows = async (): Promise<unknown[]> => (await pg.pool!.query(
  'SELECT row_to_json(a) AS r FROM attendance_adjustments a ORDER BY id',
)).rows.map(r => r.r);
const allLinks = async (): Promise<unknown[]> => (await pg.pool!.query(
  'SELECT row_to_json(l) AS r FROM document_links l ORDER BY id',
)).rows.map(r => r.r);
const dayRows = async (employeeId: number, date: string) => (await pg.pool!.query(
  'SELECT * FROM attendance_adjustments WHERE employee_id = $1 AND work_date = $2 ORDER BY id', [employeeId, date],
)).rows;

const OBJECT_TARGET: ZupTarget = { kind: 'object', hours: 7, object: { key: 'obj-alia', id: '33333333-3333-4333-8333-333333333333', name: 'ЖК Alia' } };

describeIf('timesheet-zup-align (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(SLICE_SQL);
  });
  afterAll(async () => {
    await pg.pool?.end();
  });

  beforeEach(async () => {
    await pg.pool!.query(`
      TRUNCATE audit_logs, document_links, documents, attendance_adjustments, timesheet_approval_employees,
        timesheet_approvals, employees, user_profiles RESTART IDENTITY CASCADE;
      INSERT INTO user_profiles (id, full_name) VALUES ('${ACTOR.userId}', 'Админ'), ('${AUTHOR}', 'Табельщица');
      INSERT INTO employees (id, full_name) VALUES (${EMP}, 'Кочанжи С. Д.'), (${EMP2}, 'Галкин С. С.');
      INSERT INTO timesheet_approvals (id, status, start_date, end_date) VALUES (${APPROVAL}, 'approved', '2026-10-01', '2026-10-31');
      INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES (${APPROVAL}, ${EMP});
      INSERT INTO documents (name) VALUES ('служебка.pdf'), ('заявление.pdf');
      -- 02.10: дневная правка с файлом, две объектные, строка заявления (у заявления свой файл)
      INSERT INTO attendance_adjustments (employee_id, work_date, status, hours_override, source_type, source_id, reason, created_by)
      VALUES (${EMP}, '2026-10-02', 'manual', 10, 'manual', 'manual', 'есть с/з', '${AUTHOR}'),
             (${EMP}, '2026-10-02', 'manual', 6, 'manual_object', 'obj-alia', NULL, '${AUTHOR}'),
             (${EMP}, '2026-10-02', 'manual', 4, 'manual_object', 'obj-other', NULL, '${AUTHOR}'),
             (${EMP}, '2026-10-02', 'work', NULL, 'leave_request', '77:2026-10-02', NULL, '${AUTHOR}');
      INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
      VALUES (1, 'attendance_adjustment', '1', 'timesheet_correction'), (2, 'leave_request', '77', 'attachment');
    `);
  });

  it('день нормализуется в одну ЗУП-строку: прежние сняты, вложения перенесены, подача помечена, аудит', async () => {
    const plan = await buildPlan([{ employee_id: EMP, date: '2026-10-02', target: OBJECT_TARGET }]);
    const { report, backup } = await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps));

    expect(report).toMatchObject({ written: 1, alreadyApplied: 0, removedRows: 4, approvalIds: [APPROVAL] });
    const rows = await dayRows(EMP, '2026-10-02');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_type: 'manual_object', source_id: 'obj-alia', status: 'manual', reason: 'ЗУП',
      created_by: null, updated_by: null, approved_by: null, approval_status: 'auto_approved',
    });
    expect(Number(rows[0].hours_override)).toBe(7);
    expect(rows[0].metadata).toMatchObject({
      object_id: OBJECT_TARGET.kind === 'object' ? OBJECT_TARGET.object.id : null, object_name: 'ЖК Alia',
      zup_align: { run_id: plan.run_id, actor: ACTOR.email, rows: [14497] },
    });
    const links = (await pg.pool!.query('SELECT document_id, entity_type, entity_id, purpose FROM document_links ORDER BY document_id, entity_type')).rows;
    expect(links).toEqual([
      { document_id: 1, entity_type: 'attendance_adjustment', entity_id: String(rows[0].id), purpose: 'timesheet_correction' },
      { document_id: 2, entity_type: 'attendance_adjustment', entity_id: String(rows[0].id), purpose: 'timesheet_correction' },
      { document_id: 2, entity_type: 'leave_request', entity_id: '77', purpose: 'attachment' },
    ]);
    expect(backup.days[0].removed_rows).toHaveLength(4);
    expect(backup.days[0].removed_links).toHaveLength(1);
    expect(backup.days[0].moved_links).toHaveLength(2);
    const approval = (await pg.pool!.query('SELECT version_dirty_seq, version_dirty_at FROM timesheet_approvals')).rows[0];
    expect(approval.version_dirty_seq).toBe(1);
    expect(approval.version_dirty_at).not.toBeNull();
    const audit = (await pg.pool!.query('SELECT user_id, action, details FROM audit_logs')).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ user_id: ACTOR.userId, action: 'CREATE_TIMESHEET_ENTRY', details: { source: 'zup-align', run_id: plan.run_id } });
  });

  it('дневная правка, обнуление и отметка; день без закрытой подачи подачи не трогает', async () => {
    const plan = await buildPlan([
      { employee_id: EMP2, date: '2026-10-01', target: { kind: 'day', hours: 10 } },
      { employee_id: EMP2, date: '2026-10-03', target: { kind: 'zero' } },
      { employee_id: EMP2, date: '2026-10-05', target: { kind: 'status', status: 'unpaid' } },
    ]);
    const { report } = await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps));
    expect(report).toMatchObject({ written: 3, removedRows: 0, approvalIds: [], byKind: { day: 1, zero: 1, status: 1 } });
    const [day] = await dayRows(EMP2, '2026-10-01');
    const [zero] = await dayRows(EMP2, '2026-10-03');
    const [status] = await dayRows(EMP2, '2026-10-05');
    expect([day.source_type, day.status, Number(day.hours_override)]).toEqual(['manual', 'manual', 10]);
    expect([zero.source_type, zero.status, Number(zero.hours_override)]).toEqual(['manual', 'manual', 0]);
    expect([status.source_type, status.status, status.hours_override]).toEqual(['manual', 'unpaid', null]);
    for (const row of [day, zero, status]) expect(row).toMatchObject({ reason: 'ЗУП', created_by: null, approval_status: 'auto_approved' });
    expect((await pg.pool!.query('SELECT version_dirty_seq FROM timesheet_approvals')).rows[0].version_dirty_seq).toBe(0);
  });

  it('день изменился после сверки — откат всего прогона, ни одной записи', async () => {
    const plan = await buildPlan([
      { employee_id: EMP2, date: '2026-10-01', target: { kind: 'day', hours: 10 } },
      { employee_id: EMP, date: '2026-10-02', target: OBJECT_TARGET },
    ]);
    await pg.pool!.query(`UPDATE attendance_adjustments SET hours_override = 9, updated_at = now() + interval '1 second'
                           WHERE source_type = 'manual' AND employee_id = ${EMP}`);
    const before = await allRows();
    const error = await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps)).catch(e => e);
    expect(error).toBeInstanceOf(ZupPlanStaleError);
    expect((error as ZupPlanStaleError).days).toEqual([{ employee_id: EMP, date: '2026-10-02', reason: 'день в ФОТ изменился после сверки' }]);
    expect(await allRows()).toEqual(before);
    expect((await pg.pool!.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n).toBe(0);
  });

  it('повтор после записи — ноль изменений', async () => {
    const plan = await buildPlan([
      { employee_id: EMP, date: '2026-10-02', target: OBJECT_TARGET },
      { employee_id: EMP2, date: '2026-10-05', target: { kind: 'status', status: 'remote' } },
    ]);
    await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps));
    const after = await allRows();
    const { report } = await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps));
    expect(report).toMatchObject({ written: 0, alreadyApplied: 2, approvalIds: [] });
    expect(await allRows()).toEqual(after);
  });

  it('откат возвращает строки и вложения один в один; правленую человеком ЗУП-строку не откатывает', async () => {
    const rowsBefore = await allRows();
    const linksBefore = await allLinks();
    const plan = await buildPlan([
      { employee_id: EMP, date: '2026-10-02', target: OBJECT_TARGET },
      { employee_id: EMP2, date: '2026-10-01', target: { kind: 'day', hours: 10 } },
    ]);
    const { backup } = await withTx(client => applyZupPlan(client, plan, ACTOR, fakeDeps));
    const restored = JSON.parse(JSON.stringify(backup));

    // Человек поправил ЗУП-строку — откат отказывает целиком.
    await pg.pool!.query(`UPDATE attendance_adjustments SET hours_override = 8, updated_at = now() + interval '1 second'
                           WHERE employee_id = ${EMP2} AND work_date = '2026-10-01'`);
    const conflict = await withTx(client => revertZupBackup(client, restored, ACTOR)).catch(e => e);
    expect(conflict).toBeInstanceOf(ZupRevertConflictError);
    await pg.pool!.query(`UPDATE attendance_adjustments SET hours_override = 10, updated_at = $1
                           WHERE employee_id = ${EMP2} AND work_date = '2026-10-01'`,
    [restored.days.find((d: { employee_id: number }) => d.employee_id === EMP2).zup_row.updated_at]);

    const report = await withTx(client => revertZupBackup(client, restored, ACTOR));
    expect(report).toMatchObject({ days: 2, restoredRows: 4, restoredLinks: 1, removedMovedLinks: 2, approvalIds: [APPROVAL] });
    expect(await allRows()).toEqual(rowsBefore);
    expect(await allLinks()).toEqual(linksBefore);
    const audit = (await pg.pool!.query(`SELECT count(*)::int AS n FROM audit_logs WHERE details->>'source' = 'zup-align-revert'`)).rows[0];
    expect(audit.n).toBe(2);
  });

  it('удалёнка с часами 1С заменяет ЗУП-удалёнку без часов; повтор её не трогает', async () => {
    const first = await buildPlan([{ employee_id: EMP2, date: '2026-10-04', target: { kind: 'status', status: 'remote' } }]);
    await withTx(client => applyZupPlan(client, first, ACTOR, fakeDeps));
    const [old] = await dayRows(EMP2, '2026-10-04');
    expect([old.status, old.hours_override]).toEqual(['remote', null]);

    const second = await buildPlan([{ employee_id: EMP2, date: '2026-10-04', target: { kind: 'status', status: 'remote', hours: 8 } }]);
    const { report, backup } = await withTx(client => applyZupPlan(client, second, ACTOR, fakeDeps));
    expect(report).toMatchObject({ written: 1, removedRows: 1 });
    expect(backup.days[0].removed_rows.map(row => Number(row.id))).toEqual([Number(old.id)]);
    const rows = await dayRows(EMP2, '2026-10-04');
    expect(rows).toHaveLength(1);
    expect([rows[0].status, Number(rows[0].hours_override), rows[0].reason]).toEqual(['remote', 8, 'ЗУП']);
    expect(rows[0].metadata).toMatchObject({ zup_align: { run_id: second.run_id } });

    const again = await withTx(client => applyZupPlan(client, second, ACTOR, fakeDeps));
    expect(again.report).toMatchObject({ written: 0, alreadyApplied: 1 });
  });

  it('часы бывают только у удалёнки', async () => {
    const plan = await buildPlan([{ employee_id: EMP2, date: '2026-10-01', target: { kind: 'day', hours: 10 } }]);
    const bad = JSON.parse(JSON.stringify(plan));
    bad.items[0].target = { kind: 'status', status: 'unpaid', hours: 8 };
    bad.plan_sha256 = computeZupPlanSha(bad.items);
    expect(() => parseZupPlan(bad)).toThrow(/часы бывают только у удалёнки/);
  });

  it('план с подменённым составом не принимается', async () => {
    const plan = await buildPlan([{ employee_id: EMP2, date: '2026-10-01', target: { kind: 'day', hours: 10 } }]);
    const tampered = JSON.parse(JSON.stringify(plan));
    tampered.items[0].target.hours = 11;
    expect(() => parseZupPlan(tampered)).toThrow(/хэш состава/);
  });
});
