/**
 * Режим --replace генератора build-payouts-register-sql.ts: снимок «Перечислено (1С)» за месяц с прода (from) и
 * новый набор месяца из файла (to) для buildRegisterReplaceSql.
 *
 * Снимок читается одним REPEATABLE READ READ ONLY (withReadOnlySnapshot) и обязан быть в форме загрузки этим
 * генератором: revision 1, журнала нет, ЗУП2-номера, зарплатного проекта, updated_by, id_all нет; строки сходятся
 * с шапками. Иначе — ошибка: заменять можно только то, что сами загрузили и никто не менял.
 *
 * Оставляемый документ (тот же ГУИД и хеш) в to берётся из снимка как есть — те же line_no, сотрудники, причины.
 * Жёсткие стопы: строки файла оставляемого документа обязаны совпасть со снимком, включая сопоставление; у
 * добавленного документа пара «ФИО + подразделение», уже бывшая в снимке, обязана получить прежнего сотрудника.
 */
import type { PoolClient } from 'pg';

import { normalizePayoutName, PAYOUTS_1C_ORGANIZATION_INN } from '../../src/services/payroll/payroll-1c-payouts.parser.js';
import type { IRegisterSqlDocument, IRegisterSqlInput, IRegisterSqlLine } from './payouts-register-sql.js';

export interface ISnapshotDocRow {
  doc_guid: string;
  doc_number: string;
  zup2_number: string | null;
  doc_date: string;
  period_month: string;
  payment_method: string;
  salary_project: string | null;
  organization_inn: string;
  total_amount: string;
  content_hash: string;
  revision: number;
  updated_by: string | null;
  has_journal: boolean;
}

export interface ISnapshotLineRow {
  doc_guid: string;
  line_no: number;
  line_key: string;
  full_name_1c: string;
  person_id_all: string | null;
  brigade_1c: string | null;
  amount: string;
  employee_id: number | null;
  /** employees.full_name в том же снимке. */
  employee_name: string | null;
  resolution: string;
  resolution_reason: string | null;
}

export interface IMonthSnapshot {
  docs: ISnapshotDocRow[];
  lines: ISnapshotLineRow[];
}

/** Документы и строки месяца одним снимком (client — из withReadOnlySnapshot). */
export const loadMonthSnapshot = async (client: PoolClient, periodMonth: string): Promise<IMonthSnapshot> => {
  const docs = await client.query<ISnapshotDocRow>(
    `SELECT d.doc_guid::text AS doc_guid, d.doc_number, d.zup2_number, d.doc_date::text AS doc_date,
            d.period_month::text AS period_month, d.payment_method, d.salary_project, d.organization_inn,
            d.total_amount::text AS total_amount, d.content_hash, d.revision, d.updated_by::text AS updated_by,
            EXISTS (SELECT 1 FROM payroll_1c_payout_imports i WHERE i.document_id = d.id) AS has_journal
       FROM payroll_1c_payout_documents d
      WHERE d.period_month = $1::date
      ORDER BY d.doc_date, d.doc_number`,
    [periodMonth],
  );
  const lines = await client.query<ISnapshotLineRow>(
    `SELECT d.doc_guid::text AS doc_guid, l.line_no, l.line_key, l.full_name_1c, l.person_id_all::text AS person_id_all,
            l.brigade_1c, l.amount::text AS amount, l.employee_id, e.full_name AS employee_name, l.resolution,
            l.resolution_reason
       FROM payroll_1c_payout_lines l
       JOIN payroll_1c_payout_documents d ON d.id = l.document_id
       LEFT JOIN employees e ON e.id = l.employee_id
      WHERE d.period_month = $1::date
      ORDER BY d.doc_date, d.doc_number, l.line_no`,
    [periodMonth],
  );
  return { docs: docs.rows, lines: lines.rows };
};

/** NUMERIC(12,2) текстом → копейки; другой формат — ошибка. */
const cents = (amount: string, where: string): number => {
  if (!/^\d{1,10}\.\d{2}$/.test(amount)) throw new Error(`${where}: сумма «${amount}» не NUMERIC(12,2)`);
  return Math.round(Number(amount) * 100);
};

const fail = (problems: readonly string[], title: string): void => {
  if (problems.length > 0) {
    throw new Error(`${title} (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}`
      + `${problems.length > 20 ? '\n  …' : ''}`);
  }
};

/** Снимок → набор from; не форма загрузки генератором или строки не сходятся с шапками — ошибка. */
export const snapshotToInput = (
  snapshot: IMonthSnapshot, periodMonth: string, lockKeyOf: (docNumber: string, docDate: string) => string,
): IRegisterSqlInput => {
  const problems: string[] = [];
  const linesByGuid = new Map<string, ISnapshotLineRow[]>();
  for (const line of snapshot.lines) linesByGuid.set(line.doc_guid, [...(linesByGuid.get(line.doc_guid) ?? []), line]);
  const documents = snapshot.docs.map((doc): IRegisterSqlDocument => {
    const where = `${doc.doc_number} от ${doc.doc_date}`;
    if (doc.period_month !== periodMonth) problems.push(`${where}: месяц ${doc.period_month}`);
    if (doc.revision !== 1) problems.push(`${where}: revision ${doc.revision}`);
    if (doc.has_journal) problems.push(`${where}: есть записи в журнале загрузок`);
    if (doc.zup2_number !== null || doc.salary_project !== null || doc.updated_by !== null) {
      problems.push(`${where}: заполнены ЗУП2-номер, зарплатный проект или updated_by — загружен не этим скриптом`);
    }
    if (doc.organization_inn !== PAYOUTS_1C_ORGANIZATION_INN) problems.push(`${where}: ИНН ${doc.organization_inn}`);
    const docLines = linesByGuid.get(doc.doc_guid) ?? [];
    const totalCents = cents(doc.total_amount, where);
    const linesCents = docLines.reduce((sum, line) => sum + cents(line.amount, where), 0);
    if (docLines.length === 0 || linesCents !== totalCents) {
      problems.push(`${where}: строк ${docLines.length} на ${linesCents / 100}, в шапке ${totalCents / 100}`);
    }
    return {
      guid: doc.doc_guid,
      docNumber: doc.doc_number,
      docDate: doc.doc_date,
      periodMonth: doc.period_month,
      paymentMethod: doc.payment_method,
      totalCents,
      contentHash: doc.content_hash,
      lineCount: docLines.length,
      lockKey: lockKeyOf(doc.doc_number, doc.doc_date),
    };
  });
  const guids = new Set(snapshot.docs.map(doc => doc.doc_guid));
  const lines = snapshot.lines.map((line): IRegisterSqlLine => {
    const where = `${line.doc_guid} строка ${line.line_no}`;
    if (!guids.has(line.doc_guid)) problems.push(`${where}: строка без документа`);
    if (line.person_id_all !== null) problems.push(`${where}: заполнен id_all — загружено из XML`);
    if (line.resolution !== 'confirmed' && line.resolution !== 'unmatched') problems.push(`${where}: resolution ${line.resolution}`);
    if (!line.resolution_reason?.trim()) problems.push(`${where}: нет причины сопоставления`);
    if ((line.employee_id === null) !== (line.resolution === 'unmatched')) problems.push(`${where}: сотрудник ≠ resolution`);
    if (line.employee_id !== null && line.employee_name === null) problems.push(`${where}: сотрудник ${line.employee_id} не найден`);
    return {
      guid: line.doc_guid,
      lineNo: line.line_no,
      lineKey: line.line_key,
      fullName: line.full_name_1c,
      department: line.brigade_1c,
      amountCents: cents(line.amount, where),
      employeeId: line.employee_id,
      employeeName: line.employee_name,
      resolution: line.resolution === 'unmatched' ? 'unmatched' : 'confirmed',
      reason: line.resolution_reason ?? '',
    };
  });
  fail(problems, 'Снимок месяца на проде не в форме загрузки генератором');
  return { header: [], documents, lines };
};

export interface IReplaceTarget {
  /** Новый набор месяца: документы файла, строки оставляемых — из снимка. */
  to: IRegisterSqlInput;
  kept: IRegisterSqlDocument[];
  removed: IRegisterSqlDocument[];
  added: IRegisterSqlDocument[];
}

const docKey = (doc: IRegisterSqlDocument): string => `${doc.guid}|${doc.contentHash}`;
const linePairKey = (line: IRegisterSqlLine): string => `${normalizePayoutName(line.fullName)}|${(line.department ?? '').trim()}`;
/** Чем строки файла оставляемого документа отличаются от загруженных (без ФИО): «строка 19: сотрудник 8732 → 9999». */
const lineDiffs = (saved: readonly IRegisterSqlLine[], own: readonly IRegisterSqlLine[]): string[] => {
  if (saved.length !== own.length) return [`строк в файле ${own.length}, загружено ${saved.length}`];
  const fields: Array<[string, (line: IRegisterSqlLine) => unknown]> = [
    ['номер строки', line => line.lineNo],
    ['ФИО или сумма', line => line.lineKey],
    ['написание ФИО', line => line.fullName],
    ['подразделение', line => line.department],
    ['сотрудник', line => line.employeeId ?? '—'],
  ];
  return saved.flatMap((line, index) => fields
    .filter(([, value]) => value(line) !== value(own[index]))
    .map(([name, value]) => (name === 'сотрудник'
      ? `строка ${line.lineNo}: сотрудник ${String(value(line))} → ${String(value(own[index]))}`
      : `строка ${line.lineNo}: ${name}`)));
};

/** Набор to из документов и строк файла (с решениями) и снимка from; расхождение со снимком — ошибка. */
export const buildReplaceTarget = (
  from: IRegisterSqlInput, fileDocs: readonly IRegisterSqlDocument[], fileLines: readonly IRegisterSqlLine[],
): IReplaceTarget => {
  const fromKeys = new Set(from.documents.map(docKey));
  const fileKeys = new Set(fileDocs.map(docKey));
  const fromLines = new Map<string, IRegisterSqlLine[]>();
  for (const line of from.lines) fromLines.set(line.guid, [...(fromLines.get(line.guid) ?? []), line]);
  const fileLinesByGuid = new Map<string, IRegisterSqlLine[]>();
  for (const line of fileLines) fileLinesByGuid.set(line.guid, [...(fileLinesByGuid.get(line.guid) ?? []), line]);
  const fromDecisions = new Map<string, Set<number | null>>();
  for (const line of from.lines) {
    const key = linePairKey(line);
    fromDecisions.set(key, new Set([...(fromDecisions.get(key) ?? []), line.employeeId]));
  }

  const problems: string[] = [];
  const lines: IRegisterSqlLine[] = [];
  for (const doc of fileDocs) {
    const own = fileLinesByGuid.get(doc.guid) ?? [];
    if (fromKeys.has(docKey(doc))) {
      const saved = [...(fromLines.get(doc.guid) ?? [])].sort((a, b) => a.lineNo - b.lineNo);
      const diffs = lineDiffs(saved, [...own].sort((a, b) => a.lineNo - b.lineNo));
      if (diffs.length > 0) {
        problems.push(`${doc.docNumber} от ${doc.docDate}: строки или сопоставление файла ≠ загруженным — ${diffs.join('; ')}`);
      }
      lines.push(...saved);
      continue;
    }
    for (const line of own) {
      const before = fromDecisions.get(linePairKey(line));
      if (before && (before.size !== 1 || !before.has(line.employeeId))) {
        problems.push(`${doc.docNumber} от ${doc.docDate}, ${line.fullName}: сотрудник ${line.employeeId ?? '—'},`
          + ` в загрузке — ${[...before].map(id => id ?? '—').join(', ')}`);
      }
    }
    lines.push(...own);
  }
  fail(problems, 'Решения не совпали с загруженными — сверить и решить до замены');
  return {
    to: { header: [], documents: [...fileDocs], lines },
    kept: fileDocs.filter(doc => fromKeys.has(docKey(doc))),
    removed: from.documents.filter(doc => !fileKeys.has(docKey(doc))),
    added: fileDocs.filter(doc => !fromKeys.has(docKey(doc))),
  };
};
