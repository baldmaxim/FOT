import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Отпуск корректировкой табеля (миграция 311) на настоящем PostgreSQL: видимые карточки
// (рабочие, заявления, граница cutoff), сверщик уведомлений (первый прогон, новый отпуск,
// смена типа, файлы, снятие после ознакомления, отмена заявления), «Ознакомлен» и «Отказать»
// (версия, закрытый период, двойной отказ, адресаты), доступ к файлам, CASCADE.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
const closed = vi.hoisted(() => ({ dates: new Set<string>() }));

vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: date — строкой, date[] — массивом строк, bigint — числом.
  types.setTypeParser(1082, (value: string) => value);
  types.setTypeParser(1182 as Parameters<typeof types.setTypeParser>[0], types.getTypeParser(1009));
  types.setTypeParser(20, (value: string) => Number(value));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

const HR_ROLE = '00000000-0000-0000-0000-0000000000a1';
const WORKER_ROLE = '00000000-0000-0000-0000-0000000000a2';
const MANAGER_ROLE = '00000000-0000-0000-0000-0000000000a3';
const OFFICE_ROLE = '00000000-0000-0000-0000-0000000000a4';

vi.mock('./access-control.service.js', () => ({
  getRolePageAccess: vi.fn(async (roleId: string) => (
    roleId === '00000000-0000-0000-0000-0000000000a1' ? { '/leave-vacations': { can_view: true, can_edit: true } } : {}
  )),
}));
vi.mock('./timesheet-version.service.js', () => ({
  loadClosedTimesheetLocks: vi.fn(async (pairs: Array<{ employeeId: number; workDate: string }>) => new Map(
    pairs.filter(p => closed.dates.has(p.workDate))
      .map(p => [`${p.employeeId}|${p.workDate}`, { id: 1, status: 'approved', start_date: '2026-09-16', end_date: '2026-09-30' }]),
  )),
}));
vi.mock('./push.service.js', () => ({ pushService: { sendGenericNotification: vi.fn(async () => []) } }));
vi.mock('./realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));

import type { PoolClient } from 'pg';
import { findVisibleCorrectionDocument } from './correction-leave.service.js';
import { listHrCorrectionItems, type IHrCorrectionLeaveItem } from './correction-leave-list.service.js';
import {
  CorrectionLeaveClosedPeriodError,
  CorrectionLeaveConflictError,
  acknowledgeCorrectionLeave,
  acknowledgeRemovedCorrectionLeave,
  rejectCorrectionLeaveInTx,
} from './correction-leave-decisions.service.js';
import { runCorrectionLeaveReconcileOnce } from './correction-leave-reconcile.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const MIGRATION = readFileSync(`${MIGRATIONS_DIR}311_timesheet_correction_leaves.sql`, 'utf8');

const EMP = 562;          // Дульянинов, есть учётка
const NO_ACCOUNT = 700;   // Холчев, учётки нет
const WORKER = 800;       // рабочий
const HR1 = '00000000-0000-0000-0000-000000000101';
const HR2 = '00000000-0000-0000-0000-000000000102';
const AUTHOR = '00000000-0000-0000-0000-000000000201';
const EMP_USER = '00000000-0000-0000-0000-000000000301';
const WORKER_USER = '00000000-0000-0000-0000-000000000302';

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const inTx = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pg.pool!.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const isoDays = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

const addDays = async (
  employeeId: number, from: string, to: string,
  opts: { status?: string; reason?: string; author?: string } = {},
): Promise<number[]> => {
  const rows = await q<{ id: number }>(
    `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id, reason, created_by)
     SELECT $1, d::date, $2, 'manual', 'manual', $3, $4::uuid FROM unnest($5::text[]) AS d
     RETURNING id`,
    [employeeId, opts.status ?? 'vacation', opts.reason ?? 'отпуск', opts.author ?? AUTHOR, isoDays(from, to)],
  );
  return rows.map(r => Number(r.id));
};

const reconcile = () => runCorrectionLeaveReconcileOnce();
const list = () => listHrCorrectionItems(pg.pool!);
const cardsOf = async (employeeId: number) =>
  (await list()).filter((i): i is IHrCorrectionLeaveItem => i.kind === 'correction' && i.employee_id === employeeId);
const notes = (userId: string) => q<{ title: string; body: string; metadata: Record<string, unknown> }>(
  'SELECT title, body, metadata FROM notifications WHERE user_id = $1 ORDER BY created_at, title', [userId],
);
const ack = (card: IHrCorrectionLeaveItem, userId = HR1) => inTx(client => acknowledgeCorrectionLeave(client, {
  adjustmentIds: card.adjustment_ids, version: card.version, userId,
}));
const reject = (card: IHrCorrectionLeaveItem, reapproved: string[] = []) => inTx(client => rejectCorrectionLeaveInTx(client, {
  adjustmentIds: card.adjustment_ids, version: card.version, reason: 'нужно заявление сотрудника', userId: HR1,
}, { reapproveTail: async (_employeeId, workDate) => { reapproved.push(workDate); return []; } }));

describe.skipIf(!PG_URL)('отпуск корректировкой (миграция 311) — PostgreSQL', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS timesheet_correction_leave_days, timesheet_correction_leave_rejections,
        timesheet_correction_leave_reconcile, notifications, document_links, documents, leave_requests,
        attendance_adjustments, user_profiles, system_roles, positions, org_departments, employees CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text, org_department_id uuid, position_id uuid);
      CREATE TABLE system_roles (id uuid PRIMARY KEY, code text);
      CREATE TABLE user_profiles (
        id uuid PRIMARY KEY, employee_id integer, system_role_id uuid,
        is_approved boolean NOT NULL DEFAULT true, full_name text
      );
      CREATE TABLE attendance_adjustments (
        id bigserial PRIMARY KEY,
        employee_id integer NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        work_date date NOT NULL, status text NOT NULL, hours_override numeric,
        source_type text NOT NULL, source_id text NOT NULL, reason text,
        created_by uuid REFERENCES user_profiles(id),
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (employee_id, work_date, source_type, source_id)
      );
      CREATE TABLE leave_requests (
        id bigserial PRIMARY KEY, employee_id integer, request_type text, status text,
        start_date date, end_date date, selected_dates date[]
      );
      CREATE TABLE documents (
        id bigserial PRIMARY KEY, employee_id integer, file_name text, mime_type text,
        file_size integer, r2_key text, deleted_at timestamptz
      );
      CREATE TABLE document_links (
        id bigserial PRIMARY KEY, document_id bigint REFERENCES documents(id) ON DELETE CASCADE,
        entity_type text, entity_id text, purpose text
      );
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, title text, body text,
        metadata jsonb NOT NULL DEFAULT '{}', is_read boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
    `);
    // Миграция идемпотентна: второй прогон не падает.
    await q(MIGRATION);
    await q(MIGRATION);
  });

  beforeEach(async () => {
    closed.dates.clear();
    await q(`TRUNCATE timesheet_correction_leave_days, timesheet_correction_leave_rejections, notifications,
      document_links, documents, leave_requests, attendance_adjustments, user_profiles, system_roles,
      employees RESTART IDENTITY CASCADE`);
    await q('UPDATE timesheet_correction_leave_reconcile SET seeded_at = now()');
    await q(
      `INSERT INTO system_roles (id, code) VALUES ($1, 'hr'), ($2, 'worker'), ($3, 'manager'), ($4, 'office')`,
      [HR_ROLE, WORKER_ROLE, MANAGER_ROLE, OFFICE_ROLE],
    );
    await q(
      `INSERT INTO employees (id, full_name) VALUES
         ($1, 'Дульянинов Владислав Игоревич'), ($2, 'Холчев Николай Константинович'), ($3, 'Рабочий Иван Иванович')`,
      [EMP, NO_ACCOUNT, WORKER],
    );
    await q(
      `INSERT INTO user_profiles (id, employee_id, system_role_id, full_name) VALUES
         ($1, NULL, $6, 'Андрусевич Алина Романовна'),
         ($2, NULL, $6, 'Вторая Кадровик Ивановна'),
         ($3, NULL, $7, 'Тихонович Юрий Викторович'),
         ($4, $9, $8, 'Дульянинов Владислав Игоревич'),
         ($5, $10, $11, 'Рабочий Иван Иванович')`,
      [HR1, HR2, AUTHOR, EMP_USER, WORKER_USER, HR_ROLE, MANAGER_ROLE, OFFICE_ROLE, EMP, WORKER, WORKER_ROLE],
    );
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('первый прогон засевает существующие отпуска без уведомлений, следующий — сообщает о новом', async () => {
    await q('UPDATE timesheet_correction_leave_reconcile SET seeded_at = NULL');
    await addDays(EMP, '2026-10-15', '2026-10-17');
    const first = await reconcile();
    expect(first?.seeded).toBe(true);
    expect(await notes(HR1)).toEqual([]);
    expect((await q('SELECT 1 FROM timesheet_correction_leave_days WHERE notified_at IS NOT NULL')).length).toBe(3);

    await addDays(EMP, '2026-10-20', '2026-10-20');
    const second = await reconcile();
    expect(second?.seeded).toBe(false);
    expect((await notes(HR1)).map(n => n.body)).toEqual([
      'Отпуск: Дульянинов В.И., 20.10.2026. Автор корректировки: Тихонович Ю.В.',
    ]);
  });

  it('новый отпуск: одно уведомление каждому кадровику со ссылкой на вкладку; повторный прогон тихий', async () => {
    await addDays(EMP, '2026-10-15', '2026-10-28');
    await reconcile();
    for (const hr of [HR1, HR2]) {
      const list1 = await notes(hr);
      expect(list1).toHaveLength(1);
      expect(list1[0]!.body).toBe('Отпуск: Дульянинов В.И., 15.10–28.10.2026. Автор корректировки: Тихонович Ю.В.');
      expect(list1[0]!.metadata.path).toBe('/leave-requests?tab=vacations');
    }
    expect(await notes(AUTHOR)).toEqual([]);
    await reconcile();
    expect(await notes(HR1)).toHaveLength(1);
  });

  it('кадровик, поставивший отпуск сам, колокольчик не получает', async () => {
    await addDays(NO_ACCOUNT, '2026-10-01', '2026-10-02', { author: HR1 });
    await reconcile();
    expect(await notes(HR1)).toEqual([]);
    expect(await notes(HR2)).toHaveLength(1);
  });

  it('серия через границу cutoff видна целиком; серия целиком до cutoff — нет', async () => {
    await addDays(EMP, '2026-09-28', '2026-10-05');
    await addDays(NO_ACCOUNT, '2026-09-10', '2026-09-12');
    const cards = await list();
    expect(cards.map(c => [c.employee_id, c.days[0], c.days.length])).toEqual([[EMP, '2026-09-28', 8]]);
  });

  it('рабочий и дни под заявлением не видны; отмена pending-заявления — день появляется с уведомлением', async () => {
    await addDays(WORKER, '2026-10-15', '2026-10-16');
    await addDays(EMP, '2026-10-15', '2026-10-16');
    const [lr] = await q<{ id: number }>(
      `INSERT INTO leave_requests (employee_id, request_type, status, start_date, end_date)
       VALUES ($1, 'vacation', 'pending', '2026-10-15', '2026-10-16') RETURNING id`,
      [EMP],
    );
    await reconcile();
    expect(await list()).toEqual([]);
    expect(await notes(HR1)).toEqual([]);

    await q(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1`, [lr!.id]);
    await reconcile();
    expect((await cardsOf(EMP)).map(c => c.days)).toEqual([['2026-10-15', '2026-10-16']]);
    expect(await notes(HR1)).toHaveLength(1);
  });

  it('пересохранение того же отпуска не сбрасывает «Ознакомлен»; смена типа — сбрасывает и сообщает', async () => {
    const ids = await addDays(EMP, '2026-10-15', '2026-10-17');
    await reconcile();
    await ack((await cardsOf(EMP))[0]!);
    expect((await cardsOf(EMP))[0]!.hr_acknowledged_at).not.toBeNull();

    // Пересохранение: upsert ставит новый updated_at, содержание то же.
    await q(`UPDATE attendance_adjustments SET updated_at = now() + interval '1 minute', reason = 'отпуск' WHERE employee_id = $1`, [EMP]);
    await reconcile();
    expect((await cardsOf(EMP))[0]!.hr_acknowledged_at).not.toBeNull();
    expect(await notes(HR1)).toHaveLength(1);

    await q(`UPDATE attendance_adjustments SET status = 'unpaid' WHERE id = $1`, [ids[2]]);
    await reconcile();
    const unpaid = (await list()).find(i => i.kind === 'correction' && i.leave_status === 'unpaid');
    expect(unpaid?.hr_acknowledged_at).toBeNull();
    const titles = (await notes(HR1)).map(n => n.title);
    expect(titles).toContain('Изменён тип отпуска в табеле');
  });

  it('файл после ознакомления: карточка снова «Не ознакомлен» сразу, кадрам — уведомление', async () => {
    const ids = await addDays(EMP, '2026-10-15', '2026-10-16');
    await reconcile();
    await ack((await cardsOf(EMP))[0]!);
    const [doc] = await q<{ id: number }>(
      `INSERT INTO documents (employee_id, file_name, r2_key) VALUES ($1, 'отпуск.jpg', 'k1') RETURNING id`, [EMP],
    );
    await q(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
       VALUES ($1, 'attendance_adjustment', $2, 'timesheet_correction')`,
      [doc!.id, String(ids[0])],
    );
    // До тика: сравнение версии при чтении.
    expect((await cardsOf(EMP))[0]!.hr_acknowledged_at).toBeNull();
    await reconcile();
    expect((await notes(HR1)).map(n => n.title)).toContain('Изменены файлы отпуска');
    await reconcile();
    expect((await notes(HR1)).filter(n => n.title === 'Изменены файлы отпуска')).toHaveLength(1);
  });

  it('снятие ознакомленного дня → «Снят после ознакомления» + уведомление; неознакомленный — тихо', async () => {
    const ids = await addDays(EMP, '2026-10-15', '2026-10-28');
    await reconcile();
    await ack((await cardsOf(EMP))[0]!);

    await q('DELETE FROM attendance_adjustments WHERE id = $1', [ids[0]]);
    await q(`UPDATE attendance_adjustments SET status = 'work' WHERE id = $1`, [ids[1]]);
    await reconcile();

    const removed = (await list()).filter(i => i.kind === 'removed');
    expect(removed.map(i => i.kind === 'removed' && [i.days, i.removed_kind, i.hr_acknowledged_at])).toEqual([
      [['2026-10-15', '2026-10-16'], 'mixed', null],
    ]);
    expect((await cardsOf(EMP)).map(c => [c.days[0], c.days.length, !!c.hr_acknowledged_at])).toEqual([['2026-10-17', 12, true]]);
    const bodies = (await notes(HR1)).filter(n => n.title === 'Снят ознакомленный отпуск').map(n => n.body).sort();
    expect(bodies).toEqual([
      'Отпуск: Дульянинов В.И., 15.10.2026 — удалён из табеля.',
      'Отпуск: Дульянинов В.И., 16.10.2026 — в табеле стоит другой статус.',
    ]);

    const removedItem = removed[0]!;
    await inTx(client => acknowledgeRemovedCorrectionLeave(client, {
      adjustmentIds: removedItem.kind === 'removed' ? removedItem.adjustment_ids : [], userId: HR2,
    }));
    const seen = (await list()).find(i => i.kind === 'removed');
    expect(seen?.hr_acknowledged_at).not.toBeNull();
    expect(seen?.hr_acknowledged_by_name).toBe('Вторая Кадровик Ивановна');

    // Неознакомленный отпуск сняли — кадрам сообщать нечего.
    const other = await addDays(NO_ACCOUNT, '2026-10-20', '2026-10-21');
    await reconcile();
    const before = (await notes(HR1)).length;
    await q('DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])', [other]);
    await reconcile();
    expect((await notes(HR1)).length).toBe(before);
  });

  it('отказ: дни удалены, отказ в истории, уведомления сотруднику и автору; повторный — 409', async () => {
    await addDays(EMP, '2026-09-29', '2026-10-02');
    await reconcile();
    const card = (await cardsOf(EMP))[0]!;
    const reapproved: string[] = [];
    const result = await reject(card, reapproved);

    expect(reapproved).toEqual(['2026-09-29', '2026-10-01']);
    expect(await q('SELECT 1 FROM attendance_adjustments WHERE employee_id = $1', [EMP])).toEqual([]);
    const [rejection] = await q<{ days: string[]; start_date: string; end_date: string; reject_reason: string }>(
      'SELECT days, start_date, end_date, reject_reason FROM timesheet_correction_leave_rejections',
    );
    expect(rejection).toEqual({
      days: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
      start_date: '2026-09-29',
      end_date: '2026-10-02',
      reject_reason: 'нужно заявление сотрудника',
    });
    expect((await notes(EMP_USER)).map(n => [n.title, n.metadata.path])).toEqual([
      ['Отпуск не принят отделом кадров', '/employee/requests'],
    ]);
    expect((await notes(AUTHOR)).map(n => n.metadata.path)).toEqual(['/timesheet']);
    expect(result.employeeUserId).toBe(EMP_USER);
    expect((await list()).map(i => i.kind)).toEqual(['rejected']);

    await expect(reject(card)).rejects.toBeInstanceOf(CorrectionLeaveConflictError);
    // Отказ неознакомленного отпуска — не «снятие после ознакомления».
    await reconcile();
    expect((await notes(HR1)).filter(n => n.title === 'Снят ознакомленный отпуск')).toEqual([]);
  });

  it('отказ сотруднику без учётки — уведомление только автору', async () => {
    await addDays(NO_ACCOUNT, '2026-10-15', '2026-10-16');
    const card = (await cardsOf(NO_ACCOUNT))[0]!;
    await reject(card);
    expect((await notes(AUTHOR)).map(n => n.title)).toEqual(['Отпуск не принят отделом кадров']);
    expect(await q('SELECT 1 FROM notifications WHERE user_id <> $1', [AUTHOR])).toEqual([]);
  });

  it('отказ при закрытом сентябре — 409, ни одна строка не удалена', async () => {
    await addDays(EMP, '2026-09-28', '2026-10-05');
    const card = (await cardsOf(EMP))[0]!;
    closed.dates.add('2026-09-29');
    await expect(reject(card)).rejects.toBeInstanceOf(CorrectionLeaveClosedPeriodError);
    expect(await q('SELECT 1 FROM attendance_adjustments WHERE employee_id = $1', [EMP])).toHaveLength(8);
    expect(await q('SELECT 1 FROM timesheet_correction_leave_rejections')).toEqual([]);
  });

  it('устаревшая версия: день добавили или приложили файл после показа — «Ознакомлен» и отказ дают 409', async () => {
    const ids = await addDays(EMP, '2026-10-15', '2026-10-17');
    const stale = (await cardsOf(EMP))[0]!;
    await addDays(EMP, '2026-10-18', '2026-10-18');
    await expect(ack(stale)).rejects.toBeInstanceOf(CorrectionLeaveConflictError);
    await expect(reject(stale)).rejects.toBeInstanceOf(CorrectionLeaveConflictError);

    const fresh = (await cardsOf(EMP))[0]!;
    const [doc] = await q<{ id: number }>(`INSERT INTO documents (file_name, r2_key) VALUES ('a.pdf', 'k') RETURNING id`);
    await q(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
       VALUES ($1, 'attendance_adjustment', $2, 'timesheet_correction')`,
      [doc!.id, String(ids[1])],
    );
    await expect(ack(fresh)).rejects.toBeInstanceOf(CorrectionLeaveConflictError);
    expect(await q('SELECT 1 FROM attendance_adjustments WHERE employee_id = $1', [EMP])).toHaveLength(4);
  });

  it('параллельные отказы по одной карточке: проходит ровно один', async () => {
    await addDays(EMP, '2026-10-15', '2026-10-20');
    const card = (await cardsOf(EMP))[0]!;
    const results = await Promise.allSettled([reject(card), reject(card)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(CorrectionLeaveConflictError);
    expect(await q('SELECT 1 FROM timesheet_correction_leave_rejections')).toHaveLength(1);
  });

  it('ознакомленной карточке отказать нельзя', async () => {
    await addDays(EMP, '2026-10-15', '2026-10-16');
    await ack((await cardsOf(EMP))[0]!);
    await expect(reject((await cardsOf(EMP))[0]!)).rejects.toThrow('отказать нельзя');
  });

  it('файл отдаётся только для дня видимой карточки', async () => {
    const [empDay] = await addDays(EMP, '2026-10-15', '2026-10-15');
    const [workerDay] = await addDays(WORKER, '2026-10-15', '2026-10-15');
    const docs = await q<{ id: number }>(
      `INSERT INTO documents (file_name, r2_key) VALUES ('видно.jpg', 'k1'), ('рабочий.jpg', 'k2'), ('чужой.jpg', 'k3')
       RETURNING id`,
    );
    await q(
      `INSERT INTO document_links (document_id, entity_type, entity_id, purpose) VALUES
         ($1, 'attendance_adjustment', $4, 'timesheet_correction'),
         ($2, 'attendance_adjustment', $5, 'timesheet_correction'),
         ($3, 'leave_request', '1', 'leave_request')`,
      [docs[0]!.id, docs[1]!.id, docs[2]!.id, String(empDay), String(workerDay)],
    );
    expect(await findVisibleCorrectionDocument(pg.pool!, docs[0]!.id)).toEqual({ r2_key: 'k1', file_name: 'видно.jpg' });
    expect(await findVisibleCorrectionDocument(pg.pool!, docs[1]!.id)).toBeNull();
    expect(await findVisibleCorrectionDocument(pg.pool!, docs[2]!.id)).toBeNull();
  });

  it('CASCADE: удаление сотрудника чистит состояние и отказы; удаление кадровика — SET NULL', async () => {
    await addDays(EMP, '2026-10-15', '2026-10-16');
    await addDays(NO_ACCOUNT, '2026-10-15', '2026-10-16');
    await reconcile();
    await ack((await cardsOf(EMP))[0]!, HR2);
    await reject((await cardsOf(NO_ACCOUNT))[0]!);

    await q('DELETE FROM user_profiles WHERE id = $1', [HR2]);
    expect(await q('SELECT DISTINCT acked_by FROM timesheet_correction_leave_days WHERE employee_id = $1', [EMP]))
      .toEqual([{ acked_by: null }]);
    await q('DELETE FROM employees WHERE id = ANY($1::int[])', [[EMP, NO_ACCOUNT]]);
    expect(await q('SELECT 1 FROM timesheet_correction_leave_days')).toEqual([]);
    expect(await q('SELECT 1 FROM timesheet_correction_leave_rejections')).toEqual([]);
  });
});
