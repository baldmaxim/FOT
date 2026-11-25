/**
 * Ведомости выплаты по API — работа с БД внутри транзакции (миграция 379): блокировки, состояния API по ГУИДу,
 * ведомости по ГУИДу и номеру, снимки шапки и строк (журнал и откат), вставка строк пачками, запись журнала.
 * Всё пишется под SET LOCAL fot.payout_writer = 'api' — иначе ведомость из API не пропустит триггер 379.
 */
import type { PoolClient } from 'pg';

import type { ICarriedLine, IFotLineDecision, IPayoutApiState, IStoredPayoutDoc } from './payroll-1c-payouts.api.rules.js';
import type { IPayoutApiLineTarget } from './payroll-1c-payouts.api-lines.js';
import type { IPayoutApiDocument } from './payroll-1c-payouts.month-xml.js';
import { payoutNumberLockKey } from './payroll-1c-payouts.service.js';

export const rowsOf = async <T>(client: PoolClient, sql: string, params: unknown[]): Promise<T[]> => (
  (await client.query(sql, params)).rows as T[]
);

export const centsText = (cents: number): string => (cents / 100).toFixed(2);
export const toCents = (amount: string): number => Math.round(Number(amount) * 100);

/** Ключ блокировки ведомости по ГУИДу — тот же, что у кнопки «Загрузить из 1С». */
export const payoutGuidLockKey = (guid: string): string => `payroll_1c_payout:${guid}`;

/** Блокировки без ожидания (ключи отсортированы): не взята хоть одна — false. */
export const tryPayoutLocks = async (client: PoolClient, keys: Iterable<string>): Promise<boolean> => {
  for (const key of [...new Set(keys)].sort()) {
    const [row] = await rowsOf<{ ok: boolean }>(client, 'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok', [key]);
    if (!row?.ok) return false;
  }
  return true;
};

/** Блокировки с ожиданием — для отката выгрузки (оператор, не очередь 1С). */
export const waitPayoutLocks = async (client: PoolClient, keys: Iterable<string>): Promise<void> => {
  for (const key of [...new Set(keys)].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
};

export const payoutDocLockKeys = (docs: ReadonlyArray<Pick<IPayoutApiDocument, 'guid' | 'docNumber' | 'docDate'>>): string[] => (
  docs.flatMap(doc => [payoutGuidLockKey(doc.guid), payoutNumberLockKey(doc.docNumber, doc.docDate)])
);

export const loadApiStates = async (client: PoolClient, guids: readonly string[]): Promise<Map<string, IPayoutApiState & { raw: Record<string, unknown> }>> => {
  const found = await rowsOf<{ doc_guid: string; version: string; state: 'active' | 'cancelled'; api_hash: string | null; document_id: string | null }>(
    client,
    `SELECT doc_guid::text AS doc_guid, version, state, api_hash, document_id, data_api_key_id::text AS data_api_key_id
       FROM payroll_1c_payout_api_states WHERE doc_guid = ANY($1::uuid[]) FOR UPDATE`,
    [guids],
  );
  return new Map(found.map(row => [row.doc_guid, {
    version: Number(row.version),
    state: row.state,
    apiHash: row.api_hash,
    documentId: row.document_id === null ? null : Number(row.document_id),
    raw: row as unknown as Record<string, unknown>,
  }]));
};

export const saveApiState = async (client: PoolClient, input: {
  guid: string; version: number; state: 'active' | 'cancelled'; apiHash: string | null; documentId: number | null; keyId: string | null;
}): Promise<void> => {
  await client.query(
    `INSERT INTO payroll_1c_payout_api_states (doc_guid, version, state, api_hash, document_id, data_api_key_id, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, now())
     ON CONFLICT (doc_guid) DO UPDATE SET version = EXCLUDED.version, state = EXCLUDED.state, api_hash = EXCLUDED.api_hash,
       document_id = EXCLUDED.document_id, data_api_key_id = EXCLUDED.data_api_key_id, updated_at = now()`,
    [input.guid, input.version, input.state, input.apiHash, input.documentId, input.keyId],
  );
};

const STORED_DOC_SQL = `
  SELECT d.id, d.doc_guid::text AS guid, d.origin, d.total_amount::text AS total_amount, d.payment_method,
         d.period_month::text AS period_month, d.organization_inn, d.doc_number, d.doc_date::text AS doc_date,
         (SELECT count(*)::int FROM payroll_1c_payout_lines l WHERE l.document_id = d.id) AS lines
    FROM payroll_1c_payout_documents d`;

interface IStoredDocRow {
  id: string; guid: string; origin: string; total_amount: string; payment_method: string; period_month: string;
  organization_inn: string; doc_number: string; doc_date: string; lines: number;
}

const toStored = (row: IStoredDocRow): IStoredPayoutDoc => ({
  id: Number(row.id),
  guid: row.guid,
  origin: row.origin,
  totalCents: toCents(row.total_amount),
  paymentMethod: row.payment_method,
  periodMonth: row.period_month,
  lines: Number(row.lines),
});

/** Ведомости по ГУИДу (под блокировкой строк). */
export const loadDocsByGuid = async (client: PoolClient, guids: readonly string[]): Promise<Map<string, IStoredPayoutDoc>> => {
  const found = await rowsOf<IStoredDocRow>(client, `${STORED_DOC_SQL} WHERE d.doc_guid = ANY($1::uuid[]) FOR UPDATE OF d`, [guids]);
  return new Map(found.map(row => [row.guid, toStored(row)]));
};

/** Ведомости с той же организацией, номером и датой под другим ГУИДом — по ГУИДу пришедшей. */
export const loadDocsByNumber = async (
  client: PoolClient, docs: ReadonlyArray<Pick<IPayoutApiDocument, 'guid' | 'organizationInn' | 'docNumber' | 'docDate'>>,
): Promise<Map<string, IStoredPayoutDoc>> => {
  const found = await rowsOf<IStoredDocRow & { incoming: string }>(
    client,
    `SELECT s.*, q.guid AS incoming FROM unnest($1::text[], $2::text[], $3::date[], $4::uuid[]) AS q(inn, num, dt, guid)
       JOIN LATERAL (${STORED_DOC_SQL}
              WHERE d.organization_inn = q.inn AND d.doc_number = q.num AND d.doc_date = q.dt AND d.doc_guid <> q.guid) s ON true`,
    [docs.map(doc => doc.organizationInn), docs.map(doc => doc.docNumber), docs.map(doc => doc.docDate), docs.map(doc => doc.guid)],
  );
  return new Map(found.map(row => [String(row.incoming), toStored(row)]));
};

const HEADER_COLUMNS = `doc_guid::text AS doc_guid, doc_number, zup2_number, doc_date::text AS doc_date, period_month::text AS period_month, payment_method,
  salary_project, organization_inn, total_amount::text AS total_amount, content_hash, revision, source, origin, comment`;
const LINE_COLUMNS = `line_no, line_key, full_name_1c, person_id_all::text AS person_id_all, brigade_1c, amount::text AS amount,
  employee_id, resolution, resolution_reason, period_month::text AS period_month, period_month_reason, basis, id_fot_1c`;

export interface IDocSnapshot {
  header: Record<string, unknown>;
  lines: Array<Record<string, unknown>>;
}

/** Шапка и строки ведомости — для журнала и отката. */
export const snapshotDoc = async (client: PoolClient, documentId: number): Promise<IDocSnapshot | null> => {
  const [header] = await rowsOf<Record<string, unknown>>(client, `SELECT ${HEADER_COLUMNS} FROM payroll_1c_payout_documents WHERE id = $1`, [documentId]);
  if (!header) return null;
  const lines = await rowsOf<Record<string, unknown>>(
    client, `SELECT ${LINE_COLUMNS} FROM payroll_1c_payout_lines WHERE document_id = $1 ORDER BY line_no`, [documentId],
  );
  return { header, lines };
};

const LINE_CHUNK = 500;

/**
 * Строки ведомости из API — пачками по LINE_CHUNK внутри транзакции. lines — сотрудник и месяц строки после переноса
 * решений ФОТ (carryFotDecisions) по line_key.
 */
export const insertApiLines = async (
  client: PoolClient, documentId: number, doc: IPayoutApiDocument, lines: ReadonlyMap<string, ICarriedLine>,
): Promise<void> => {
  for (let start = 0; start < doc.lines.length; start += LINE_CHUNK) {
    const chunk = doc.lines.slice(start, start + LINE_CHUNK);
    const final = (key: string) => lines.get(key) as ICarriedLine;
    await client.query(
      `INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, person_id_all, brigade_1c, amount,
         employee_id, resolution, resolution_reason, period_month, period_month_reason, basis, id_fot_1c)
       SELECT $1, q.line_no, q.line_key, q.full_name, q.id_all, NULL, q.amount, q.employee_id, q.resolution, q.reason,
              q.period_month, q.period_reason, q.basis, q.id_fot
         FROM unnest($2::int[], $3::text[], $4::text[], $5::uuid[], $6::numeric[], $7::int[], $8::text[], $9::text[],
                     $10::date[], $11::text[], $12::text[], $13::int[])
              AS q(line_no, line_key, full_name, id_all, amount, employee_id, resolution, reason, period_month, period_reason, basis, id_fot)`,
      [
        documentId,
        chunk.map(line => line.lineNo),
        chunk.map(line => line.lineKey),
        chunk.map(line => line.fullName),
        chunk.map(line => line.personIdAll),
        chunk.map(line => centsText(line.amountCents)),
        chunk.map(line => final(line.lineKey).employeeId),
        chunk.map(line => final(line.lineKey).resolution),
        chunk.map(line => final(line.lineKey).reason),
        chunk.map(line => final(line.lineKey).periodMonth),
        chunk.map(line => final(line.lineKey).periodMonthReason),
        chunk.map(line => line.basis),
        chunk.map(line => line.idFot),
      ],
    );
  }
};

/** Строки ведомости перед последней отменой из 1С — решения ФОТ для возврата (restore) после повторного проведения. */
export const loadLastCancelLines = async (client: PoolClient, documentId: number): Promise<IFotLineDecision[]> => {
  const [row] = await rowsOf<{ previous_lines: IFotLineDecision[] | null }>(
    client,
    `SELECT previous_lines FROM payroll_1c_payout_imports WHERE document_id = $1 AND action = 'cancel' ORDER BY id DESC LIMIT 1`,
    [documentId],
  );
  return row?.previous_lines ?? [];
};

/** Строки из снимка — откат выгрузки. */
export const insertSnapshotLines = async (client: PoolClient, documentId: number, lines: ReadonlyArray<Record<string, unknown>>): Promise<void> => {
  for (const line of lines) {
    await client.query(
      `INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, person_id_all, brigade_1c, amount,
         employee_id, resolution, resolution_reason, period_month, period_month_reason, basis, id_fot_1c)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7::numeric, $8, $9, $10, $11::date, $12, $13, $14)`,
      [documentId, line.line_no, line.line_key, line.full_name_1c, line.person_id_all, line.brigade_1c, line.amount,
        line.employee_id, line.resolution, line.resolution_reason, line.period_month, line.period_month_reason, line.basis, line.id_fot_1c],
    );
  }
};

/** Σ строк = итог документа и число строк — иначе запись отменяется. */
export const assertDocTotals = async (client: PoolClient, documentId: number, expectedLines: number): Promise<boolean> => {
  const [check] = await rowsOf<{ total: string; doc_total: string; count: number }>(
    client,
    `SELECT COALESCE(sum(l.amount), 0)::text AS total, d.total_amount::text AS doc_total, count(l.*)::int AS count
       FROM payroll_1c_payout_documents d LEFT JOIN payroll_1c_payout_lines l ON l.document_id = d.id
      WHERE d.id = $1 GROUP BY d.total_amount`,
    [documentId],
  );
  return !!check && toCents(check.total) === toCents(check.doc_total) && Number(check.count) === expectedLines;
};

/** Запись журнала загрузок (payroll_1c_payout_imports) для действия API. */
export const writeApiJournal = async (client: PoolClient, input: {
  documentId: number;
  action: 'new' | 'replace' | 'restore' | 'cancel' | 'rollback' | 'adopt' | 'supersede';
  revisionBefore: number;
  contentHashBefore: string | null;
  contentHashAfter: string;
  previousHeader: Record<string, unknown> | null;
  previousLines: ReadonlyArray<Record<string, unknown>> | null;
  bodySha256: string;
  targets: readonly IPayoutApiLineTarget[];
  amountsCents: ReadonlyMap<string, number>;
  keyId: string | null;
  batchId: string | null;
}): Promise<void> => {
  let matched = 0;
  let unmatched = 0;
  for (const target of input.targets) {
    const cents = input.amountsCents.get(target.lineKey) ?? 0;
    if (target.employeeId === null) unmatched += cents;
    else matched += cents;
  }
  await client.query(
    `INSERT INTO payroll_1c_payout_imports (document_id, action, revision_before, revision_after, content_hash_before,
       content_hash_after, previous_header, previous_lines, source_format, file_name, file_sha256, lines_matched,
       lines_unmatched, amount_matched, amount_unmatched, imported_by, data_api_key_id, batch_id)
     VALUES ($1, $2, $3, $3 + 1, $4, $5, $6::jsonb, $7::jsonb, 'api', 'API 1С', $8, $9, $10, $11::numeric, $12::numeric, NULL, $13::uuid, $14::uuid)`,
    [input.documentId, input.action, input.revisionBefore, input.contentHashBefore, input.contentHashAfter,
      input.previousHeader ? JSON.stringify(input.previousHeader) : null,
      input.previousLines ? JSON.stringify(input.previousLines) : null,
      input.bodySha256,
      input.targets.filter(target => target.employeeId !== null).length,
      input.targets.filter(target => target.employeeId === null).length,
      centsText(matched), centsText(unmatched), input.keyId, input.batchId],
  );
};
