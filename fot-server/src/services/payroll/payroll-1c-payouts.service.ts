/**
 * «Перечислено (1С)» (миграция 328): предпросмотр и загрузка ведомостей выплаты из 1С, история сотрудника.
 * Справочно — в расчётах ФОТ не участвует: эти таблицы читают только загрузка и «История выплат».
 *
 * Сервер между шагами ничего не хранит: файл присылается заново, выбор оператора привязан к fingerprint строки
 * (хеш содержимого файла + ключ строки). Загрузка — одна транзакция с блокировкой по ГУИДу (advisory lock — и когда
 * документа ещё нет), проверкой хеша файла и ревизии из предпросмотра: устаревший предпросмотр → 409.
 *
 * Классификация при том же ГУИДе: тот же content_hash — без изменений / дополнение (пустые поля другого формата) /
 * пересопоставление (оператор сменил сотрудника); другой хеш или другой id_all строки — замена с подтверждением.
 */
import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { query, withTransaction } from '../../config/postgres.js';
import { matchPayoutLines, type IPayoutCandidate } from './payroll-1c-payouts.matching.js';
import { parsePayout1cXml, type IPayout1cDocument, type Payout1cFormat } from './payroll-1c-payouts.parser.js';

export type PayoutResolution = 'auto_id_all' | 'confirmed' | 'unmatched';
export type PayoutPreviewStatus = 'new' | 'unchanged' | 'enrich' | 'changed';
export type PayoutImportAction = 'new' | 'replace' | 'enrich' | 'relink' | 'unchanged';

export class Payout1cImportError extends Error {
  constructor(message: string, readonly status: 400 | 409) {
    super(message);
  }
}

export interface IPayoutHeader {
  doc_guid: string;
  doc_number: string;
  zup2_number: string | null;
  doc_date: string;
  period_month: string;
  payment_method: string;
  salary_project: string | null;
  total_amount: string;
}

export interface IPayoutPreviewLine {
  fingerprint: string;
  line_no: number;
  full_name: string;
  brigade: string | null;
  amount: string;
  auto_employee_id: number | null;
  /** Сохранённый сотрудник строки (тот же документ, тот же хеш); иначе null. */
  current_employee_id: number | null;
  current_resolution: PayoutResolution | null;
  candidates: IPayoutCandidate[];
}

export interface IPayoutChange {
  field: string;
  before: string | null;
  after: string | null;
}

export interface IPayoutPreview {
  format: Payout1cFormat;
  document: IPayoutHeader;
  status: PayoutPreviewStatus;
  expected_revision: number;
  incoming_content_hash: string;
  /** Разница с сохранённым документом при «changed»: реквизиты и строки (ФИО и сумма). */
  changes: { header: IPayoutChange[]; added: string[]; removed: string[] } | null;
  /** Что дополнит загрузка при «enrich». */
  enrich_fields: string[];
  lines: IPayoutPreviewLine[];
}

export interface IPayoutImportInput {
  buffer: Buffer;
  fileName: string | null;
  userId: string | null;
  incomingContentHash: string;
  expectedRevision: number;
  confirmReplace: boolean;
  /** fingerprint → сотрудник; null — «Без сотрудника». Нет ключа — авто или сохранённое. */
  choices: Record<string, number | null>;
}

export interface IPayoutImportResult {
  action: PayoutImportAction;
  document_id: number | null;
  revision: number;
  lines_matched: number;
  lines_unmatched: number;
}

interface IStoredDocument extends IPayoutHeader {
  id: number;
  organization_inn: string;
  content_hash: string;
  revision: number;
}

interface IStoredLine {
  line_no: number;
  line_key: string;
  full_name_1c: string;
  person_id_all: string | null;
  brigade_1c: string | null;
  amount: string;
  employee_id: number | null;
  resolution: PayoutResolution;
  resolution_reason: string | null;
}

const centsText = (cents: number): string => (cents / 100).toFixed(2);

export const payoutFingerprint = (contentHash: string, lineKey: string): string => (
  createHash('sha256').update(`${contentHash}|${lineKey}`, 'utf8').digest('hex')
);

/** Имя файла для журнала: только имя, без управляющих символов, до 200 знаков. */
export const sanitizePayoutFileName = (name: string | null | undefined): string | null => {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200).trim();
  return clean === '' ? null : clean;
};

const headerOf = (doc: IPayout1cDocument): IPayoutHeader => ({
  doc_guid: doc.guid,
  doc_number: doc.docNumber,
  zup2_number: doc.zup2Number,
  doc_date: doc.docDate,
  period_month: doc.periodMonth,
  payment_method: doc.paymentMethod,
  salary_project: doc.salaryProject,
  total_amount: centsText(doc.totalCents),
});

const parseFile = (buffer: Buffer): IPayout1cDocument => parsePayout1cXml(buffer.toString('utf8'));

const DOC_COLUMNS = `id, doc_guid::text AS doc_guid, doc_number, zup2_number, doc_date::text AS doc_date,
  period_month::text AS period_month, payment_method, salary_project, organization_inn, total_amount::text AS total_amount,
  content_hash, revision`;
const LINE_COLUMNS = `line_no, line_key, full_name_1c, person_id_all::text AS person_id_all, brigade_1c,
  amount::text AS amount, employee_id, resolution, resolution_reason`;

type Runner = <T extends QueryResultRow>(sql: string, params: unknown[]) => Promise<T[]>;
const viaPool: Runner = (sql, params) => query(sql, params);
const viaClient = (client: PoolClient): Runner => async <T extends QueryResultRow>(sql: string, params: unknown[]) => (
  (await client.query<T>(sql, params)).rows
);

const loadStored = async (run: Runner, guid: string, forUpdate: boolean) => {
  const [doc] = await run<IStoredDocument>(
    `SELECT ${DOC_COLUMNS} FROM payroll_1c_payout_documents WHERE doc_guid = $1::uuid${forUpdate ? ' FOR UPDATE' : ''}`,
    [guid],
  );
  if (!doc) return null;
  const lines = await run<IStoredLine>(
    `SELECT ${LINE_COLUMNS} FROM payroll_1c_payout_lines WHERE document_id = $1 ORDER BY line_no`,
    [doc.id],
  );
  return { doc: { ...doc, id: Number(doc.id), revision: Number(doc.revision) }, lines };
};

/** Что дополнит загрузка того же содержимого: пустые поля шапки и строк. */
const enrichFields = (doc: IPayout1cDocument, stored: IStoredDocument, lines: readonly IStoredLine[]): string[] => {
  const fields: string[] = [];
  if (stored.zup2_number === null && doc.zup2Number !== null) fields.push('номер ЗУП2');
  if (stored.salary_project === null && doc.salaryProject !== null) fields.push('зарплатный проект');
  const byKey = new Map(lines.map(line => [line.line_key, line]));
  if (doc.lines.some(line => line.brigade !== null && byKey.get(line.lineKey)?.brigade_1c === null)) fields.push('бригада');
  if (doc.lines.some(line => line.personIdAll !== null && byKey.get(line.lineKey)?.person_id_all === null)) {
    fields.push('код физлица 1С');
  }
  return fields;
};

/** id_all строки в файле и в базе разный — это изменение содержимого, нужна замена. */
const idAllConflicts = (doc: IPayout1cDocument, lines: readonly IStoredLine[]): string[] => {
  const byKey = new Map(lines.map(line => [line.line_key, line]));
  return doc.lines
    .filter(line => {
      const stored = byKey.get(line.lineKey)?.person_id_all;
      return line.personIdAll !== null && stored != null && stored !== line.personIdAll;
    })
    .map(line => line.fullName);
};

const describeChanges = (doc: IPayout1cDocument, stored: IStoredDocument, lines: readonly IStoredLine[]) => {
  const incoming = headerOf(doc);
  const header: IPayoutChange[] = [];
  const compare = (field: string, before: string | null, after: string | null) => {
    if (before !== after) header.push({ field, before, after });
  };
  compare('Номер', stored.doc_number, incoming.doc_number);
  compare('Дата', stored.doc_date, incoming.doc_date);
  compare('Месяц начисления', stored.period_month, incoming.period_month);
  compare('Способ выплаты', stored.payment_method, incoming.payment_method);
  compare('Сумма документа', stored.total_amount, incoming.total_amount);
  for (const name of idAllConflicts(doc, lines)) compare(`Код физлица 1С: ${name}`, 'прежний', 'другой');
  const label = (name: string, amount: string) => `${name} — ${amount}`;
  const storedKeys = new Set(lines.map(line => line.line_key));
  const incomingKeys = new Set(doc.lines.map(line => line.lineKey));
  return {
    header,
    added: doc.lines.filter(line => !storedKeys.has(line.lineKey)).map(line => label(line.fullName, centsText(line.amountCents))),
    removed: lines.filter(line => !incomingKeys.has(line.line_key)).map(line => label(line.full_name_1c, line.amount)),
  };
};

/** Предпросмотр файла — только чтение. */
export const previewPayouts1c = async (buffer: Buffer): Promise<IPayoutPreview> => {
  const doc = parseFile(buffer);
  const [stored, matches] = await Promise.all([loadStored(viaPool, doc.guid, false), matchPayoutLines(doc)]);
  const sameContent = stored !== null && stored.doc.content_hash === doc.contentHash
    && idAllConflicts(doc, stored.lines).length === 0;
  const storedByKey = new Map((sameContent ? stored.lines : []).map(line => [line.line_key, line]));
  const enrich = stored && sameContent ? enrichFields(doc, stored.doc, stored.lines) : [];
  let status: PayoutPreviewStatus = 'new';
  if (stored) status = sameContent ? (enrich.length > 0 ? 'enrich' : 'unchanged') : 'changed';

  return {
    format: doc.format,
    document: headerOf(doc),
    status,
    expected_revision: stored?.doc.revision ?? 0,
    incoming_content_hash: doc.contentHash,
    changes: stored && !sameContent ? describeChanges(doc, stored.doc, stored.lines) : null,
    enrich_fields: enrich,
    lines: doc.lines.map(line => {
      const match = matches.get(line.lineKey) ?? { auto_employee_id: null, candidates: [] };
      const current = storedByKey.get(line.lineKey) ?? null;
      return {
        fingerprint: payoutFingerprint(doc.contentHash, line.lineKey),
        line_no: line.lineNo,
        full_name: line.fullName,
        brigade: line.brigade,
        amount: centsText(line.amountCents),
        auto_employee_id: match.auto_employee_id,
        current_employee_id: current?.employee_id ?? null,
        current_resolution: current?.resolution ?? null,
        candidates: match.candidates,
      };
    }),
  };
};

interface IFinalLine {
  lineKey: string;
  employeeId: number | null;
  resolution: PayoutResolution;
  reason: string | null;
}

/** Итоговый сотрудник каждой строки; выбор оператора проверяется по кандидатам этой строки. */
const resolveLines = (
  doc: IPayout1cDocument,
  matches: Awaited<ReturnType<typeof matchPayoutLines>>,
  storedByKey: ReadonlyMap<string, IStoredLine>,
  choices: Readonly<Record<string, number | null>>,
): IFinalLine[] => {
  const known = new Set(doc.lines.map(line => payoutFingerprint(doc.contentHash, line.lineKey)));
  for (const fingerprint of Object.keys(choices)) {
    if (!known.has(fingerprint)) throw new Payout1cImportError('Выбор не относится к строкам этого файла', 400);
  }
  return doc.lines.map(line => {
    const fingerprint = payoutFingerprint(doc.contentHash, line.lineKey);
    const match = matches.get(line.lineKey) ?? { auto_employee_id: null, candidates: [] };
    const stored = storedByKey.get(line.lineKey);
    if (Object.prototype.hasOwnProperty.call(choices, fingerprint)) {
      const choice = choices[fingerprint];
      if (choice === null) return { lineKey: line.lineKey, employeeId: null, resolution: 'unmatched', reason: 'выбрано «Без сотрудника»' };
      if (stored && stored.employee_id === choice) {
        return { lineKey: line.lineKey, employeeId: choice, resolution: stored.resolution, reason: stored.resolution_reason };
      }
      if (!match.candidates.some(candidate => candidate.employee_id === choice)) {
        throw new Payout1cImportError(`Строка ${line.lineNo}: выбранный сотрудник не подходит к этой строке`, 400);
      }
      return choice === match.auto_employee_id
        ? { lineKey: line.lineKey, employeeId: choice, resolution: 'auto_id_all', reason: 'код физлица 1С' }
        : { lineKey: line.lineKey, employeeId: choice, resolution: 'confirmed', reason: 'подтверждено оператором' };
    }
    if (stored) {
      return { lineKey: line.lineKey, employeeId: stored.employee_id, resolution: stored.resolution, reason: stored.resolution_reason };
    }
    if (match.auto_employee_id !== null) {
      return { lineKey: line.lineKey, employeeId: match.auto_employee_id, resolution: 'auto_id_all', reason: 'код физлица 1С' };
    }
    throw new Payout1cImportError(`Строка ${line.lineNo}: выберите сотрудника или «Без сотрудника»`, 400);
  });
};

const headerSnapshot = (doc: IStoredDocument) => ({
  doc_number: doc.doc_number,
  zup2_number: doc.zup2_number,
  doc_date: doc.doc_date,
  period_month: doc.period_month,
  payment_method: doc.payment_method,
  salary_project: doc.salary_project,
  organization_inn: doc.organization_inn,
  total_amount: doc.total_amount,
  content_hash: doc.content_hash,
  revision: doc.revision,
});

const insertLines = async (client: PoolClient, documentId: number, doc: IPayout1cDocument, final: readonly IFinalLine[],
  keep: ReadonlyMap<string, IStoredLine>) => {
  const byKey = new Map(final.map(line => [line.lineKey, line]));
  for (const line of doc.lines) {
    const target = byKey.get(line.lineKey) as IFinalLine;
    const previous = keep.get(line.lineKey);
    await client.query(
      `INSERT INTO payroll_1c_payout_lines
         (document_id, line_no, line_key, full_name_1c, person_id_all, brigade_1c, amount, employee_id, resolution, resolution_reason)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7::numeric, $8, $9, $10)`,
      [documentId, line.lineNo, line.lineKey, line.fullName, line.personIdAll ?? previous?.person_id_all ?? null,
        line.brigade ?? previous?.brigade_1c ?? null, centsText(line.amountCents), target.employeeId, target.resolution, target.reason],
    );
  }
};

/** Загрузка файла после предпросмотра. */
export const importPayouts1c = async (input: IPayoutImportInput): Promise<IPayoutImportResult> => {
  const doc = parseFile(input.buffer);
  if (doc.contentHash !== input.incomingContentHash) {
    throw new Payout1cImportError('Файл отличается от проверенного — проверьте заново', 400);
  }
  const fileSha = createHash('sha256').update(input.buffer).digest('hex');
  const fileName = sanitizePayoutFileName(input.fileName);

  return withTransaction(async client => {
    const run = viaClient(client);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`payroll_1c_payout:${doc.guid}`]);
    const stored = await loadStored(run, doc.guid, true);
    const revision = stored?.doc.revision ?? 0;
    if (revision !== input.expectedRevision) {
      throw new Payout1cImportError('Документ уже изменили — проверьте файл заново', 409);
    }
    const sameContent = stored !== null && stored.doc.content_hash === doc.contentHash
      && idAllConflicts(doc, stored.lines).length === 0;
    if (stored && !sameContent && !input.confirmReplace) {
      throw new Payout1cImportError('Документ в 1С изменён — подтвердите замену', 409);
    }
    const storedByKey = new Map((stored?.lines ?? []).map(line => [line.line_key, line]));
    const matches = await matchPayoutLines(doc);
    const final = resolveLines(doc, matches, sameContent ? storedByKey : new Map(), input.choices);
    const finalByKey = new Map(final.map(line => [line.lineKey, line]));

    let action: PayoutImportAction;
    let previousHeader: object | null = null;
    let previousLines: object | null = null;
    let documentId: number;
    if (!stored) {
      action = 'new';
      const [row] = await run<{ id: number }>(
        `INSERT INTO payroll_1c_payout_documents (doc_guid, doc_number, zup2_number, doc_date, period_month, payment_method,
           salary_project, organization_inn, total_amount, content_hash, revision, updated_by)
         VALUES ($1::uuid, $2, $3, $4::date, $5::date, $6, $7, $8, $9::numeric, $10, 1, $11) RETURNING id`,
        [doc.guid, doc.docNumber, doc.zup2Number, doc.docDate, doc.periodMonth, doc.paymentMethod, doc.salaryProject,
          doc.organizationInn, centsText(doc.totalCents), doc.contentHash, input.userId],
      );
      documentId = Number(row.id);
      await insertLines(client, documentId, doc, final, new Map());
    } else if (!sameContent) {
      action = 'replace';
      documentId = stored.doc.id;
      previousHeader = headerSnapshot(stored.doc);
      previousLines = stored.lines;
      await client.query(
        `UPDATE payroll_1c_payout_documents SET doc_number = $2, zup2_number = COALESCE($3, zup2_number), doc_date = $4::date,
           period_month = $5::date, payment_method = $6, salary_project = COALESCE($7, salary_project), total_amount = $8::numeric,
           content_hash = $9, revision = revision + 1, updated_at = now(), updated_by = $10
         WHERE id = $1`,
        [documentId, doc.docNumber, doc.zup2Number, doc.docDate, doc.periodMonth, doc.paymentMethod, doc.salaryProject,
          centsText(doc.totalCents), doc.contentHash, input.userId],
      );
      await client.query('DELETE FROM payroll_1c_payout_lines WHERE document_id = $1', [documentId]);
      await insertLines(client, documentId, doc, final, storedByKey);
    } else {
      documentId = stored.doc.id;
      const enrich = enrichFields(doc, stored.doc, stored.lines);
      const relinked = stored.lines.some(line => {
        const target = finalByKey.get(line.line_key) as IFinalLine;
        return target.employeeId !== line.employee_id || target.resolution !== line.resolution;
      });
      if (!relinked && enrich.length === 0) {
        return { action: 'unchanged', document_id: documentId, revision, ...countLines(final) };
      }
      action = relinked ? 'relink' : 'enrich';
      if (enrich.length > 0) previousHeader = headerSnapshot(stored.doc);
      if (relinked) previousLines = stored.lines;
      await client.query(
        `UPDATE payroll_1c_payout_documents SET zup2_number = COALESCE(zup2_number, $2), salary_project = COALESCE(salary_project, $3),
           revision = revision + 1, updated_at = now(), updated_by = $4
         WHERE id = $1`,
        [documentId, doc.zup2Number, doc.salaryProject, input.userId],
      );
      for (const line of doc.lines) {
        const target = finalByKey.get(line.lineKey) as IFinalLine;
        await client.query(
          `UPDATE payroll_1c_payout_lines SET person_id_all = COALESCE(person_id_all, $3::uuid), brigade_1c = COALESCE(brigade_1c, $4),
             employee_id = $5, resolution = $6, resolution_reason = $7
           WHERE document_id = $1 AND line_key = $2`,
          [documentId, line.lineKey, line.personIdAll, line.brigade, target.employeeId, target.resolution, target.reason],
        );
      }
    }

    const [check] = await run<{ total: string; doc_total: string; count: number }>(
      `SELECT COALESCE(sum(l.amount), 0)::text AS total, d.total_amount::text AS doc_total, count(l.*)::int AS count
         FROM payroll_1c_payout_documents d LEFT JOIN payroll_1c_payout_lines l ON l.document_id = d.id
        WHERE d.id = $1 GROUP BY d.total_amount`,
      [documentId],
    );
    if (check.total !== check.doc_total || Number(check.count) !== doc.lines.length) {
      throw new Payout1cImportError('Сумма строк не равна итогу документа — загрузка отменена', 400);
    }

    const counts = countLines(final);
    const amounts = final.reduce((acc, line) => {
      const cents = doc.lines.find(source => source.lineKey === line.lineKey)?.amountCents ?? 0;
      if (line.employeeId === null) acc.unmatched += cents;
      else acc.matched += cents;
      return acc;
    }, { matched: 0, unmatched: 0 });
    await client.query(
      `INSERT INTO payroll_1c_payout_imports (document_id, action, revision_before, revision_after, content_hash_before,
         content_hash_after, previous_header, previous_lines, source_format, file_name, file_sha256, lines_matched,
         lines_unmatched, amount_matched, amount_unmatched, imported_by)
       VALUES ($1, $2, $3, $3 + 1, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13::numeric, $14::numeric, $15)`,
      [documentId, action, revision, stored?.doc.content_hash ?? null, doc.contentHash,
        previousHeader ? JSON.stringify(previousHeader) : null, previousLines ? JSON.stringify(previousLines) : null,
        doc.format, fileName, fileSha, counts.lines_matched, counts.lines_unmatched,
        centsText(amounts.matched), centsText(amounts.unmatched), input.userId],
    );
    return { action, document_id: documentId, revision: revision + 1, ...counts };
  });
};

const countLines = (final: readonly IFinalLine[]) => ({
  lines_matched: final.filter(line => line.employeeId !== null).length,
  lines_unmatched: final.filter(line => line.employeeId === null).length,
});

export interface IEmployeePayout1c {
  /** Месяц начисления YYYY-MM. */
  month: string;
  document_id: number;
  doc_number: string;
  zup2_number: string | null;
  doc_date: string;
  payment_method: string;
  amount: string;
}

/** «Перечислено (1С)» сотрудника за месяцы начисления from..to (YYYY-MM). */
export const listEmployeePayouts1c = async (employeeId: number, from: string, to: string): Promise<IEmployeePayout1c[]> => {
  const rows = await query<IEmployeePayout1c & { line_no: number }>(
    `SELECT to_char(d.period_month, 'YYYY-MM') AS month, d.id AS document_id, d.doc_number, d.zup2_number,
            d.doc_date::text AS doc_date, d.payment_method, l.amount::text AS amount, l.line_no
       FROM payroll_1c_payout_lines l
       JOIN payroll_1c_payout_documents d ON d.id = l.document_id
      WHERE l.employee_id = $1 AND d.period_month BETWEEN ($2 || '-01')::date AND ($3 || '-01')::date
      ORDER BY d.period_month, d.doc_date, d.doc_number, l.line_no`,
    [employeeId, from, to],
  );
  return rows.map(({ line_no: _lineNo, ...row }) => ({ ...row, document_id: Number(row.document_id) }));
};
