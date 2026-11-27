/**
 * Статусы выгрузки «сотрудников месяца» в ЗУП3 по половинам месяца — хранение (миграция 375): ревизии состояний
 * «сотрудник + месяц + половина», указатель на текущую ревизию и подтверждения 1С (ACK). ACK проверяется по
 * сохранённым ревизиям, а не по снимку в памяти, поэтому работает и после рестарта сервера. Подтверждение половины
 * другую половину не трогает. Правила — staff-month-1c.export-state.rules.ts. Таблицы 373 (статусы за месяц) не
 * используются.
 */
import type { PoolClient } from 'pg';

import { query, withTransaction } from '../config/postgres.js';
import {
  checkStaffMonthAck,
  nextStaffMonthRevisions,
  type IStaffMonthAck,
  type IStaffMonthState,
  type StaffMonthAckRejection,
} from './staff-month-1c.export-state.rules.js';
import type { StaffMonthHalf } from './staff-month-1c.rules.js';

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

const ISO = (column: string): string => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const CURRENT_STATES_SQL = `
  SELECT s.employee_id, r.state_revision, r.present, r.preliminary, r.content_hash, ${ISO('r.computed_at')} AS computed_at
    FROM staff_month_1c_half_states s
    JOIN staff_month_1c_half_revisions r
      ON r.employee_id = s.employee_id AND r.month = s.month AND r.half = s.half AND r.state_revision = s.current_revision`;

/** Последнее подтверждение пары — подтверждённая ревизия с наибольшим номером. */
const LAST_ACKS_SQL = `
  SELECT DISTINCT ON (employee_id, month, half) employee_id, state_revision, ${ISO('acked_at')} AS acked_at, document_ref
    FROM staff_month_1c_half_exports`;

const loadCurrentStates = async (client: PoolClient, monthStart: string, half: StaffMonthHalf): Promise<Map<number, IStaffMonthState>> => {
  const { rows } = await client.query<IStateRow>(`${CURRENT_STATES_SQL} WHERE s.month = $1::date AND s.half = $2`, [monthStart, half]);
  return new Map(rows.map(row => [Number(row.employee_id), toState(row)]));
};

export type StaffMonthHalfStateRows = ReadonlyArray<{ employeeId: number; preliminary: boolean; contentHash: string }>;

/**
 * Состояния после сборки снимка — одной транзакцией под замком месяца, по каждой переданной половине: новые ревизии
 * там, где тройка present / preliminary / content_hash изменилась, надгробия у пропавших. Не начавшуюся половину не
 * передают (иначе её прошлые строки стали бы надгробиями). Возвращает текущие ревизии всех пар по половинам.
 */
export const persistStaffMonthStates = async (
  month: string,
  halves: ReadonlyMap<StaffMonthHalf, StaffMonthHalfStateRows>,
  fingerprint: string,
): Promise<Map<StaffMonthHalf, Map<number, IStaffMonthState>>> => withTransaction(async client => {
  const monthStart = `${month}-01`;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`staff_month_1c_half_states:${month}`]);
  await client.query(
    `INSERT INTO staff_month_1c_half_builds (month, fingerprint, built_at) VALUES ($1::date, $2, now())
     ON CONFLICT (month) DO UPDATE SET fingerprint = EXCLUDED.fingerprint, built_at = now()`,
    [monthStart, fingerprint],
  );
  const result = new Map<StaffMonthHalf, Map<number, IStaffMonthState>>();
  for (const [half, rows] of halves) {
    const current = await loadCurrentStates(client, monthStart, half);
    const next = nextStaffMonthRevisions(current, rows);
    if (next.size > 0) {
      const entries = [...next];
      const params = [
        monthStart,
        half,
        entries.map(([employeeId]) => employeeId),
        entries.map(([, state]) => state.revision),
        entries.map(([, state]) => state.present),
        entries.map(([, state]) => state.preliminary),
        entries.map(([, state]) => state.contentHash),
      ];
      await client.query(
        `INSERT INTO staff_month_1c_half_revisions (employee_id, month, half, state_revision, present, preliminary, content_hash)
         SELECT e.id, $1::date, $2, e.rev, e.present, e.preliminary, e.hash
           FROM unnest($3::int[], $4::bigint[], $5::boolean[], $6::boolean[], $7::text[])
                AS e(id, rev, present, preliminary, hash)
           JOIN employees emp ON emp.id = e.id`,
        params,
      );
      await client.query(
        `INSERT INTO staff_month_1c_half_states (employee_id, month, half, current_revision)
         SELECT e.id, $1::date, $2, e.rev
           FROM unnest($3::int[], $4::bigint[]) AS e(id, rev)
           JOIN employees emp ON emp.id = e.id
         ON CONFLICT (employee_id, month, half) DO UPDATE SET current_revision = EXCLUDED.current_revision`,
        params.slice(0, 4),
      );
    }
    const merged = new Map(current);
    for (const [employeeId, state] of next) merged.set(employeeId, state);
    result.set(half, merged);
  }
  return result;
});

export interface IStaffMonthBuild {
  fingerprint: string | null;
  builtAt: string | null;
  startedAt: string | null;
}

/** Последняя сборка месяца (отпечаток, когда собрана и когда начата фоновая) — для фонового обновления; нет — null. */
export const loadStaffMonthBuild = async (month: string): Promise<IStaffMonthBuild | null> => {
  const [row] = await query<{ fingerprint: string | null; built_at: string | null; started_at: string | null }>(
    `SELECT fingerprint, ${ISO('built_at')} AS built_at, ${ISO('started_at')} AS started_at
       FROM staff_month_1c_half_builds WHERE month = $1::date`,
    [`${month}-01`],
  );
  return row ? { fingerprint: row.fingerprint, builtAt: row.built_at, startedAt: row.started_at } : null;
};

/** Фоновая сборка месяца начата — отметка до сборки (сбой или рестарт оставят её незавершённой). */
export const markStaffMonthBuildStarted = async (month: string): Promise<void> => {
  await query(
    `INSERT INTO staff_month_1c_half_builds (month, started_at) VALUES ($1::date, now())
     ON CONFLICT (month) DO UPDATE SET started_at = now()`,
    [`${month}-01`],
  );
};

export interface IStaffMonthExportInfo {
  states: Map<number, IStaffMonthState>;
  acks: Map<number, IStaffMonthAck>;
}

/** Текущие состояния и последние подтверждения всех пар половины. */
export const loadStaffMonthExportInfo = async (month: string, half: StaffMonthHalf): Promise<IStaffMonthExportInfo> => {
  const monthStart = `${month}-01`;
  const [states, acks] = await Promise.all([
    query<IStateRow>(`${CURRENT_STATES_SQL} WHERE s.month = $1::date AND s.half = $2`, [monthStart, half]),
    query<IAckRow>(
      `${LAST_ACKS_SQL} WHERE month = $1::date AND half = $2 ORDER BY employee_id, month, half, state_revision DESC`,
      [monthStart, half],
    ),
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

/** Подтверждение 1С половины: принимается выданная, не предварительная ревизия с тем же хешем; повтор — прежнее acked_at. */
export const ackStaffMonth = async (input: {
  month: string;
  half: StaffMonthHalf;
  documentRef: string | null;
  keyId: string | null;
  items: ReadonlyArray<{ employeeId: number; revision: number; contentHash: string | null }>;
}): Promise<IStaffMonthAckResult> => withTransaction(async client => {
  const monthStart = `${input.month}-01`;
  const { rows } = await client.query<IStateRow>(
    `SELECT r.employee_id, r.state_revision, r.present, r.preliminary, r.content_hash
       FROM staff_month_1c_half_revisions r
       JOIN unnest($3::int[], $4::bigint[]) AS q(id, rev) ON q.id = r.employee_id AND q.rev = r.state_revision
      WHERE r.month = $1::date AND r.half = $2`,
    [monthStart, input.half, input.items.map(item => item.employeeId), input.items.map(item => item.revision)],
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
         INSERT INTO staff_month_1c_half_exports (employee_id, month, half, state_revision, content_hash, document_ref, data_api_key_id)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7)
         ON CONFLICT (employee_id, month, half, state_revision) DO NOTHING
         RETURNING acked_at
       )
       SELECT ${ISO('acked_at')} AS acked_at FROM ins
       UNION ALL
       SELECT ${ISO('acked_at')} FROM staff_month_1c_half_exports
        WHERE employee_id = $1 AND month = $2::date AND half = $3 AND state_revision = $4
       LIMIT 1`,
      [item.employeeId, monthStart, input.half, item.revision, item.contentHash, input.documentRef, input.keyId],
    );
    result.accepted.push({ employee_id: item.employeeId, state_revision: item.revision, acked_at: saved[0]?.acked_at ?? '' });
  }
  return result;
});
