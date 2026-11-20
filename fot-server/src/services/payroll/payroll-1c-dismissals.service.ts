/**
 * Увольнение из 1С ЗУП3 по API — запись (миграция 372). Правила — payroll-1c-dismissals.rules.ts.
 *
 * Один запрос — одна транзакция: локи ГУИДов и пар «сотрудник × месяц» (try, иначе 409 busy), версии документов,
 * граф исправлений на состоянии «сохранённое + пачка», признак is_active, ячейки «Оплачено» vacation_compensation /
 * severance (= Σ действующих документов пары, прежнее значение — для отмены), журнал. dry_run — то же и ROLLBACK.
 * Ячейки пишутся под SET LOCAL fot.paid_writer = 'api_1c_dismissal' — только так их пропускает триггер 372.
 */
import type { PoolClient } from 'pg';

import { getPool } from '../../config/postgres.js';
import {
  decideDismissalVersion,
  decidePaidCell,
  dismissalWarnings,
  DISMISSAL_ITEMS,
  resolveDismissalGraph,
  type DismissalItem,
  type DismissalVersionAction,
  type IDismissalDoc,
  type IDismissalError,
  type IDismissalNode,
  type IPaidCell,
  type IPaidCellBefore,
} from './payroll-1c-dismissals.rules.js';

export class DismissalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly errors: IDismissalError[] = [],
  ) {
    super(message);
  }
}

interface IStoredDocRow {
  id: string | number;
  doc_guid: string;
  source_revision: string | number;
  posted: boolean;
  supersedes_guid: string | null;
  employee_id: number | null;
  period_month: string | null;
  content_hash: string;
  doc: Record<string, unknown>;
}

export interface ICellChange {
  employee_id: number;
  month: string;
  item: DismissalItem;
  action: 'set' | 'delete' | 'restore';
  before: string | null;
  after: string | null;
  owner_before: IPaidCellBefore;
}

export interface IDismissalResult {
  index: number;
  guid: string;
  action: Exclude<DismissalVersionAction, 'revision_conflict'>;
  employee_id: number | null;
  month: string | null;
  cells: Array<{ item: DismissalItem; before: string | null; after: string | null }>;
  warnings: Array<{ code: string; message: string }>;
}

const rows = async <T>(client: PoolClient, sql: string, params: unknown[]): Promise<T[]> => (await client.query(sql, params)).rows as T[];
const pairKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;
const toText = (centi: number): string => `${Math.trunc(centi / 100)}.${String(centi % 100).padStart(2, '0')}`;
const toCenti = (amount: string): number => Math.round(Number(amount) * 100);

const STORED_SQL = `
  SELECT id, doc_guid::text AS doc_guid, source_revision, posted, supersedes_guid::text AS supersedes_guid, employee_id,
         to_char(period_month, 'YYYY-MM') AS period_month, content_hash, to_jsonb(d) - 'warnings' AS doc
    FROM payroll_1c_dismissal_documents d`;

/** Связная цепочка исправлений: документы пачки, их предшественники и все, кто на них ссылается. */
const loadComponent = async (client: PoolClient, seed: ReadonlySet<string>): Promise<Map<string, IStoredDocRow>> => {
  const result = new Map<string, IStoredDocRow>();
  const queried = new Set<string>();
  let frontier = [...seed];
  for (let step = 0; frontier.length > 0 && step < 50; step += 1) {
    for (const guid of frontier) queried.add(guid);
    const found = await rows<IStoredDocRow>(client, `${STORED_SQL}
       WHERE d.doc_guid = ANY($1::uuid[]) OR d.supersedes_guid = ANY($1::uuid[])`, [frontier]);
    const next = new Set<string>();
    for (const row of found) {
      if (!result.has(row.doc_guid)) result.set(row.doc_guid, row);
      if (!queried.has(row.doc_guid)) next.add(row.doc_guid);
      if (row.supersedes_guid && !queried.has(row.supersedes_guid)) next.add(row.supersedes_guid);
    }
    frontier = [...next];
  }
  return result;
};

const tryLocks = async (client: PoolClient, keys: Iterable<string>): Promise<boolean> => {
  for (const key of [...new Set(keys)].sort()) {
    const [row] = await rows<{ ok: boolean }>(client, 'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [key]);
    if (!row?.ok) return false;
  }
  return true;
};

/** Последнее значение «до API» по ячейке из журнала: текущий цикл владения; после возврата — null. */
const loadJournalBefore = async (
  client: PoolClient, employeeId: number, month: string, item: DismissalItem,
): Promise<IPaidCellBefore | null> => {
  const [row] = await rows<{ change: ICellChange }>(client, `
    SELECT c AS change
      FROM payroll_1c_dismissal_revisions r
     CROSS JOIN LATERAL jsonb_array_elements(r.cell_changes) c
     WHERE (c->>'employee_id')::int = $1 AND c->>'month' = $2 AND c->>'item' = $3
     ORDER BY r.id DESC LIMIT 1`, [employeeId, month, item]);
  if (!row || row.change.action === 'restore') return null;
  return row.change.owner_before;
};

/** Приём пачки документов увольнения. */
export const applyDismissalBatch = async (input: {
  docs: readonly IDismissalDoc[];
  keyId: string | null;
  dryRun: boolean;
}): Promise<IDismissalResult[]> => {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL fot.paid_writer = 'api_1c_dismissal'");
    const batchGuids = new Set(input.docs.map(doc => doc.guid));
    for (const doc of input.docs) if (doc.supersedesGuid) batchGuids.add(doc.supersedesGuid);
    if (!(await tryLocks(client, [...batchGuids].map(guid => `dismissal_guid:${guid}`)))) {
      throw new DismissalApiError(409, 'busy', 'Документы увольнения сейчас принимаются — повторите позже', true);
    }
    const stored = await loadComponent(client, batchGuids);

    // Сотрудники и код физлица.
    const employeeIds = [...new Set(input.docs.filter(doc => doc.posted).map(doc => doc.employeeId!))];
    const employees = new Map((await rows<{ id: number; dismissal_date: string | null; id_all: string | null }>(client, `
      SELECT e.id, to_char(e.dismissal_date, 'YYYY-MM-DD') AS dismissal_date, h.passdesk_id_all::text AS id_all
        FROM employees e LEFT JOIN employee_hr_profiles h ON h.employee_id = e.id
       WHERE e.id = ANY($1::int[])`, [employeeIds])).map(row => [Number(row.id), row]));

    const errors: IDismissalError[] = [];
    const actions = new Map<string, DismissalVersionAction>();
    for (const doc of input.docs) {
      const prev = stored.get(doc.guid);
      const action = decideDismissalVersion(prev
        ? { sourceRevision: Number(prev.source_revision), posted: prev.posted, contentHash: prev.content_hash } : undefined, doc);
      actions.set(doc.guid, action);
      const at = { index: doc.index, guid: doc.guid };
      if (action === 'revision_conflict') {
        errors.push({ ...at, path: `documents[${doc.index}].source_revision`, message: 'та же ревизия с другим содержимым' });
      }
      if (doc.posted && (action === 'new' || action === 'updated')) {
        const employee = employees.get(doc.employeeId!);
        if (!employee) errors.push({ ...at, path: `documents[${doc.index}].employee.employee_id`, message: `сотрудника ${doc.employeeId} в ФОТ нет` });
        else if (employee.id_all && employee.id_all.toLowerCase() !== doc.idAll) {
          errors.push({ ...at, path: `documents[${doc.index}].employee.id_all`, message: 'код физлица не совпадает с карточкой ФОТ' });
        }
      }
    }
    if (errors.length > 0) {
      const code = errors.some(error => error.path.endsWith('employee_id')) ? 'unknown_employee'
        : errors.some(error => error.path.endsWith('id_all')) ? 'employee_mismatch' : 'revision_conflict';
      throw new DismissalApiError(400, code, 'Документы не приняты — исправьте указанные', false, errors);
    }

    // Состояние после пачки и граф.
    const applied = input.docs.filter(doc => ['new', 'updated', 'unposted'].includes(actions.get(doc.guid)!));
    const nodes = new Map<string, IDismissalNode>();
    for (const row of stored.values()) {
      nodes.set(row.doc_guid, {
        guid: row.doc_guid, posted: row.posted, supersedesGuid: row.supersedes_guid, employeeId: row.employee_id, month: row.period_month,
      });
    }
    for (const doc of applied) {
      const prev = nodes.get(doc.guid);
      nodes.set(doc.guid, doc.posted
        ? { guid: doc.guid, posted: true, supersedesGuid: doc.supersedesGuid, employeeId: doc.employeeId, month: doc.month }
        : { guid: doc.guid, posted: false, supersedesGuid: prev?.supersedesGuid ?? null, employeeId: prev?.employeeId ?? null, month: prev?.month ?? null });
    }
    const graph = resolveDismissalGraph(nodes);
    if (graph.conflicts.length > 0) {
      throw new DismissalApiError(400, 'supersedes_conflict', graph.conflicts.join('; '), false,
        input.docs.map(doc => ({ index: doc.index, guid: doc.guid, path: `documents[${doc.index}].supersedes_guid`, message: graph.conflicts[0] })));
    }

    // Пары всех документов цепочки — прежние и новые.
    const pairs = new Map<string, { employeeId: number; month: string }>();
    const addPair = (employeeId: number | null, month: string | null): void => {
      if (employeeId !== null && month !== null) pairs.set(pairKey(employeeId, month), { employeeId, month });
    };
    for (const row of stored.values()) addPair(row.employee_id, row.period_month);
    for (const node of nodes.values()) addPair(node.employeeId, node.month);
    if (!(await tryLocks(client, [...pairs.keys()].map(key => `dismissal_pair:${key}`)))) {
      throw new DismissalApiError(409, 'busy', 'Документы увольнения сейчас принимаются — повторите позже', true);
    }

    // Запись документов.
    const previousDoc = new Map<string, Record<string, unknown> | null>();
    const docIds = new Map<string, number>();
    for (const doc of input.docs) {
      const action = actions.get(doc.guid)!;
      const prev = stored.get(doc.guid);
      previousDoc.set(doc.guid, prev?.doc ?? null);
      if (prev) docIds.set(doc.guid, Number(prev.id));
      if (action === 'stale' || (action === 'unchanged' && prev && Number(prev.source_revision) >= doc.sourceRevision)) continue;
      const employee = doc.employeeId !== null ? employees.get(doc.employeeId) : undefined;
      const warnings = doc.posted
        ? dismissalWarnings(doc, { dismissalDate: employee?.dismissal_date ?? null, idAll: employee?.id_all ?? null }) : [];
      const [saved] = await rows<{ id: string | number }>(client, `
        INSERT INTO payroll_1c_dismissal_documents
          (doc_guid, source_revision, posted, supersedes_guid, doc_number, doc_date, period_month, organization_inn,
           employee_id, person_id_all, full_name_1c, dismissal_date, basis, vacation_compensation,
           vacation_compensation_days, severance, content_hash, warnings, data_api_key_id)
        VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, $12::date, $13, $14::numeric, $15::numeric,
                $16::numeric, $17, $18::jsonb, $19)
        ON CONFLICT (doc_guid) DO UPDATE SET
          source_revision = EXCLUDED.source_revision, posted = EXCLUDED.posted,
          supersedes_guid = CASE WHEN EXCLUDED.posted THEN EXCLUDED.supersedes_guid ELSE payroll_1c_dismissal_documents.supersedes_guid END,
          doc_number = COALESCE(EXCLUDED.doc_number, payroll_1c_dismissal_documents.doc_number),
          doc_date = COALESCE(EXCLUDED.doc_date, payroll_1c_dismissal_documents.doc_date),
          period_month = COALESCE(EXCLUDED.period_month, payroll_1c_dismissal_documents.period_month),
          organization_inn = COALESCE(EXCLUDED.organization_inn, payroll_1c_dismissal_documents.organization_inn),
          employee_id = COALESCE(EXCLUDED.employee_id, payroll_1c_dismissal_documents.employee_id),
          person_id_all = COALESCE(EXCLUDED.person_id_all, payroll_1c_dismissal_documents.person_id_all),
          full_name_1c = COALESCE(EXCLUDED.full_name_1c, payroll_1c_dismissal_documents.full_name_1c),
          dismissal_date = COALESCE(EXCLUDED.dismissal_date, payroll_1c_dismissal_documents.dismissal_date),
          basis = CASE WHEN EXCLUDED.posted THEN EXCLUDED.basis ELSE payroll_1c_dismissal_documents.basis END,
          vacation_compensation = COALESCE(EXCLUDED.vacation_compensation, payroll_1c_dismissal_documents.vacation_compensation),
          vacation_compensation_days = CASE WHEN EXCLUDED.posted THEN EXCLUDED.vacation_compensation_days
                                            ELSE payroll_1c_dismissal_documents.vacation_compensation_days END,
          severance = COALESCE(EXCLUDED.severance, payroll_1c_dismissal_documents.severance),
          content_hash = EXCLUDED.content_hash, warnings = EXCLUDED.warnings,
          data_api_key_id = EXCLUDED.data_api_key_id, updated_at = now()
        RETURNING id`,
      [doc.guid, doc.sourceRevision, doc.posted, doc.supersedesGuid, doc.number, doc.date,
        doc.month ? `${doc.month}-01` : null, doc.organizationInn, doc.employeeId, doc.idAll, doc.fullName, doc.dismissalDate,
        doc.basis, doc.compensationCenti === null ? null : toText(doc.compensationCenti), doc.compensationDays,
        doc.severanceCenti === null ? null : toText(doc.severanceCenti), doc.contentHash, JSON.stringify(warnings),
        input.keyId]);
      docIds.set(doc.guid, Number(saved.id));
    }
    const componentGuids = [...nodes.keys()];
    await client.query(
      'UPDATE payroll_1c_dismissal_documents SET is_active = (doc_guid = ANY($2::uuid[])) WHERE doc_guid = ANY($1::uuid[])',
      [componentGuids, [...graph.active]],
    );

    // Ячейки «Оплачено» затронутых пар.
    const sums = new Map((await rows<{ employee_id: number; month: string; vacation_compensation: string; severance: string }>(client, `
      SELECT employee_id, to_char(period_month, 'YYYY-MM') AS month,
             SUM(vacation_compensation)::text AS vacation_compensation, SUM(severance)::text AS severance
        FROM payroll_1c_dismissal_documents
       WHERE is_active AND (employee_id, to_char(period_month, 'YYYY-MM')) IN
             (SELECT * FROM unnest($1::int[], $2::text[]))
       GROUP BY 1, 2`, [[...pairs.values()].map(pair => pair.employeeId), [...pairs.values()].map(pair => pair.month)]))
      .map(row => [pairKey(Number(row.employee_id), row.month), row]));
    const changes: ICellChange[] = [];
    for (const pair of pairs.values()) {
      const sum = sums.get(pairKey(pair.employeeId, pair.month));
      const cells = new Map((await rows<{ item_code: DismissalItem; amount: string; source_kind: string | null; source_before: IPaidCellBefore | null; updated_by: string | null; updated_at: string | null }>(client, `
        SELECT item_code, amount::text AS amount, source_kind, source_before, updated_by::text AS updated_by,
               to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
          FROM payroll_paid_amounts
         WHERE employee_id = $1 AND month = $2::date AND item_code = ANY($3::text[])
         FOR UPDATE`, [pair.employeeId, `${pair.month}-01`, DISMISSAL_ITEMS])).map(row => [row.item_code, row]));
      for (const item of DISMISSAL_ITEMS) {
        const row = cells.get(item);
        const cell: IPaidCell | null = row ? {
          amountCenti: toCenti(row.amount), sourceKind: row.source_kind, sourceBefore: row.source_before,
          updatedBy: row.updated_by, updatedAt: row.updated_at,
        } : null;
        const sumCenti = sum ? toCenti(item === 'severance' ? sum.severance : sum.vacation_compensation) : 0;
        const journalBefore = row?.source_kind === 'api_1c_dismissal' ? null : await loadJournalBefore(client, pair.employeeId, pair.month, item);
        const decision = decidePaidCell(cell, Boolean(sum), sumCenti, journalBefore);
        if (decision.kind === 'keep') continue;
        const beforeText = row?.amount ?? null;
        if (decision.kind === 'set') {
          await client.query(`
            INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount, updated_by, updated_at, source_kind, source_before)
            VALUES ($1, $2::date, $3, $4::numeric, NULL, now(), 'api_1c_dismissal', $5::jsonb)
            ON CONFLICT (employee_id, month, item_code) DO UPDATE SET amount = EXCLUDED.amount, updated_by = NULL,
              updated_at = now(), source_kind = 'api_1c_dismissal', source_before = EXCLUDED.source_before`,
          [pair.employeeId, `${pair.month}-01`, item, toText(decision.amountCenti), JSON.stringify(decision.before)]);
          changes.push({ employee_id: pair.employeeId, month: pair.month, item, action: 'set', before: beforeText, after: toText(decision.amountCenti), owner_before: decision.before });
        } else if (decision.kind === 'delete') {
          await client.query('DELETE FROM payroll_paid_amounts WHERE employee_id = $1 AND month = $2::date AND item_code = $3',
            [pair.employeeId, `${pair.month}-01`, item]);
          changes.push({ employee_id: pair.employeeId, month: pair.month, item, action: 'delete', before: beforeText, after: null, owner_before: decision.before });
        } else {
          const before = decision.before;
          if ('absent' in before) {
            await client.query('DELETE FROM payroll_paid_amounts WHERE employee_id = $1 AND month = $2::date AND item_code = $3',
              [pair.employeeId, `${pair.month}-01`, item]);
          } else {
            await client.query(`
              INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount, updated_by, updated_at, source_kind, source_before)
              VALUES ($1, $2::date, $3, $4::numeric,
                      (SELECT id FROM user_profiles WHERE id::text = $5), COALESCE($6::timestamptz, now()), NULL, NULL)
              ON CONFLICT (employee_id, month, item_code) DO UPDATE SET amount = EXCLUDED.amount,
                updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at, source_kind = NULL, source_before = NULL`,
            [pair.employeeId, `${pair.month}-01`, item, before.amount, before.updated_by, before.updated_at]);
          }
          changes.push({
            employee_id: pair.employeeId, month: pair.month, item, action: 'restore', before: beforeText,
            after: 'absent' in before ? null : before.amount, owner_before: before,
          });
        }
      }
    }

    // Журнал и ответ.
    const results: IDismissalResult[] = [];
    for (const doc of input.docs) {
      const action = actions.get(doc.guid)! as IDismissalResult['action'];
      const node = nodes.get(doc.guid);
      const docPairs = new Set<string>();
      const prev = stored.get(doc.guid);
      if (prev?.employee_id != null && prev.period_month) docPairs.add(pairKey(prev.employee_id, prev.period_month));
      if (node?.employeeId != null && node.month) docPairs.add(pairKey(node.employeeId, node.month));
      const own = changes.filter(change => docPairs.has(pairKey(change.employee_id, change.month)));
      if (['new', 'updated', 'unposted'].includes(action)) {
        await client.query(`
          INSERT INTO payroll_1c_dismissal_revisions (document_id, source_revision, action, previous_document, cell_changes, data_api_key_id)
          VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
          ON CONFLICT (document_id, source_revision) DO NOTHING`,
        [docIds.get(doc.guid), doc.sourceRevision, action, JSON.stringify(previousDoc.get(doc.guid)), JSON.stringify(own), input.keyId]);
      }
      const employee = node?.employeeId != null ? employees.get(node.employeeId) : undefined;
      results.push({
        index: doc.index,
        guid: doc.guid,
        action,
        employee_id: node?.employeeId ?? null,
        month: node?.month ?? null,
        cells: own.map(change => ({ item: change.item, before: change.before, after: change.after })),
        warnings: doc.posted ? dismissalWarnings(doc, { dismissalDate: employee?.dismissal_date ?? null, idAll: employee?.id_all ?? null }) : [],
      });
    }
    await client.query(input.dryRun ? 'ROLLBACK' : 'COMMIT');
    return results;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** Действующие приказы сотрудника за месяцы from–to (YYYY-MM) — для карточки «Зарплата → Подробно». */
export const listDismissalOrders = async (
  employeeId: number, fromMonth: string, toMonth: string,
): Promise<Array<Record<string, unknown>>> => {
  const { rows: found } = await getPool().query(`
    SELECT d.doc_guid::text AS guid, to_char(d.period_month, 'YYYY-MM') AS month, d.doc_number, to_char(d.doc_date, 'YYYY-MM-DD') AS doc_date,
           to_char(d.dismissal_date, 'YYYY-MM-DD') AS dismissal_date, d.basis,
           d.vacation_compensation::text AS vacation_compensation, d.vacation_compensation_days::text AS vacation_compensation_days,
           d.severance::text AS severance, to_char(e.dismissal_date, 'YYYY-MM-DD') AS fot_dismissal_date
      FROM payroll_1c_dismissal_documents d
      JOIN employees e ON e.id = d.employee_id
     WHERE d.is_active AND d.employee_id = $1 AND d.period_month BETWEEN $2::date AND $3::date
     ORDER BY d.period_month, d.doc_date, d.doc_number`, [employeeId, `${fromMonth}-01`, `${toMonth}-01`]);
  return found;
};
