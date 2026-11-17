/**
 * Несколько выгрузок ведомостей ЗУП за месяц одним набором (build-payouts-xml-sql.ts, --file повторяемый) и сверка
 * набора с уже загруженным в «Перечислено (1С)». Чистые функции — тестируются без БД.
 *
 * Набор (parseXmlFiles):
 *  - повтор пути файла, повтор номера в --move-doc — ошибка;
 *  - ГУИД и «номер + дата» не повторяются между файлами; одна организация (ИНН) на запуск;
 *  - перенос месяца (--move-doc): каждый номер списка встретился ровно один раз во всех файлах; неиспользованный —
 *    ошибка. Чужой месяц вне списка и документ списка, уже проведённый целевым месяцем, отвергает разбор файла.
 *
 * Уже в БД (classifyStored):
 *  - тот же ГУИД, хеш, ИНН и месяц → «уже загружена»;
 *  - тот же ГУИД, хеш и ИНН, но в другом месяце, и у всех сохранённых строк маркер переноса (moveMarker) →
 *    «уже перенесена» (already_moved) — так её встретит выгрузка своего месяца;
 *  - любое другое расхождение, в том числе «номер + дата» под другим ГУИДом, — ошибка.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { parsePayout1cMonthXml, type IPayout1cMonthDocument } from '../../src/services/payroll/payroll-1c-payouts.month-xml.js';
import type { IPayout1cLine } from '../../src/services/payroll/payroll-1c-payouts.parser.js';
import { DECISION_LABELS, type IDecision } from './payouts-person-decision.js';
import type { IRegisterSqlLine } from './payouts-register-sql.js';

export interface IXmlSourceFile {
  /** Путь как передан. */
  path: string;
  name: string;
  sha256: string;
  documents: number;
}

export type IXmlSetDocument = IPayout1cMonthDocument & { sourceFile: string };

export interface IXmlSet {
  sources: IXmlSourceFile[];
  documents: IXmlSetDocument[];
  /** Перенесённые решением пользователя (--move-doc), в порядке файлов. */
  moved: IXmlSetDocument[];
  organizationInn: string;
}

/** ММ.ГГГГ из первого числа месяца. */
export const monthLabelOf = (periodMonth: string): string => `${periodMonth.slice(5, 7)}.${periodMonth.slice(0, 4)}`;

/** Общая часть маркера переноса — для отбора перенесённых строк в SQL. */
export const MOVE_MARK = 'ведомость 1С за ';

/** Маркер в причине строк ведомости, перенесённой из месяца 1С в другой месяц решением пользователя. */
export const moveMarker = (sourcePeriodMonth: string, targetPeriodMonth: string): string => (
  `${MOVE_MARK}${monthLabelOf(sourcePeriodMonth)} — в ${monthLabelOf(targetPeriodMonth)} по решению пользователя`
);

/** Файлы → один набор документов месяца; нарушение правил набора — ошибка (все нарушения сразу). */
export const parseXmlFiles = (
  files: ReadonlyArray<{ path: string; content: Buffer }>, month: string, moveDocs: readonly string[],
): IXmlSet => {
  if (files.length === 0) throw new Error('Нужен хотя бы один --file');
  const seenPaths = new Set<string>();
  for (const file of files) {
    const resolved = path.resolve(file.path);
    if (seenPaths.has(resolved)) throw new Error(`--file «${file.path}» указан дважды`);
    seenPaths.add(resolved);
  }
  const requested = new Set<string>();
  for (const number of moveDocs) {
    if (requested.has(number)) throw new Error(`--move-doc «${number}» указан дважды`);
    requested.add(number);
  }

  const sources: IXmlSourceFile[] = [];
  const documents: IXmlSetDocument[] = [];
  for (const file of files) {
    const name = path.basename(file.path);
    let parsed: IPayout1cMonthDocument[];
    try {
      parsed = parsePayout1cMonthXml(file.content.toString('utf8'), month, { moveDocs: requested });
    } catch (err) {
      throw new Error(`«${name}»: ${err instanceof Error ? err.message : String(err)}`);
    }
    sources.push({ path: file.path, name, sha256: createHash('sha256').update(file.content).digest('hex'), documents: parsed.length });
    documents.push(...parsed.map(doc => ({ ...doc, sourceFile: name })));
  }

  const problems: string[] = [];
  const byGuid = new Map<string, IXmlSetDocument>();
  const byNumber = new Map<string, IXmlSetDocument>();
  for (const doc of documents) {
    const sameGuid = byGuid.get(doc.guid);
    if (sameGuid) problems.push(`ГУИД ${doc.guid} — в «${sameGuid.sourceFile}» и «${doc.sourceFile}»`);
    const numberKey = `${doc.docNumber}|${doc.docDate}`;
    const sameNumber = byNumber.get(numberKey);
    if (sameNumber) problems.push(`${doc.docNumber} от ${doc.docDate} — в «${sameNumber.sourceFile}» и «${doc.sourceFile}»`);
    byGuid.set(doc.guid, doc);
    byNumber.set(numberKey, doc);
  }
  const inns = [...new Set(documents.map(doc => doc.organizationInn))];
  if (inns.length > 1) problems.push(`ведомости разных организаций (ИНН ${inns.join(', ')}) — по одной на запуск`);

  const moved = documents.filter(doc => doc.sourcePeriodMonth !== null);
  const usedCount = new Map<string, number>();
  for (const doc of moved) usedCount.set(doc.docNumber, (usedCount.get(doc.docNumber) ?? 0) + 1);
  for (const [number, count] of usedCount) if (count > 1) problems.push(`--move-doc «${number}»: ведомость встретилась ${count} раза`);
  const unused = [...requested].filter(number => !usedCount.has(number));
  if (unused.length > 0) problems.push(`--move-doc не использован — таких ведомостей в файлах нет: ${unused.join(', ')}`);

  if (problems.length > 0) throw new Error(`Набор файлов не принят:\n  ${problems.join('\n  ')}`);
  return { sources, documents, moved, organizationInn: inns[0] };
};

/** Документ «Перечислено (1С)» в БД для сверки с набором. */
export interface IStoredPayoutDoc {
  doc_guid: string;
  doc_number: string;
  doc_date: string;
  content_hash: string;
  period_month: string;
  organization_inn: string;
  /** Причины сопоставления всех строк документа. */
  reasons: string[];
}

export type StoredStatus = 'new' | 'loaded' | 'already_moved';

/** Состояние документа набора относительно БД; problem — почему грузить нельзя. */
export const classifyStored = (
  doc: Pick<IPayout1cMonthDocument, 'guid' | 'docNumber' | 'docDate' | 'contentHash' | 'periodMonth' | 'organizationInn' | 'sourcePeriodMonth'>,
  stored: readonly IStoredPayoutDoc[],
): { status: StoredStatus; storedMonth?: string; problem?: string } => {
  const where = `${doc.docNumber} от ${doc.docDate}`;
  if (stored.some(row => row.doc_number === doc.docNumber && row.doc_date === doc.docDate && row.doc_guid !== doc.guid)) {
    return { status: 'new', problem: `${where} уже загружена под другим ГУИДом` };
  }
  const row = stored.find(item => item.doc_guid === doc.guid);
  if (!row) return { status: 'new' };
  if (row.organization_inn !== doc.organizationInn) {
    return { status: 'new', problem: `${where}: в БД другая организация (ИНН ${row.organization_inn})` };
  }
  if (row.content_hash !== doc.contentHash) return { status: 'new', problem: `${where}: в БД другое содержимое (хеш)` };
  if (row.period_month === doc.periodMonth) return { status: 'loaded' };
  // Месяц 1С этой ведомости — исходный при переносе, иначе месяц набора.
  const marker = moveMarker(doc.sourcePeriodMonth ?? doc.periodMonth, row.period_month);
  if (row.reasons.length > 0 && row.reasons.every(reason => reason.includes(marker))) {
    return { status: 'already_moved', storedMonth: row.period_month };
  }
  return { status: 'new', problem: `${where}: в БД за ${monthLabelOf(row.period_month)} без отметки переноса` };
};

const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Имена результатов генератора; --tag — только латиница, цифры, дефис (не путь). */
export const outputNames = (month: string, tag: string | null, replaceSlug: string | null, replaceMethod: string | null): {
  base: string; report: string;
} => {
  if (tag !== null && !TAG_RE.test(tag)) throw new Error(`--tag «${tag}»: только a-z, 0-9 и дефис, с буквы или цифры`);
  const suffix = `${tag ? `-${tag}` : ''}${replaceSlug ? `-replace-${replaceSlug}` : ''}`;
  return {
    base: `payroll-1c-payouts-${month}${suffix}`,
    report: `Перечислено_1С_${month}${tag ? `_${tag}` : ''}${replaceMethod ? `_замена_${replaceMethod}` : ''}_сверка.xlsx`,
  };
};

/**
 * Строки SQL набора: сотрудник и вид решения — decisionOf (в том числе ручные решения пользователя), причина —
 * «<prefix>: <решение>», у перенесённой ведомости — ещё маркер переноса. Поле длиннее 300 — ошибка (CHECK 328).
 */
export const buildXmlSqlLines = (
  documents: readonly IXmlSetDocument[],
  decisionOf: (line: IPayout1cLine) => IDecision,
  employeeNameOf: (employeeId: number) => string | null,
  prefix: string,
): IRegisterSqlLine[] => documents.flatMap(doc => doc.lines.map((line): IRegisterSqlLine => {
  const decision = decisionOf(line);
  const label = DECISION_LABELS.find(([kind]) => kind === decision.kind)?.[1] ?? decision.kind;
  const reason = `${prefix}: ${label}${doc.sourcePeriodMonth === null ? '' : `; ${moveMarker(doc.sourcePeriodMonth, doc.periodMonth)}`}`;
  if (line.fullName.length > 300 || reason.length > 300) throw new Error(`Слишком длинное поле строки: ${line.fullName}`);
  return {
    guid: doc.guid,
    lineNo: line.lineNo,
    lineKey: line.lineKey,
    fullName: line.fullName,
    department: null,
    amountCents: line.amountCents,
    employeeId: decision.employeeId,
    employeeName: decision.employeeId === null ? null : employeeNameOf(decision.employeeId),
    resolution: decision.employeeId === null ? 'unmatched' : 'confirmed',
    reason,
    personIdAll: line.personIdAll,
  };
}));
