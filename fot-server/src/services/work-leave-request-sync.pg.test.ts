import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';

/**
 * Синхронизация заявки «Работа в выходной» с решением по её дням — на НАСТОЯЩЕМ PostgreSQL.
 *
 * Мок не докажет главного: решение по дню и статус заявки пишутся одной транзакцией, и
 * сбой синхронизации откатывает само решение (иначе день согласован, а заявка висит pending
 * и возвращается в «Заявления»).
 *
 * Запуск: FOT_TEST_PG_URL=postgres://... npx vitest run src/services/work-leave-request-sync.pg.test.ts
 * Без переменной набор скипается. БД — пустая тестовая: срез таблиц пересоздаётся.
 */
const PG_URL = process.env.FOT_TEST_PG_URL;
const describeIf = PG_URL ? describe : describe.skip;

// Realtime в этом наборе не проверяется — только SQL и транзакция.
vi.mock('./recipients.service.js', () => ({ getLeaveRequestRecipients: vi.fn(async () => []) }));
vi.mock('./realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));

import { syncWorkLeaveRequestsForAdjustmentIds } from './work-leave-request-sync.service.js';

const REVIEWER = '22222222-2222-2222-2222-222222222222';
const STAGE1_REVIEWER = '33333333-3333-3333-3333-333333333333';

const SLICE_SQL = `
DROP TABLE IF EXISTS attendance_adjustments, leave_requests CASCADE;
CREATE TABLE leave_requests (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL,
  request_type text NOT NULL,
  status text NOT NULL,
  reviewer_id uuid,
  reviewed_at timestamptz,
  review_comment text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE attendance_adjustments (
  id bigserial PRIMARY KEY,
  employee_id integer NOT NULL,
  work_date date NOT NULL,
  status text NOT NULL,
  source_type text,
  source_id text,
  approval_status text NOT NULL DEFAULT 'auto_approved',
  approved_by uuid,
  approved_at timestamptz,
  approval_comment text
);
`;

describeIf('work-leave-request-sync (реальный PG)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL, max: 4 });
    await pool.query(SLICE_SQL);
  });

  afterAll(async () => {
    await pool?.query('DROP TABLE IF EXISTS attendance_adjustments, leave_requests CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE attendance_adjustments, leave_requests RESTART IDENTITY');
  });

  /** Заявка + её дни. Возвращает id заявки и id строк дней по порядку. */
  const seed = async (opts: {
    requestType?: string;
    status?: string;
    reviewerId?: string | null;
    days: Array<{ date: string; approval: string }>;
  }): Promise<{ requestId: number; dayIds: number[] }> => {
    const lr = await pool.query<{ id: string }>(
      `INSERT INTO leave_requests (employee_id, request_type, status, reviewer_id)
       VALUES (247, $1, $2, $3) RETURNING id`,
      [opts.requestType ?? 'work', opts.status ?? 'pending', opts.reviewerId ?? null],
    );
    const requestId = Number(lr.rows[0].id);
    const dayIds: number[] = [];
    for (const day of opts.days) {
      const aa = await pool.query<{ id: string }>(
        `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id, approval_status)
         VALUES (247, $1, 'work', 'leave_request', $2, $3) RETURNING id`,
        [day.date, String(requestId), day.approval],
      );
      dayIds.push(Number(aa.rows[0].id));
    }
    return { requestId, dayIds };
  };

  /** Решение по дню + синхронизация одной транзакцией — как в correction-approval. */
  const decide = async (
    dayId: number,
    nextApproval: 'approved' | 'rejected' | 'pending',
    reviewer: string,
    comment: string | null = null,
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE attendance_adjustments
            SET approval_status = $1,
                approved_by = CASE WHEN $1 = 'pending' THEN NULL ELSE $2::uuid END
          WHERE id = $3`,
        [nextApproval, REVIEWER, dayId],
      );
      const synced = await syncWorkLeaveRequestsForAdjustmentIds(client, [dayId], reviewer, comment);
      await client.query('COMMIT');
      return synced;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const request = async (id: number) => (await pool.query<{
    status: string; reviewer_id: string | null; reviewed_at: Date | null; review_comment: string | null;
  }>('SELECT status, reviewer_id, reviewed_at, review_comment FROM leave_requests WHERE id = $1', [id])).rows[0];
  const dayApproval = async (id: number) => (await pool.query<{ approval_status: string }>(
    'SELECT approval_status FROM attendance_adjustments WHERE id = $1', [id],
  )).rows[0].approval_status;

  it('согласование дня закрывает заявку: approved, согласующий и время решения', async () => {
    const { requestId, dayIds } = await seed({ days: [{ date: '2026-09-05', approval: 'pending' }] });

    const synced = await decide(dayIds[0], 'approved', REVIEWER);

    // bigint без парсера config/postgres приходит строкой — сравниваем по числу.
    expect(synced.map(r => ({ ...r, id: Number(r.id) })))
      .toEqual([{ id: requestId, employee_id: 247, status: 'approved' }]);
    const row = await request(requestId);
    expect(row.status).toBe('approved');
    expect(row.reviewer_id).toBe(REVIEWER);
    expect(row.reviewed_at).not.toBeNull();
  });

  it('отказ по дню отклоняет заявку с комментарием', async () => {
    const { requestId, dayIds } = await seed({ days: [{ date: '2026-09-05', approval: 'pending' }] });

    await decide(dayIds[0], 'rejected', REVIEWER, 'нет основания');

    const row = await request(requestId);
    expect(row.status).toBe('rejected');
    expect(row.review_comment).toBe('нет основания');
  });

  it('откат дня возвращает заявку в pending и снимает согласующего', async () => {
    const { requestId, dayIds } = await seed({
      status: 'approved',
      reviewerId: STAGE1_REVIEWER,
      days: [{ date: '2026-09-05', approval: 'approved' }],
    });

    await decide(dayIds[0], 'pending', REVIEWER);

    const row = await request(requestId);
    expect(row.status).toBe('pending');
    expect(row.reviewer_id).toBeNull();
    expect(row.reviewed_at).toBeNull();
  });

  it('пока хоть один день ждёт решения, заявка остаётся pending', async () => {
    const { requestId, dayIds } = await seed({
      days: [{ date: '2026-09-05', approval: 'pending' }, { date: '2026-09-12', approval: 'pending' }],
    });

    const synced = await decide(dayIds[0], 'approved', REVIEWER);

    expect(synced).toEqual([]);
    expect((await request(requestId)).status).toBe('pending');
  });

  it('сбой синхронизации откатывает и решение по дню: ничего не записано наполовину', async () => {
    const { requestId, dayIds } = await seed({ days: [{ date: '2026-09-05', approval: 'pending' }] });

    // Невалидный UUID согласующего роняет UPDATE leave_requests ($2::uuid).
    await expect(decide(dayIds[0], 'approved', 'not-a-uuid')).rejects.toThrow();

    expect(await dayApproval(dayIds[0])).toBe('pending');
    const row = await request(requestId);
    expect(row.status).toBe('pending');
    expect(row.reviewer_id).toBeNull();
  });

  it('заявки других типов (удалёнка) синхронизация не трогает', async () => {
    const { requestId, dayIds } = await seed({
      requestType: 'remote',
      status: 'approved',
      days: [{ date: '2026-09-05', approval: 'pending' }],
    });

    const synced = await decide(dayIds[0], 'rejected', REVIEWER, 'нет');

    expect(synced).toEqual([]);
    expect((await request(requestId)).status).toBe('approved');
  });
});
