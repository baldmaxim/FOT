import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { AuthenticatedRequest } from '../types/index.js';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
}));

import { runWithScheduleAudit, type IScheduleAuditRow } from './schedule-audit.helpers.js';

const OFFICE = 'ОФИС пятидневка + рос.праздники + пт 7 час';
const WARRANTY = 'Гарантийный отдел график 5дн+2 суб с 01.04.22г';

const row = (
  id: string,
  scheduleName: string,
  from: string,
  to: string | null,
  anchor: string | null = null,
): IScheduleAuditRow => ({
  id,
  schedule_id: `sched-${scheduleName.slice(0, 4)}`,
  schedule_name: scheduleName,
  effective_from: from,
  effective_to: to,
  anchor_date: anchor,
});

/** Клиент транзакции: снимки назначений по очереди, ФИО и график по умолчанию, запись аудита. */
const makeClient = (snapshots: IScheduleAuditRow[][]) => {
  const auditInserts: unknown[][] = [];
  const queue = [...snapshots];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const lower = sql.toLowerCase();
      if (lower.includes('from employee_schedule_assignments')) {
        return { rows: queue.shift() ?? [], rowCount: 0 };
      }
      if (lower.includes('from employees where id')) {
        return { rows: [{ full_name: 'Гнатовский Виктор Викторович', default_name: OFFICE }], rowCount: 1 };
      }
      if (lower.trimStart().startsWith('insert into audit_logs')) {
        auditInserts.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  return { client: client as unknown as PoolClient, auditInserts, query: client.query };
};

const req = {
  ip: '10.0.0.1',
  socket: {},
  headers: { 'user-agent': 'vitest' },
  user: { id: 'user-1' },
} as unknown as AuthenticatedRequest;

const detailsOf = (insert: unknown[]): Record<string, unknown> => JSON.parse(String(insert[4]));

describe('runWithScheduleAudit', () => {
  it('назначение «по умолчанию → Гарантийный» с 01.10: кто, сотрудник, было → стало', async () => {
    const after = [row('a-1', WARRANTY, '2026-10-01', null)];
    const { client, auditInserts } = makeClient([[], after]);

    const result = await runWithScheduleAudit(client, req, { employeeId: 445, operation: 'assign', date: '2026-10-01' }, async () => 'ok');

    expect(result).toBe('ok');
    expect(auditInserts).toHaveLength(1);
    const [userId, action, entityType, entityId] = auditInserts[0];
    expect([userId, action, entityType, entityId]).toEqual(['user-1', 'EMPLOYEE_SCHEDULE_CHANGED', 'employee', '445']);
    expect(detailsOf(auditInserts[0])).toEqual({
      employee_id: 445,
      employee_full_name: 'Гнатовский Виктор Викторович',
      operation: 'assign',
      date: '2026-10-01',
      from_schedule_name: OFFICE,
      from_is_default: true,
      to_schedule_name: WARRANTY,
      to_is_default: false,
      before: [],
      after,
    });
  });

  it('удаление записи: с её даты действует продлённая предыдущая', async () => {
    const before = [
      row('p-1', OFFICE, '2026-09-01', '2026-09-30'),
      row('a-1', WARRANTY, '2026-10-01', null),
    ];
    const after = [row('p-1', OFFICE, '2026-09-01', null)];
    const { client, auditInserts } = makeClient([before, after]);

    await runWithScheduleAudit(client, req, {
      employeeId: 445,
      operation: 'delete',
      assignmentId: 'a-1',
      date: rows => rows.find(r => r.id === 'a-1')?.effective_from ?? null,
    }, async () => ({ extended: { id: 'p-1', effective_to: null } }));

    expect(detailsOf(auditInserts[0])).toMatchObject({
      operation: 'delete',
      assignment_id: 'a-1',
      date: '2026-10-01',
      from_schedule_name: WARRANTY,
      from_is_default: false,
      to_schedule_name: OFFICE,
      to_is_default: false,
    });
  });

  it('правка одного якоря тоже попадает в след', async () => {
    const { client, auditInserts } = makeClient([
      [row('a-1', WARRANTY, '2026-10-01', null)],
      [row('a-1', WARRANTY, '2026-10-01', null, '2026-10-05')],
    ]);

    await runWithScheduleAudit(client, req, { employeeId: 445, operation: 'fix', assignmentId: 'a-1', date: '2026-10-01' }, async () => null);

    expect(detailsOf(auditInserts[0])).toMatchObject({ operation: 'fix', from_schedule_name: WARRANTY, to_schedule_name: WARRANTY });
  });

  it('бригада: в следе названия бригад', async () => {
    const { client, auditInserts } = makeClient([[], [row('a-1', WARRANTY, '2026-10-01', null)]]);

    await runWithScheduleAudit(client, req, {
      employeeId: 101, operation: 'brigade_assign', date: '2026-10-01', brigadeNames: ['Бр. Монолит'],
    }, async () => true);

    expect(detailsOf(auditInserts[0])).toMatchObject({ operation: 'brigade_assign', brigade_names: ['Бр. Монолит'] });
  });

  it('назначения не изменились — следа нет и лишних запросов нет', async () => {
    const same = [row('a-1', WARRANTY, '2026-10-01', null)];
    const { client, auditInserts, query } = makeClient([same, [...same.map(r => ({ ...r }))]]);

    await runWithScheduleAudit(client, req, { employeeId: 445, operation: 'remove', date: '2026-09-01' }, async () => false);

    expect(auditInserts).toHaveLength(0);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('операция упала — следа нет, ошибка уходит наверх (откат транзакции)', async () => {
    const { client, auditInserts } = makeClient([[], []]);

    await expect(runWithScheduleAudit(client, req, { employeeId: 445, operation: 'assign', date: '2026-10-01' }, async () => {
      throw new Error('conflict');
    })).rejects.toThrow('conflict');
    expect(auditInserts).toHaveLength(0);
  });

  it('запись аудита не прошла — ошибка уходит наверх', async () => {
    const { client, query } = makeClient([[], [row('a-1', WARRANTY, '2026-10-01', null)]]);
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.toLowerCase().trimStart().startsWith('insert into audit_logs')) throw new Error('audit down');
      return base(sql, params);
    });

    await expect(runWithScheduleAudit(client, req, { employeeId: 445, operation: 'assign', date: '2026-10-01' }, async () => 'ok'))
      .rejects.toThrow('audit down');
  });
});
