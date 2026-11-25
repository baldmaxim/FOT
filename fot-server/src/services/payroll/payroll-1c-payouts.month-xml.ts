/**
 * Выгрузка ведомостей выплаты ЗУП2 за месяц («выплаченная ЗП за …», корень `зп_документы_31`, много документов) — для
 * разовой загрузки в «Перечислено (1С)» (scripts/build-payouts-xml-sql.ts). Кнопка «Загрузить из 1С»
 * (payroll-1c-payouts.parser.ts) берёт один документ без разделов руководства, отпусков и оснований; здесь они есть:
 *  - «Зарплата_руководство» — строки руководства. В «Зарплате» их сумма повторена строкой «00000» без ФИО: это дубль,
 *    не строка. Проверяется: Σ «00000» = Σ руководства и СуммаПоДокументу = строки + «00000». Итог документа — строки.
 *  - «отпуска» (средний заработок по отпускам, повтор сумм строк) и «Основания» (ссылки на документы) — справочные,
 *    с ПДн: не читаются. «Состав» должен быть пустым.
 * Ключи строк и content_hash — те же функции, что у кнопки: тот же документ даёт тот же хеш.
 * Fail-closed: неизвестный раздел, ИНН не из PAYOUT_XML_ORGANIZATION_INNS, другой месяц, повтор ГУИДа или номера с датой —
 * ошибка. Персональные данные (паспорт, ИНН, СНИЛС, гражданство, дата рождения) не извлекаются.
 *
 * Перенос месяца (moveDocs, решение пользователя): ведомость из списка, которую 1С провела другим месяцем, грузится в
 * month; content_hash — по исходному документу 1С (с его ПериодРегистрации), как у кнопки, исходный месяц —
 * sourcePeriodMonth. Ведомость из списка уже за month — ошибка. Полноту списка по всем файлам проверяет генератор.
 *
 * API (parsePayout1cApiXml, POST /api/public/v1/payroll/payouts): тот же формат, месяц у каждой ведомости — свой
 * ПериодРегистрации; дополнительно читаются «Док_Версия» (номер изменения в очереди 1С), «Комментарий» документа,
 * «ФизЛицо/ID_FOT» и «Основание» строки. Генератор эти теги принимает и не использует.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  buildPayoutLineKeys,
  parseAmountCents,
  PAYOUT_XML_ORGANIZATION_INNS,
  payoutContentHash,
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
  'ФизическиеЛица', 'Док_Версия',
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
  /** ПериодРегистрации 1С, если ведомость перенесена в month решением пользователя (moveDocs); иначе null. */
  sourcePeriodMonth: string | null;
}

/** Строка ведомости из API: присланный ID_FOT и основание. */
export interface IPayoutApiLine {
  lineNo: number;
  lineKey: string;
  fullName: string;
  personIdAll: string | null;
  brigade: string | null;
  amountCents: number;
  idFot: number | null;
  basis: string | null;
}

/** Ведомость из API: версия очереди 1С, комментарий, строки с ID_FOT и основанием; месяц — свой ПериодРегистрации. */
export interface IPayoutApiDocument extends Omit<IPayout1cMonthDocument, 'lines'> {
  index: number;
  version: number | null;
  comment: string | null;
  lines: IPayoutApiLine[];
}

export interface IPayout1cMonthXmlOptions {
  /** Номера ведомостей, которые 1С провела другим месяцем, а грузятся в month (решение пользователя). */
  moveDocs?: ReadonlySet<string>;
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

interface IRawLine {
  fullName: string; personIdAll: string | null; brigade: null; amountCents: number; idFot: number | null; basis: string | null;
}

const ID_FOT_RE = /^[1-9]\d{0,9}$/;
/** Основание строки и комментарий документа — без управляющих символов, до max знаков (длиннее — ошибка). */
const plainText = (raw: string | null, max: number, where: string): string | null => {
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex
  const value = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (value.length > max) fail(`${where}: длиннее ${max} знаков`);
  return value === '' ? null : value;
};

/** Строки раздела: именные — строки; «00000» без ФИО (только в «Зарплате») — сумма дубля. */
const sectionLines = (doc: XmlNode, section: (typeof SECTIONS)[number], at: string): { lines: IRawLine[]; duplicate: number } => {
  const lines: IRawLine[] = [];
  let duplicate = 0;
  const node = doc[section] === undefined || doc[section] === '' ? {} : child(doc, section, at);
  assertKnownTags(node, new Set(['расшифровка']), `${at}, «${section}»`);
  for (const [index, entry] of listOf(node.расшифровка).entries()) {
    const where = `${at}, «${section}», строка ${index + 1}`;
    assertKnownTags(entry, new Set(['ФизЛицо', 'КВыплате', 'Основание']), where);
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
    const idFotRaw = text(person, 'ID_FOT', where, false);
    if (idFotRaw !== null && !ID_FOT_RE.test(idFotRaw)) fail(`${where}: ID_FOT «${idFotRaw}» — не номер сотрудника ФОТ`);
    lines.push({
      fullName: name,
      personIdAll: idAll === null ? null : guid(idAll, where),
      brigade: null,
      amountCents: amount,
      idFot: idFotRaw === null ? null : Number(idFotRaw),
      basis: plainText(text(entry, 'Основание', where, false), 500, `${where}, «Основание»`),
    });
  }
  return { lines, duplicate };
};

/** Ведомость файла. month = null — API: месяц ведомости — её ПериодРегистрации, перенос не применяется. */
const parseDocument = (
  doc: XmlNode, index: number, month: string | null, moveDocs: ReadonlySet<string>,
): IPayout1cMonthDocument & { rawDoc: XmlNode; apiLines: IRawLine[] } => {
  const at = `Документ ${index + 1}`;
  assertKnownTags(doc, DOC_TAGS, at);
  const docKind = text(doc, 'имя_док', at) as string;
  if (!(PAYOUT_MONTH_DOC_KINDS as readonly string[]).includes(docKind)) fail(`${at}: вид «${docKind}» не поддержан`);
  const inn = text(doc, 'организация_инн', at) as string;
  if (!PAYOUT_XML_ORGANIZATION_INNS.includes(inn)) fail(`${at}: ведомость другой организации (ИНН ${inn})`);
  if (!isEmpty(doc.Состав)) fail(`${at}: раздел «Состав» не пустой — формат не поддержан`);
  const docNumber = text(doc, 'Док_Номер', at) as string;
  const where = `${at} (${docNumber})`;
  const periodMonth = isoDate(doc, 'ПериодРегистрации', where);
  if (!periodMonth.endsWith('-01')) fail(`${where}: «ПериодРегистрации» — не первое число месяца`);
  const targetMonth = month === null ? periodMonth : `${month}-01`;
  const moved = month !== null && moveDocs.has(docNumber);
  if (moved && periodMonth === targetMonth) fail(`${where}: в списке переноса, но 1С уже провела её за ${month}`);
  if (!moved && periodMonth !== targetMonth) fail(`${where}: месяц начисления ${periodMonth}, ожидался ${month}`);

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
  const lines = rawLines.map((line, i) => ({
    lineNo: i + 1, lineKey: keys[i], fullName: line.fullName, personIdAll: line.personIdAll, brigade: line.brigade,
    amountCents: line.amountCents,
  }));
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
    // Хеш — по документу 1С как есть (исходный месяц): та же ведомость в выгрузке своего месяца даёт тот же хеш.
    contentHash: payoutContentHash({ ...header, lineKeys: keys }),
    periodMonth: targetMonth,
    lines,
    docKind,
    fileTotalCents,
    duplicateCents: salary.duplicate,
    leadershipLines: leadership.lines.length,
    sourcePeriodMonth: moved ? periodMonth : null,
    rawDoc: doc,
    apiLines: rawLines,
  };
};

/** Ведомость генератора — без служебных полей разбора. */
const forMonth = ({ rawDoc: _rawDoc, apiLines: _apiLines, ...doc }: ReturnType<typeof parseDocument>): IPayout1cMonthDocument => doc;

/**
 * Дерево XML-выгрузки 1С: без DOCTYPE/ENTITY, значения строками, массивы — пути arrayPaths. Корень любой — его имя
 * и содержимое (по имени и `<имя>` выбирается разбор).
 */
export const parseXmlRoot = (xml: string, arrayPaths: ReadonlySet<string>): { name: string | null; value: unknown } => {
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
  const names = Object.keys(tree);
  return names.length === 1 ? { name: names[0], value: tree[names[0]] } : { name: null, value: undefined };
};

/**
 * Дерево выгрузки ЗУП с корнем root (по умолчанию `зп_документы_31`) — см. parseXmlRoot. Общий разбор с реестром ФСС
 * (payroll-fss.parser.ts) и выгрузкой «ЗП к выплате» (payroll-1c-payouts.to-pay-xml.ts).
 */
export const parseZupXmlTree = (xml: string, arrayPaths: ReadonlySet<string>, root: string = ROOT): XmlNode => {
  const parsed = parseXmlRoot(xml, arrayPaths);
  if (parsed.name !== root || !isNode(parsed.value)) fail(`Нужен один корень «${root}»`);
  return parsed.value as XmlNode;
};

/** Разбор выгрузки ведомостей выплаты за месяц month (YYYY-MM). Ошибка формата — Payout1cParseError. */
export const parsePayout1cMonthXml = (
  xml: string, month: string, options: IPayout1cMonthXmlOptions = {},
): IPayout1cMonthDocument[] => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`Месяц «${month}» — не YYYY-MM`);
  const root = parseZupXmlTree(xml, ARRAY_PATHS);
  assertKnownTags(root, new Set(['имя', 'версия', 'ЗарплатаКВыплатеОрганизаций']), 'Файл');
  if (text(root, 'имя', 'Файл') !== ROOT_NAME) fail('Файл: не выгрузка ведомостей выплаты («имя»)');
  const container = child(root, 'ЗарплатаКВыплатеОрганизаций', 'Файл');
  assertKnownTags(container, new Set(['документ']), 'Файл');
  const moveDocs = options.moveDocs ?? new Set<string>();
  const docs = listOf(container.документ).map((doc, index) => forMonth(parseDocument(doc, index, month, moveDocs)));
  if (docs.length === 0) fail('В файле нет документов');
  assertUniqueDocs(docs);
  return docs;
};

/** ГУИД и «организация + номер + дата» в файле не повторяются. */
const assertUniqueDocs = (docs: ReadonlyArray<{ guid: string; docNumber: string; docDate: string; organizationInn: string }>): void => {
  const guids = new Set<string>();
  const numbers = new Set<string>();
  for (const doc of docs) {
    if (guids.has(doc.guid)) fail(`ГУИД ${doc.guid} повторяется`);
    const key = `${doc.organizationInn}|${doc.docNumber}|${doc.docDate}`;
    if (numbers.has(key)) fail(`Ведомость ${doc.docNumber} от ${doc.docDate} повторяется`);
    guids.add(doc.guid);
    numbers.add(key);
  }
};

/** Наибольшее число ведомостей в одном запросе API. */
export const PAYOUT_API_MAX_DOCS = 200;

/**
 * Разбор выгрузки ведомостей из API: месяц каждой — свой ПериодРегистрации, «Док_Версия» — целое > 0 или нет (без
 * версии запись не принимается — проверяет сервис), комментарий документа, ID_FOT и основание строк.
 */
export const parsePayout1cApiXml = (xml: string): IPayoutApiDocument[] => {
  const root = parseZupXmlTree(xml, ARRAY_PATHS);
  assertKnownTags(root, new Set(['имя', 'версия', 'ЗарплатаКВыплатеОрганизаций']), 'Файл');
  if (text(root, 'имя', 'Файл') !== ROOT_NAME) fail('Файл: не выгрузка ведомостей выплаты («имя»)');
  const container = child(root, 'ЗарплатаКВыплатеОрганизаций', 'Файл');
  assertKnownTags(container, new Set(['документ']), 'Файл');
  const raw = listOf(container.документ);
  if (raw.length === 0) fail('В файле нет документов');
  if (raw.length > PAYOUT_API_MAX_DOCS) fail(`В одном запросе — не больше ${PAYOUT_API_MAX_DOCS} ведомостей`);
  const docs = raw.map((node, index): IPayoutApiDocument => {
    const { rawDoc, apiLines, ...parsed } = parseDocument(node, index, null, new Set());
    const where = `Документ ${index + 1} (${parsed.docNumber})`;
    const versionRaw = text(rawDoc, 'Док_Версия', where, false);
    if (versionRaw !== null && !/^[1-9]\d{0,14}$/.test(versionRaw)) fail(`${where}: «Док_Версия» — целое больше нуля`);
    return {
      ...parsed,
      index,
      version: versionRaw === null ? null : Number(versionRaw),
      comment: plainText(text(rawDoc, 'Комментарий', where, false), 1000, `${where}, «Комментарий»`),
      lines: parsed.lines.map((line, i) => ({ ...line, idFot: apiLines[i].idFot, basis: apiLines[i].basis })),
    };
  });
  assertUniqueDocs(docs);
  return docs;
};
