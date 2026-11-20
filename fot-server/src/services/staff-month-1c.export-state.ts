/**
 * Статусы выгрузки «сотрудников месяца» в ЗУП3 — хранение (миграция 373): ревизии состояний пар «сотрудник + месяц»,
 * указатель на текущую ревизию и подтверждения 1С (ACK). ACK проверяется по сохранённым ревизиям, а не по снимку
 * в памяти, поэтому работает и после рестарта сервера. Правила — staff-month-1c.export-state.rules.ts.
 */
import type { PoolClient } from 'pg';

import { query, withTransaction } from '../config/postgres.js';
import {
  checkStaffMonthAck,
  nextStaffMonthRevisions,
  staffMonthExportState,
  type IStaffMonthAck,
  type IStaffMonthState,
  type StaffMonthAckRejection,
  type StaffMonthExportState,
} from './staff-month-1c.export-state.rules.js';

interface IStateRow {
  employee_id: number;
  state_revision: string | number;
  present: boolean;
  preliminary: boolean;
  content_hash: string | null;
  computed_at?: string;
}

interface IAckRow {
  employee_id: number;
  state_revision: string | number;
  acked_at: string;
  document_ref: string | null;
}

const toState = (row: IStateRow): IStaffMonthState => ({
  revision: Number(row.state_revision),
  present: row.present,
  preliminary: row.preliminary,
  contentHash: row.content_hash,
});

const CURRENT_STATES_SQL = `
  SELECT s.employee_id, r.state_revision, r.present, r.preliminary, r.content_hash,
         to_char(r.computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at
    FROM staff_month_1c_states s
    JOIN staff_month_1c_state_revisions r
      ON r.employee_id = s.employee_id AND r.month = s.month AND r.state_revision = s.current_revision`;

/** Последнее подтверждение пары — подтверждённая ревизия с наибольшим номером. */
const LAST_ACKS_SQL = `
  SELECT DISTINCT ON (employee_id, month) employee_id, month, state_revision,
         to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acked_at, document_ref
    FROM staff_month_1c_exports`;

const loadCurrentStates = async (client: PoolClient, monthStart: string): Promise<Map<number, IStaffMonthState>> => {
  const { rows } = await client.query<IStateRow>(`${CURRENT_STATES_SQL} WHERE s.month = $1::date`, [monthStart]);
  return new Map(rows.map(row => [Number(row.employee_id), toState(row)]));
};

/**
 * Состояния после сборки снимка месяца — одной транзакцией под замком месяца: новые ревизии там, где тройка
 * present / preliminary / content_hash изменилась, надгробия у пропавших. Возвращает текущие ревизии всех пар.
 */
export const persistStaffMonthStates = async (
  month: string,
  rows: ReadonlyArray<{ employeeId: number; preliminary: boolean; contentHash: string }>,
): Promise<Map<number, IStaffMonthState>> => withTransaction(async client => {
  const monthStart = `${month}-01`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`staff_month_1c_states:${month}`]);
  const current = await loadCurrentStates(client, monthStart);
  const next = nextStaffMonthRevisions(current, rows);
  if (next.size > 0) {
    const entries = [...next];
    const params = [
      monthStart,
      entries.map(([employeeId]) => employeeId),
      entries.map(([, state]) => state.revision),
      entries.map(([, state]) => state.present),
      entries.map(([, state]) => state.preliminary),
      entries.map(([, state]) => state.contentHash),
    ];
    await client.query(
      `INSERT INTO staff_month_1c_state_revisions (employee_id, month, state_revision, present, preliminary, content_hash)
       SELECT e.id, $1::date, e.rev, e.present, e.preliminary, e.hash
         FROM unnest($2::int[], $3::bigint[], $4::boolean[], $5::boolean[], $6::text[])
              AS e(id, rev, present, preliminary, hash)
         JOIN employees emp ON emp.id = e.id`,
      params,
    );
    await client.query(
      `INSERT INTO staff_month_1c_states (employee_id, month, current_revision)
       SELECT e.id, $1::date, e.rev
         FROM unnest($2::int[], $3::bigint[]) AS e(id, rev)
         JOIN employees emp ON emp.id = e.id
       ON CONFLICT (employee_id, month) DO UPDATE SET current_revision = EXCLUDED.current_revision`,
      params.slice(0, 3),
    );
  }
  const merged = new Map(current);
  for (const [employeeId, state] of next) merged.set(employeeId, state);
  return merged;
});

export interface IStaffMonthExportInfo {
  states: Map<number, IStaffMonthState>;
  acks: Map<number, IStaffMonthAck>;
}

/** Текущие состояния и последние подтверждения всех пар месяца. */
export const loadStaffMonthExportInfo = async (month: string): Promise<IStaffMonthExportInfo> => {
  const monthStart = `${month}-01`;
  const [states, acks] = await Promise.all([
    query<IStateRow>(`${CURRENT_STATES_SQL} WHERE s.month = $1::date`, [monthStart]),
    query<IAckRow>(`${LAST_ACKS_SQL} WHERE month = $1::date ORDER BY employee_id, month, state_revision DESC`, [monthStart]),
  ]);
  return {
    states: new Map(states.map(row => [Number(row.employee_id), toState(row)])),
    acks: new Map(acks.map(row => [Number(row.employee_id), {
      revision: Number(row.state_revision), ackedAt: row.acked_at, documentRef: row.document_ref,
    }])),
  };
};

export interface IStaffMonthAckResult {
  accepted: Array<{ employee_id: number; state_revision: number; acked_at: string }>;
  rejected: Array<{ employee_id: number; state_revision: number; code: StaffMonthAckRejection }>;
}

/** Подтверждение 1С: принимается выданная, не предварительная ревизия с тем же хешем; повтор — прежнее acked_at. */
export const ackStaffMonth = async (input: {
  month: string;
  documentRef: string | null;
  keyId: string | null;
  items: ReadonlyArray<{ employeeId: number; revision: number; contentHash: string | null }>;
}): Promise<IStaffMonthAckResult> => withTransaction(async client => {
  const monthStart = `${input.month}-01`;
  const { rows } = await client.query<IStateRow>(
    `SELECT r.employee_id, r.state_revision, r.present, r.preliminary, r.content_hash
       FROM staff_month_1c_state_revisions r
       JOIN unnest($2::int[], $3::bigint[]) AS q(id, rev) ON q.id = r.employee_id AND q.rev = r.state_revision
      WHERE r.month = $1::date`,
    [monthStart, input.items.map(item => item.employeeId), input.items.map(item => item.revision)],
  );
  const known = new Map(rows.map(row => [`${Number(row.employee_id)}|${Number(row.state_revision)}`, toState(row)]));
  const result: IStaffMonthAckResult = { accepted: [], rejected: [] };
  for (const item of input.items) {
    const code = checkStaffMonthAck(known.get(`${item.employeeId}|${item.revision}`), item.contentHash);
    if (code) {
      result.rejected.push({ employee_id: item.employeeId, state_revision: item.revision, code });
      continue;
    }
    const { rows: saved } = await client.query<{ acked_at: string }>(
      `WITH ins AS (
         INSERT INTO staff_month_1c_exports (employee_id, month, state_revision, content_hash, document_ref, data_api_key_id)
         VALUES ($1, $2::date, $3, $4, $5, $6)
         ON CONFLICT (employee_id, month, state_revision) DO NOTHING
         RETURNING acked_at
       )
       SELECT to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acked_at FROM ins
       UNION ALL
       SELECT to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM staff_month_1c_exports
        WHERE employee_id = $1 AND month = $2::date AND state_revision = $3
       LIMIT 1`,
      [item.employeeId, monthStart, item.revision, item.contentHash, input.documentRef, input.keyId],
    );
    result.accepted.push({ employee_id: item.employeeId, state_revision: item.revision, acked_at: saved[0]?.acked_at ?? '' });
  }
  return result;
});

export interface IZup3ExportCell {
  month: string;
  state: StaffMonthExportState;
  acked_at: string | null;
  document_ref: string | null;
  computed_at: string | null;
}

/** Статусы для «Расчётов»: сотрудник → по месяцам, только чтение (без пересчёта). */
export const loadZup3ExportStates = async (
  employeeIds: readonly number[],
  months: readonly string[],
): Promise<Map<number, IZup3ExportCell[]>> => {
  const result = new Map<number, IZup3ExportCell[]>();
  if (employeeIds.length === 0 || months.length === 0) return result;
  const monthStarts = months.map(month => `${month}-01`);
  const [states, acks] = await Promise.all([
    query<IStateRow & { month: string }>(
      `SELECT to_char(s.month, 'YYYY-MM') AS month, s.employee_id, r.state_revision, r.present, r.preliminary,
              r.content_hash, to_char(r.computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS computed_at
         FROM staff_month_1c_states s
         JOIN staff_month_1c_state_revisions r
           ON r.employee_id = s.employee_id AND r.month = s.month AND r.state_revision = s.current_revision
        WHERE s.employee_id = ANY($1::int[]) AND s.month = ANY($2::date[])`,
      [[...employeeIds], monthStarts],
    ),
    query<IAckRow & { month: string }>(
      `SELECT DISTINCT ON (employee_id, month) employee_id, to_char(month, 'YYYY-MM') AS month, state_revision,
              to_char(acked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS acked_at, document_ref
         FROM staff_month_1c_exports
        WHERE employee_id = ANY($1::int[]) AND month = ANY($2::date[])
        ORDER BY employee_id, month, state_revision DESC`,
      [[...employeeIds], monthStarts],
    ),
  ]);
  const ackOf = new Map(acks.map(row => [`${Number(row.employee_id)}|${row.month}`, row]));
  for (const row of states) {
    const employeeId = Number(row.employee_id);
    const ack = ackOf.get(`${employeeId}|${row.month}`);
    const state = staffMonthExportState(toState(row), ack ? {
      revision: Number(ack.state_revision), ackedAt: ack.acked_at, documentRef: ack.document_ref,
    } : undefined);
    if (!state) continue;
    const list = result.get(employeeId) ?? [];
    list.push({
      month: row.month,
      state,
      acked_at: ack?.acked_at ?? null,
      document_ref: ack?.document_ref ?? null,
      computed_at: row.computed_at ?? null,
    });
    result.set(employeeId, list.sort((a, b) => a.month.localeCompare(b.month)));
  }
  return result;
};
