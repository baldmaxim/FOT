/**
 * Выгрузка ведомостей выплаты ЗУП2 за месяц («выплаченная ЗП за …», корень `зп_документы_31`, много документов) — для
 * разовой загрузки в «Перечислено (1С)» (scripts/build-payouts-xml-sql.ts). Кнопка «Загрузить из 1С»
 * (payroll-1c-payouts.parser.ts) берёт один документ без разделов руководства, отпусков и оснований; здесь они есть:
 *  - «Зарплата_руководство» — строки руководства. В «Зарплате» их сумма повторена строкой «00000» без ФИО: это дубль,
 *    не строка. Проверяется: Σ «00000» = Σ руководства и СуммаПоДокументу = строки + «00000». Итог документа — строки.
 *  - «отпуска» (средний заработок по отпускам, повтор сумм строк) и «Основания» (ссылки на документы) — справочные,
 *    с ПДн: не читаются. «Состав» должен быть пустым.
 * Ключи строк и content_hash — те же функции, что у кнопки: тот же документ даёт тот же хеш.
 * Fail-closed: неизвестный раздел, чужой ИНН, другой месяц, повтор ГУИДа или номера с датой — ошибка. Персональные
 * данные (паспорт, ИНН, СНИЛС, гражданство, дата рождения) не извлекаются.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  buildPayoutLineKeys,
  parseAmountCents,
  payoutContentHash,
  PAYOUTS_1C_ORGANIZATION_INN,
  Payout1cParseError,
  type IPayout1cDocument,
} from './payroll-1c-payouts.parser.js';

const ROOT = 'зп_документы_31';
const ROOT_NAME = 'ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР';
/** Виды документа: в банк (зарплатный проект) и перечислением на счета. */
export const PAYOUT_MONTH_DOC_KINDS = ['ВедомостьНаВыплатуЗарплатыВБанк', 'ВедомостьНаВыплатуЗарплатыПеречислением'] as const;
const DUPLICATE_CODE = '00000';

const DOC_TAGS = new Set([
  'имя_док', 'организация_инн', 'организация_имя', 'Док_Гуид', 'ЗП_Проект_Рабочие', 'ЗП_Проект', 'Док_Номер', 'Док_Дата',
  'ПериодРегистрации', 'Подразделение', 'СтатьяФинансирования', 'ЗарплатныйПроект', 'НомерРеестра', 'СтатьяРасходов',
  'СпособВыплаты', 'Округление', 'ПроцентВыплаты', 'СуммаПоДокументу', 'Руководитель', 'ДолжностьРуководителя',
  'ГлавныйБухгалтер', 'Бухгалтер', 'ПеречислениеНДФЛВыполнено', 'ПеречислениеНДФЛРеквизиты', 'ВводНачальныхДанных',
  'КраткийСоставДокумента', 'Комментарий', 'Состав', 'Зарплата', 'Зарплата_руководство', 'отпуска', 'Основания',
  'ФизическиеЛица',
]);
const SECTIONS = ['Зарплата', 'Зарплата_руководство'] as const;

const ARRAY_PATHS = new Set([
  `${ROOT}.ЗарплатаКВыплатеОрганизаций.документ`,
  ...SECTIONS.map(section => `${ROOT}.ЗарплатаКВыплатеОрганизаций.документ.${section}.расшифровка`),
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type XmlNode = Record<string, unknown>;

export interface IPayout1cMonthDocument extends IPayout1cDocument {
  docKind: string;
  /** СуммаПоДокументу из файла — с дублем руководства. */
  fileTotalCents: number;
  /** Строки «00000» без ФИО (= Σ руководства). */
  duplicateCents: number;
  leadershipLines: number;
}

export const fail = (message: string): never => {
  throw new Payout1cParseError(message);
};

export const isNode = (value: unknown): value is XmlNode => typeof value === 'object' && value !== null && !Array.isArray(value);

export const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.every(isEmpty);
  if (isNode(value)) return Object.values(value).every(isEmpty);
  return String(value).trim() === '';
};

export const text = (node: XmlNode, tag: string, where: string, required = true): string | null => {
  const value = node[tag];
  if (Array.isArray(value)) fail(`${where}: тег «${tag}» повторяется`);
  if (isNode(value)) fail(`${where}: «${tag}» — не значение`);
  const result = value === undefined || value === null ? '' : String(value).trim();
  if (result === '' && required) fail(`${where}: нет «${tag}»`);
  return result === '' ? null : result;
};

export const child = (node: XmlNode, tag: string, where: string): XmlNode => {
  const value = node[tag];
  if (!isNode(value)) fail(`${where}: нет раздела «${tag}»`);
  return value as XmlNode;
};

export const listOf = (value: unknown): XmlNode[] => {
  if (value === undefined || value === '') return [];
  if (!Array.isArray(value)) return isNode(value) ? [value] : [];
  return value.filter(isNode);
};

export const assertKnownTags = (node: XmlNode, known: ReadonlySet<string>, where: string): void => {
  for (const tag of Object.keys(node)) if (!known.has(tag)) fail(`${where}: неизвестный раздел «${tag}»`);
};

export const isoDate = (node: XmlNode, tag: string, where: string): string => {
  const part = child(node, tag, where);
  const [year, month, day] = ['Год', 'Мес', 'День'].map(key => Number(text(part, key, `${where}, «${tag}»`)));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (![year, month, day].every(Number.isInteger) || year < 2000 || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`${where}: «${tag}» — не дата`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const guid = (raw: string, where: string): string => {
  const value = raw.toLowerCase();
  if (!UUID_RE.test(value)) fail(`${where}: ГУИД «${raw}» не распознан`);
  return value;
};

interface IRawLine { fullName: string; personIdAll: string | null; brigade: null; amountCents: number }

/** Строки раздела: именные — строки; «00000» без ФИО (только в «Зарплате») — сумма дубля. */
const sectionLines = (doc: XmlNode, section: (typeof SECTIONS)[number], at: string): { lines: IRawLine[]; duplicate: number } => {
  const lines: IRawLine[] = [];
  let duplicate = 0;
  const node = doc[section] === undefined || doc[section] === '' ? {} : child(doc, section, at);
  assertKnownTags(node, new Set(['расшифровка']), `${at}, «${section}»`);
  for (const [index, entry] of listOf(node.расшифровка).entries()) {
    const where = `${at}, «${section}», строка ${index + 1}`;
    assertKnownTags(entry, new Set(['ФизЛицо', 'КВыплате']), where);
    const person = child(entry, 'ФизЛицо', where);
    const name = text(person, 'наименование', where, false);
    const amount = parseAmountCents(text(entry, 'КВыплате', where, false) ?? '0', where);
    if (name === null) {
      if (section !== 'Зарплата' || text(person, 'код', where, false) !== DUPLICATE_CODE || Object.keys(person).length !== 1) {
        fail(`${where}: строка без ФИО — не «${DUPLICATE_CODE}»`);
      }
      duplicate += amount;
      continue;
    }
    if (amount <= 0) fail(`${where}: сумма должна быть больше нуля`);
    const idAll = text(person, 'id_all', where, false);
    lines.push({ fullName: name, personIdAll: idAll === null ? null : guid(idAll, where), brigade: null, amountCents: amount });
  }
  return { lines, duplicate };
};

const parseDocument = (doc: XmlNode, index: number, month: string): IPayout1cMonthDocument => {
  const at = `Документ ${index + 1}`;
  assertKnownTags(doc, DOC_TAGS, at);
  const docKind = text(doc, 'имя_док', at) as string;
  if (!(PAYOUT_MONTH_DOC_KINDS as readonly string[]).includes(docKind)) fail(`${at}: вид «${docKind}» не поддержан`);
  const inn = text(doc, 'организация_инн', at) as string;
  if (inn !== PAYOUTS_1C_ORGANIZATION_INN) fail(`${at}: ведомость другой организации (ИНН ${inn})`);
  if (!isEmpty(doc.Состав)) fail(`${at}: раздел «Состав» не пустой — формат не поддержан`);
  const docNumber = text(doc, 'Док_Номер', at) as string;
  const where = `${at} (${docNumber})`;
  const periodMonth = isoDate(doc, 'ПериодРегистрации', where);
  if (periodMonth !== `${month}-01`) fail(`${where}: месяц начисления ${periodMonth}, ожидался ${month}`);

  const salary = sectionLines(doc, 'Зарплата', where);
  const leadership = sectionLines(doc, 'Зарплата_руководство', where);
  const rawLines = [...salary.lines, ...leadership.lines];
  if (rawLines.length === 0) fail(`${where}: нет строк`);
  const leadershipCents = leadership.lines.reduce((sum, line) => sum + line.amountCents, 0);
  if (salary.duplicate !== leadershipCents) {
    fail(`${where}: строки «${DUPLICATE_CODE}» (${salary.duplicate / 100}) ≠ сумме руководства (${leadershipCents / 100})`);
  }
  const totalCents = rawLines.reduce((sum, line) => sum + line.amountCents, 0);
  const fileTotalCents = parseAmountCents(text(doc, 'СуммаПоДокументу', where) as string, where);
  if (fileTotalCents !== totalCents + salary.duplicate) {
    fail(`${where}: СуммаПоДокументу ${fileTotalCents / 100} ≠ строки ${totalCents / 100} + «${DUPLICATE_CODE}» ${salary.duplicate / 100}`);
  }

  const keys = buildPayoutLineKeys(rawLines);
  const lines = rawLines.map((line, i) => ({ ...line, lineNo: i + 1, lineKey: keys[i] }));
  const header = {
    format: 'zup2' as const,
    guid: guid(text(doc, 'Док_Гуид', where) as string, where),
    docNumber,
    zup2Number: null,
    docDate: isoDate(doc, 'Док_Дата', where),
    periodMonth,
    paymentMethod: text(doc, 'СпособВыплаты', where) as string,
    salaryProject: text(doc, 'ЗарплатныйПроект', where, false),
    organizationInn: inn,
    totalCents,
  };
  return {
    ...header,
    lines,
    contentHash: payoutContentHash({ ...header, lineKeys: keys }),
    docKind,
    fileTotalCents,
    duplicateCents: salary.duplicate,
    leadershipLines: leadership.lines.length,
  };
};

/**
 * Дерево выгрузки ЗУП (`зп_документы_31`): без DOCTYPE/ENTITY, значения строками, массивы — пути arrayPaths. Общий
 * разбор с реестром ФСС (payroll-fss.parser.ts).
 */
export const parseZupXmlTree = (xml: string, arrayPaths: ReadonlySet<string>): XmlNode => {
  const source = xml.replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('Файл с DOCTYPE или ENTITY не принимается');
  const validation = XMLValidator.validate(source);
  if (validation !== true) fail(`Файл не XML: ${validation.err.msg} (строка ${validation.err.line})`);
  const tree = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    isArray: (_name: string, jpath: unknown) => arrayPaths.has(String(jpath)),
  }).parse(source) as XmlNode;
  if (Object.keys(tree).length !== 1 || !isNode(tree[ROOT])) fail(`Нужен один корень «${ROOT}»`);
  return tree[ROOT] as XmlNode;
};

/** Разбор выгрузки ведомостей выплаты за месяц month (YYYY-MM). Ошибка формата — Payout1cParseError. */
export const parsePayout1cMonthXml = (xml: string, month: string): IPayout1cMonthDocument[] => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`Месяц «${month}» — не YYYY-MM`);
  const root = parseZupXmlTree(xml, ARRAY_PATHS);
  assertKnownTags(root, new Set(['имя', 'версия', 'ЗарплатаКВыплатеОрганизаций']), 'Файл');
  if (text(root, 'имя', 'Файл') !== ROOT_NAME) fail('Файл: не выгрузка ведомостей выплаты («имя»)');
  const container = child(root, 'ЗарплатаКВыплатеОрганизаций', 'Файл');
  assertKnownTags(container, new Set(['документ']), 'Файл');
  const docs = listOf(container.документ).map((doc, index) => parseDocument(doc, index, month));
  if (docs.length === 0) fail('В файле нет документов');

  const guids = new Set<string>();
  const numbers = new Set<string>();
  for (const doc of docs) {
    if (guids.has(doc.guid)) fail(`ГУИД ${doc.guid} повторяется`);
    const key = `${doc.docNumber}|${doc.docDate}`;
    if (numbers.has(key)) fail(`Ведомость ${doc.docNumber} от ${doc.docDate} повторяется`);
    guids.add(doc.guid);
    numbers.add(key);
  }
  return docs;
};
