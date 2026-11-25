/**
 * «ЗП к выплате» ЗУП2 (origin = 'to_pay', миграция 379) против ведомостей API — решение пользователя 25.11: в «Выплатах
 * на карту (1С)» суммы ведомостей, пришедших из 1С по API. Пришла по API «Зарплата за месяц» или «Премии» сотрудника за
 * месяц — его строка «ЗП к выплате» того же месяца снимается целиком (снимок — payroll_1c_payout_to_pay_superseded);
 * таких ведомостей API у него за месяц не осталось (отмена, замена без него, откат выгрузки) — строка возвращается.
 *
 * Сверка — по состоянию, а не по событию: reconcileToPayLines смотрит все строки «ЗП к выплате» (их единицы) и снятые,
 * поэтому повтор ничего не меняет, а любой путь (приём, отмена, откат) приводит к одному результату. Вызывается внутри
 * транзакции API под SET LOCAL fot.payout_writer = 'api'; ведомость to_pay не из API — триггер её строки не держит.
 * «Остаток к выплате» считается как прежде («Сумма» − «Выплаты на карту»), здесь меняется только состав «Выплат».
 */
import type { PoolClient } from 'pg';

import { insertSnapshotLines, rowsOf, writeApiJournal } from './payroll-1c-payouts.api.store.js';

/** Виды ведомостей API, которые заменяют «ЗП к выплате» (в ней зарплата и премия вместе, остаток после аванса). */
export const TO_PAY_COVER_METHODS: readonly string[] = ['Зарплата за месяц', 'Премии'];

export interface IToPayChange {
  action: 'supersede' | 'restore';
  documentId: number;
  docNumber: string;
  employeeId: number;
  fullName: string;
  /** YYYY-MM-01. */
  month: string;
  amount: string;
  /** Ведомость API, которая сняла строку (у возврата — та, что снимала раньше). */
  byGuid: string;
}

const LINE_FIELDS = `l.line_no, l.line_key, l.full_name_1c, l.person_id_all::text AS person_id_all, l.brigade_1c,
  l.amount::text AS amount, l.employee_id, l.resolution, l.resolution_reason, l.period_month::text AS period_month,
  l.period_month_reason, l.basis, l.id_fot_1c`;

type LineRow = Record<string, unknown> & { line_no: number; employee_id: number; full_name_1c: string; amount: string };

const pairKey = (employeeId: number, month: string): string => `${employeeId}|${month}`;

const bumpRevision = async (client: PoolClient, documentId: number): Promise<{ revision: number; contentHash: string }> => {
  const [row] = await rowsOf<{ revision: number; content_hash: string }>(
    client,
    `UPDATE payroll_1c_payout_documents SET revision = revision + 1, updated_at = now(), updated_by = NULL
      WHERE id = $1 RETURNING revision - 1 AS revision, content_hash`,
    [documentId],
  );
  return { revision: Number(row.revision), contentHash: row.content_hash };
};

/** Привести строки «ЗП к выплате» в соответствие с ведомостями API. Возвращает, что снято и что возвращено. */
export const reconcileToPayLines = async (client: PoolClient, ctx: {
  batchId: string | null;
  keyId: string | null;
  bodySha: string;
}): Promise<IToPayChange[]> => {
  const docs = await rowsOf<{ id: string; doc_number: string; period_month: string }>(
    client,
    `SELECT id, doc_number, period_month::text AS period_month FROM payroll_1c_payout_documents WHERE origin = 'to_pay' ORDER BY id FOR UPDATE`,
    [],
  );
  if (docs.length === 0) return [];
  const docById = new Map(docs.map(doc => [Number(doc.id), doc]));
  const docIds = [...docById.keys()];

  const present = await rowsOf<LineRow & { document_id: string; month: string }>(
    client,
    `SELECT l.document_id, COALESCE(l.period_month, d.period_month)::text AS month, ${LINE_FIELDS}
       FROM payroll_1c_payout_lines l JOIN payroll_1c_payout_documents d ON d.id = l.document_id
      WHERE l.document_id = ANY($1::bigint[]) AND l.employee_id IS NOT NULL
      ORDER BY l.document_id, l.line_no`,
    [docIds],
  );
  const superseded = await rowsOf<{ id: string; document_id: string; line: LineRow; employee_id: number; month: string; superseded_by_guid: string }>(
    client,
    `SELECT id, document_id, line, employee_id, month::text AS month, superseded_by_guid::text AS superseded_by_guid
       FROM payroll_1c_payout_to_pay_superseded WHERE document_id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [docIds],
  );
  const pairs = new Map<string, { employeeId: number; month: string }>();
  for (const row of present) pairs.set(pairKey(Number(row.employee_id), row.month), { employeeId: Number(row.employee_id), month: row.month });
  for (const row of superseded) pairs.set(pairKey(Number(row.employee_id), row.month), { employeeId: Number(row.employee_id), month: row.month });
  if (pairs.size === 0) return [];

  const list = [...pairs.values()];
  const covering = await rowsOf<{ employee_id: number; month: string; guid: string }>(
    client,
    `SELECT l.employee_id, COALESCE(l.period_month, d.period_month)::text AS month, min(d.doc_guid::text) AS guid
       FROM payroll_1c_payout_lines l
       JOIN payroll_1c_payout_documents d ON d.id = l.document_id
       JOIN unnest($1::int[], $2::date[]) AS q(employee_id, month)
         ON q.employee_id = l.employee_id AND q.month = COALESCE(l.period_month, d.period_month)
      WHERE d.origin = 'api' AND d.payment_method = ANY($3::text[])
      GROUP BY l.employee_id, COALESCE(l.period_month, d.period_month)`,
    [list.map(pair => pair.employeeId), list.map(pair => pair.month), TO_PAY_COVER_METHODS],
  );
  const coveredBy = new Map(covering.map(row => [pairKey(Number(row.employee_id), row.month), row.guid]));

  const changes: IToPayChange[] = [];
  const removedByDoc = new Map<number, LineRow[]>();
  for (const row of present) {
    const guid = coveredBy.get(pairKey(Number(row.employee_id), row.month));
    if (!guid) continue;
    const documentId = Number(row.document_id);
    const { document_id: _doc, month: _month, ...line } = row;
    await client.query(
      `INSERT INTO payroll_1c_payout_to_pay_superseded (document_id, line, employee_id, month, superseded_by_guid, batch_id)
       VALUES ($1, $2::jsonb, $3, $4::date, $5::uuid, $6::uuid)`,
      [documentId, JSON.stringify(line), row.employee_id, row.month, guid, ctx.batchId],
    );
    await client.query('DELETE FROM payroll_1c_payout_lines WHERE document_id = $1 AND line_no = $2', [documentId, row.line_no]);
    removedByDoc.set(documentId, [...(removedByDoc.get(documentId) ?? []), line as LineRow]);
    changes.push({
      action: 'supersede', documentId, docNumber: docById.get(documentId)?.doc_number ?? '', employeeId: Number(row.employee_id),
      fullName: row.full_name_1c, month: row.month, amount: row.amount, byGuid: guid,
    });
  }
  const restoredByDoc = new Map<number, LineRow[]>();
  for (const row of superseded) {
    if (coveredBy.has(pairKey(Number(row.employee_id), row.month))) continue;
    const documentId = Number(row.document_id);
    await insertSnapshotLines(client, documentId, [row.line]);
    await client.query('DELETE FROM payroll_1c_payout_to_pay_superseded WHERE id = $1', [row.id]);
    restoredByDoc.set(documentId, [...(restoredByDoc.get(documentId) ?? []), row.line]);
    changes.push({
      action: 'restore', documentId, docNumber: docById.get(documentId)?.doc_number ?? '', employeeId: Number(row.employee_id),
      fullName: row.line.full_name_1c, month: row.month, amount: row.line.amount, byGuid: row.superseded_by_guid,
    });
  }

  // Журнал «ЗП к выплате»: снятие — со снимком снятых строк, возврат — с пустым снимком (строки вернулись).
  for (const [documentId, lines] of [...removedByDoc, ...restoredByDoc]) {
    const action = removedByDoc.get(documentId) === lines ? 'supersede' : 'restore';
    const { revision, contentHash } = await bumpRevision(client, documentId);
    await writeApiJournal(client, {
      documentId, action, revisionBefore: revision, contentHashBefore: contentHash, contentHashAfter: contentHash,
      previousHeader: null, previousLines: action === 'supersede' ? lines : [], bodySha256: ctx.bodySha,
      targets: [], amountsCents: new Map(), keyId: ctx.keyId, batchId: ctx.batchId,
    });
  }
  return changes;
};

/** Предупреждение ответа 1С о снятой или возвращённой строке «ЗП к выплате». */
export const toPayWarning = (change: IToPayChange): string => (
  `«ЗП к выплате» № ${change.docNumber}: ${change.action === 'supersede' ? 'снята' : 'возвращена'} строка ${change.fullName} `
  + `${change.amount} за ${change.month.slice(0, 7)} — ${change.action === 'supersede'
    ? 'пришла по API зарплата или премия' : 'по API за месяц больше нет зарплаты и премии'}`
);
