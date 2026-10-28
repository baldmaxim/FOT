/**
 * Разбор ведомости выплаты из 1С (миграция 328): «Ведомость в банк» в двух выгрузках — ЗУП2 (`зп_документы_31`) и
 * внешней базы (`ЗУП_ВЫПЛАТЫ`). Оба формата приводятся к одному документу; content_hash не зависит от формата.
 *
 * Fail-closed: ровно один документ, известный тип, ИНН СУ-10, Σ строк = итог, непустые финансовые разделы, которых
 * мы не знаем, — ошибка. Персональные данные (паспорт, ИНН, СНИЛС, гражданство, дата рождения) не извлекаются,
 * не логируются и не сохраняются: в дереве разбора они есть только в памяти.
 */
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

/** ИНН СУ-10 — единственная организация, чьи ведомости принимаются (тот же CHECK в миграции 328). */
export const PAYOUTS_1C_ORGANIZATION_INN = '7736255508';

export type Payout1cFormat = 'zup2' | 'external';

export interface IPayout1cLine {
  /** Номер строки в файле с 1 (без пустышки). */
  lineNo: number;
  fullName: string;
  /** Код физлица 1С (id_all), нижним регистром; null — нет в файле. */
  personIdAll: string | null;
  /** Бригада (только внешний формат). */
  brigade: string | null;
  amountCents: number;
  /** Ключ, общий для обоих форматов: ФИО + копейки + номер среди одинаковых. */
  lineKey: string;
}

export interface IPayout1cDocument {
  format: Payout1cFormat;
  guid: string;
  /** Номер ведомости ЗУП3 («0000-002644»). */
  docNumber: string;
  /** Номер документа ЗУП2 («00003123») — только во внешнем формате. */
  zup2Number: string | null;
  /** YYYY-MM-DD. */
  docDate: string;
  /** Месяц начисления — YYYY-MM-01. */
  periodMonth: string;
  paymentMethod: string;
  salaryProject: string | null;
  organizationInn: string;
  totalCents: number;
  lines: IPayout1cLine[];
  contentHash: string;
}

export class Payout1cParseError extends Error {}

const fail = (message: string): never => {
  throw new Payout1cParseError(message);
};

type XmlNode = Record<string, unknown>;

const ZUP2_ROOT = 'зп_документы_31';
const ZUP2_NAME = 'ЗарплатаКВыплате_из_ЗУП_Предст_31_В_ЗУП_УПР';
const ZUP2_DOC_KIND = 'ВедомостьНаВыплатуЗарплатыВБанк';
const EXTERNAL_ROOT = 'ЗУП_ВЫПЛАТЫ';
const EXTERNAL_NAME = 'ВыплатаЗПнаЛС';

/** Списки, которые всегда массив (иначе одна запись пришла бы объектом). */
const ARRAY_PATHS = new Set([
  `${ZUP2_ROOT}.ЗарплатаКВыплатеОрганизаций.документ`,
  `${ZUP2_ROOT}.ЗарплатаКВыплатеОрганизаций.документ.Зарплата.расшифровка`,
  `${EXTERNAL_ROOT}.Документы.Документ`,
  `${EXTERNAL_ROOT}.Документы.Документ.Сотрудники.сотрудник`,
]);

/** Теги документа ЗУП2: служебные и реквизиты. Финансовые разделы — отдельно. */
const ZUP2_DOC_TAGS = new Set([
  'имя_док', 'организация_инн', 'организация_имя', 'Док_Гуид', 'ЗП_Проект_Рабочие', 'ЗП_Проект', 'Док_Номер', 'Док_Дата',
  'ПериодРегистрации', 'Подразделение', 'СтатьяФинансирования', 'ЗарплатныйПроект', 'НомерРеестра', 'СтатьяРасходов',
  'СпособВыплаты', 'Округление', 'ПроцентВыплаты', 'СуммаПоДокументу', 'Руководитель', 'ДолжностьРуководителя',
  'ГлавныйБухгалтер', 'Бухгалтер', 'ПеречислениеНДФЛВыполнено', 'ПеречислениеНДФЛРеквизиты', 'ВводНачальныхДанных',
  'КраткийСоставДокумента', 'Комментарий', 'Зарплата',
  // Справочник физлиц документа — персональные данные, не читается.
  'ФизическиеЛица',
]);
/** Финансовые разделы ЗУП2, которые пока не поддержаны: непустой — ошибка. */
const ZUP2_UNSUPPORTED_SECTIONS = ['Зарплата_руководство', 'отпуска', 'Основания', 'Состав'];

const EXTERNAL_DOC_TAGS = new Set([
  'док_гуид', 'номер', 'дата', 'сумма', 'периодо_регистрации', 'НомерБазаИсточник', 'ДатаБазаИсточник', 'СпособВыплаты',
  'СпособВыплатыЗПВПредставительскойБазе', 'фирма_представительская_имя', 'фирма_представительская_инн',
  'ЗарплатныйПроект', 'ЗарплатныйПроект_Кли_Имя', 'ЗарплатныйПроект_Кли_id_all', 'ЗарплатныйПроект_Дог_Имя',
  'ЗарплатныйПроект_Дог_id_all', 'Сотрудники',
]);
const EXTERNAL_EMPLOYEE_TAGS = new Set([
  'Сумма', 'физ_лицо_id_all', 'физ_лицо_имя', 'счет_учета', 'МесяцНачисленияЗП', 'бригада_имя', 'бригада_код',
  'бригада_id_all', 'бригада_фл_id_all',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isNode = (value: unknown): value is XmlNode => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Пустой раздел: '' или объект без значимого содержимого. */
const isEmpty = (value: unknown): boolean => {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.every(isEmpty);
  if (isNode(value)) return Object.values(value).every(isEmpty);
  return String(value).trim() === '';
};

/** Значение одиночного тега строкой; повтор тега — ошибка. */
const text = (node: XmlNode, tag: string, where: string, required = true): string | null => {
  const value = node[tag];
  if (Array.isArray(value)) fail(`${where}: тег «${tag}» повторяется`);
  if (value === undefined || value === null || value === '') {
    if (required) fail(`${where}: нет тега «${tag}»`);
    return null;
  }
  if (isNode(value)) fail(`${where}: «${tag}» — не значение`);
  const result = String(value).trim();
  if (required && result === '') fail(`${where}: пустой «${tag}»`);
  return result === '' ? null : result;
};

const child = (node: XmlNode, tag: string, where: string): XmlNode => {
  const value = node[tag];
  if (Array.isArray(value)) fail(`${where}: тег «${tag}» повторяется`);
  if (!isNode(value)) fail(`${where}: нет раздела «${tag}»`);
  return value as XmlNode;
};

const listOf = (value: unknown): XmlNode[] => {
  if (value === undefined || value === '') return [];
  if (!Array.isArray(value)) return isNode(value) ? [value] : [];
  return value.filter(isNode);
};

const assertKnownTags = (node: XmlNode, known: ReadonlySet<string>, where: string): void => {
  for (const tag of Object.keys(node)) {
    if (!known.has(tag)) fail(`${where}: неизвестный раздел «${tag}» — формат не поддержан`);
  }
};

/** Дата из Год/Мес/День («9» и «09»); только существующая дата календаря. */
const dateParts = (node: XmlNode, tag: string, where: string): string => {
  const part = child(node, tag, where);
  const label = `${where}, «${tag}»`;
  const year = Number(text(part, 'Год', label));
  const month = Number(text(part, 'Мес', label));
  const day = Number(text(part, 'День', label));
  if (![year, month, day].every(Number.isInteger)) fail(`${label}: не дата`);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`${label}: несуществующая дата ${day}.${month}.${year}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

/** Месяц начисления — первое число; другой день — ошибка. */
const periodMonth = (node: XmlNode, tag: string, where: string): string => {
  const date = dateParts(node, tag, where);
  if (!date.endsWith('-01')) fail(`${where}: месяц начисления «${tag}» — не первое число (${date})`);
  return date;
};

/** «241 754,82», «31818,18», «43500» → копейки. Больше двух знаков после запятой — ошибка. */
export const parseAmountCents = (raw: string, where: string): number => {
  const cleaned = raw.replace(/[\s  ]/g, '').replace(',', '.');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return fail(`${where}: сумма «${raw}» не распознана`);
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 999_999_999_999) fail(`${where}: сумма «${raw}» слишком большая`);
  return cents;
};

const guidOf = (raw: string, where: string): string => {
  const value = raw.toLowerCase();
  if (!UUID_RE.test(value)) fail(`${where}: ГУИД «${raw}» не распознан`);
  return value;
};

const personIdAll = (raw: string | null, where: string): string | null => (raw === null ? null : guidOf(raw, where));

/** Нормализованное ФИО для ключа строки и поиска: NFKC, ё → е, регистр, пробелы и дефисы. */
export const normalizePayoutName = (value: string): string => value
  .normalize('NFKC')
  .toLowerCase()
  .replace(/ё/g, 'е')
  .replace(/\s*-\s*/g, '-')
  .replace(/\s+/g, ' ')
  .trim();

interface IRawLine {
  fullName: string;
  personIdAll: string | null;
  brigade: string | null;
  amountCents: number;
}

/**
 * Ключи строк (line_key) по порядку: нормализованное ФИО + копейки + номер среди одинаковых. Общие для всех источников
 * одной ведомости — XML ЗУП2, внешней базы и регистра выплат ЗУП (build-payouts-register-sql.ts).
 */
export const buildPayoutLineKeys = (lines: ReadonlyArray<{ fullName: string; amountCents: number }>): string[] => {
  const seen = new Map<string, number>();
  return lines.map(line => {
    const base = `${normalizePayoutName(line.fullName)}|${line.amountCents}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return `${base}|${occurrence}`;
  });
};

/** Строки с номерами по порядку в файле и ключами buildPayoutLineKeys. */
const withKeys = (lines: readonly IRawLine[]): IPayout1cLine[] => {
  const keys = buildPayoutLineKeys(lines);
  return lines.map((line, index) => ({ ...line, lineNo: index + 1, lineKey: keys[index] }));
};

/** Канонический хеш содержимого: одинаков для обоих форматов одной ведомости. */
export const payoutContentHash = (doc: Pick<IPayout1cDocument,
  'guid' | 'docNumber' | 'docDate' | 'periodMonth' | 'paymentMethod' | 'totalCents'> & { lineKeys: readonly string[] }): string => {
  const canonical = JSON.stringify({
    v: 1,
    guid: doc.guid,
    number: doc.docNumber,
    date: doc.docDate,
    period: doc.periodMonth,
    method: doc.paymentMethod,
    total: doc.totalCents,
    lines: [...doc.lineKeys].sort(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
};

const checkInn = (inn: string, where: string): void => {
  if (inn !== PAYOUTS_1C_ORGANIZATION_INN) {
    fail(`${where}: ведомость другой организации (ИНН ${inn}), принимаются только ведомости СУ-10`);
  }
};

const parseZup2 = (root: XmlNode): Omit<IPayout1cDocument, 'lines' | 'contentHash'> & { rawLines: IRawLine[] } => {
  const where = 'Файл ЗУП2';
  assertKnownTags(root, new Set(['имя', 'версия', 'ЗарплатаКВыплатеОрганизаций']), where);
  if (text(root, 'имя', where) !== ZUP2_NAME) fail(`${where}: не выгрузка ведомостей выплаты («имя»)`);
  const docs = listOf(child(root, 'ЗарплатаКВыплатеОрганизаций', where).документ);
  if (docs.length !== 1) fail(`${where}: в файле ${docs.length} документов, поддержан ровно один`);
  const doc = docs[0];
  const at = 'Документ ЗУП2';
  assertKnownTags(doc, new Set([...ZUP2_DOC_TAGS, ...ZUP2_UNSUPPORTED_SECTIONS]), at);
  if (text(doc, 'имя_док', at) !== ZUP2_DOC_KIND) fail(`${at}: не «Ведомость на выплату зарплаты в банк»`);
  for (const section of ZUP2_UNSUPPORTED_SECTIONS) {
    if (!isEmpty(doc[section])) fail(`${at}: раздел «${section}» не пустой — формат не поддержан`);
  }
  const inn = text(doc, 'организация_инн', at) as string;
  checkInn(inn, at);

  const rawLines: IRawLine[] = [];
  const salary = doc.Зарплата === '' ? {} : child(doc, 'Зарплата', at);
  assertKnownTags(salary, new Set(['расшифровка']), `${at}, «Зарплата»`);
  for (const [index, entry] of listOf(salary.расшифровка).entries()) {
    const lineAt = `${at}, строка ${index + 1}`;
    assertKnownTags(entry, new Set(['ФизЛицо', 'КВыплате']), lineAt);
    const person = child(entry, 'ФизЛицо', lineAt);
    const amountRaw = text(entry, 'КВыплате', lineAt, false);
    const code = text(person, 'код', lineAt, false);
    const name = text(person, 'наименование', lineAt, false);
    // Пустышка в конце ведомости: физлицо только с кодом 00000 и нулевой суммой.
    if (code === '00000' && name === null && Object.keys(person).length === 1
      && (amountRaw === null || parseAmountCents(amountRaw, lineAt) === 0)) continue;
    if (name === null) fail(`${lineAt}: нет ФИО`);
    if (amountRaw === null) fail(`${lineAt}: нет суммы «КВыплате»`);
    const amountCents = parseAmountCents(amountRaw as string, lineAt);
    if (amountCents <= 0) fail(`${lineAt}: сумма должна быть больше нуля`);
    rawLines.push({
      fullName: name as string,
      personIdAll: personIdAll(text(person, 'id_all', lineAt, false), lineAt),
      brigade: null,
      amountCents,
    });
  }

  return {
    format: 'zup2',
    guid: guidOf(text(doc, 'Док_Гуид', at) as string, at),
    docNumber: text(doc, 'Док_Номер', at) as string,
    zup2Number: null,
    docDate: dateParts(doc, 'Док_Дата', at),
    periodMonth: periodMonth(doc, 'ПериодРегистрации', at),
    paymentMethod: text(doc, 'СпособВыплаты', at) as string,
    salaryProject: text(doc, 'ЗарплатныйПроект', at, false),
    organizationInn: inn,
    totalCents: parseAmountCents(text(doc, 'СуммаПоДокументу', at) as string, at),
    rawLines,
  };
};

/** «01.01.0001 0:00:00» — месяц не указан; иначе «ДД.ММ.ГГГГ …» должен быть в месяце документа. */
const checkAccrualMonth = (raw: string | null, period: string, where: string): void => {
  if (raw === null || raw.startsWith('01.01.0001')) return;
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(raw);
  if (!match) fail(`${where}: «МесяцНачисленияЗП» «${raw}» не распознан`);
  const month = `${(match as RegExpExecArray)[3]}-${(match as RegExpExecArray)[2].padStart(2, '0')}-01`;
  if (month !== period) fail(`${where}: месяц начисления строки (${month}) не совпадает с месяцем документа (${period})`);
};

const parseExternal = (root: XmlNode): Omit<IPayout1cDocument, 'lines' | 'contentHash'> & { rawLines: IRawLine[] } => {
  const where = 'Файл внешней базы';
  assertKnownTags(root, new Set(['имя', 'версия', 'Документы']), where);
  if (text(root, 'имя', where) !== EXTERNAL_NAME) fail(`${where}: не выгрузка выплат («имя»)`);
  const docs = listOf(child(root, 'Документы', where).Документ);
  if (docs.length !== 1) fail(`${where}: в файле ${docs.length} документов, поддержан ровно один`);
  const doc = docs[0];
  const at = 'Документ внешней базы';
  assertKnownTags(doc, EXTERNAL_DOC_TAGS, at);
  const inn = text(doc, 'фирма_представительская_инн', at) as string;
  checkInn(inn, at);
  const docDate = dateParts(doc, 'ДатаБазаИсточник', at);
  const zup2Date = dateParts(doc, 'дата', at);
  if (zup2Date !== docDate) fail(`${at}: дата документа (${zup2Date}) не совпадает с датой ведомости ЗУП (${docDate})`);
  const period = periodMonth(doc, 'периодо_регистрации', at);

  const rawLines: IRawLine[] = [];
  const employees = doc.Сотрудники === '' ? {} : child(doc, 'Сотрудники', at);
  assertKnownTags(employees, new Set(['сотрудник']), `${at}, «Сотрудники»`);
  for (const [index, entry] of listOf(employees.сотрудник).entries()) {
    const lineAt = `${at}, строка ${index + 1}`;
    assertKnownTags(entry, EXTERNAL_EMPLOYEE_TAGS, lineAt);
    const amountCents = parseAmountCents(text(entry, 'Сумма', lineAt) as string, lineAt);
    if (amountCents <= 0) fail(`${lineAt}: сумма должна быть больше нуля`);
    checkAccrualMonth(text(entry, 'МесяцНачисленияЗП', lineAt, false), period, lineAt);
    rawLines.push({
      fullName: text(entry, 'физ_лицо_имя', lineAt) as string,
      personIdAll: personIdAll(text(entry, 'физ_лицо_id_all', lineAt, false), lineAt),
      brigade: text(entry, 'бригада_имя', lineAt, false),
      amountCents,
    });
  }

  return {
    format: 'external',
    guid: guidOf(text(doc, 'док_гуид', at) as string, at),
    docNumber: text(doc, 'НомерБазаИсточник', at) as string,
    zup2Number: text(doc, 'номер', at),
    docDate,
    periodMonth: period,
    paymentMethod: text(doc, 'СпособВыплаты', at) as string,
    salaryProject: text(doc, 'ЗарплатныйПроект', at, false),
    organizationInn: inn,
    totalCents: parseAmountCents(text(doc, 'сумма', at) as string, at),
    rawLines,
  };
};

/** Разбор файла ведомости выплаты. Ошибка формата — Payout1cParseError с понятным текстом. */
export const parsePayout1cXml = (xml: string): IPayout1cDocument => {
  const source = xml.replace(/^﻿/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) fail('Файл с DOCTYPE или ENTITY не принимается');
  const declaration = /^<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(source);
  if (declaration && declaration[1].toLowerCase() !== 'utf-8') fail(`Кодировка ${declaration[1]} не поддержана, нужна UTF-8`);
  const validation = XMLValidator.validate(source);
  if (validation !== true) fail(`Файл не XML: ${validation.err.msg} (строка ${validation.err.line})`);

  const parser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    parseAttributeValue: false,
    processEntities: false,
    trimValues: true,
    ignoreDeclaration: true,
    ignorePiTags: true,
    isArray: (_name: string, jpath: unknown) => ARRAY_PATHS.has(String(jpath)),
  });
  const tree = parser.parse(source) as XmlNode;
  const roots = Object.keys(tree);
  if (roots.length !== 1) fail('В файле должен быть один корневой элемент');
  const rootName = roots[0];
  const root = tree[rootName];
  if (!isNode(root)) fail('Пустой файл');

  let parsed: Omit<IPayout1cDocument, 'lines' | 'contentHash'> & { rawLines: IRawLine[] };
  if (rootName === ZUP2_ROOT) parsed = parseZup2(root as XmlNode);
  else if (rootName === EXTERNAL_ROOT) parsed = parseExternal(root as XmlNode);
  else return fail(`Неизвестный формат файла («${rootName}»): нужна ведомость выплаты ЗУП2 или внешней базы`);

  if (parsed.rawLines.length === 0) fail('В ведомости нет строк');
  const sum = parsed.rawLines.reduce((total, line) => total + line.amountCents, 0);
  if (sum !== parsed.totalCents) {
    fail(`Сумма строк (${(sum / 100).toFixed(2)}) не равна итогу документа (${(parsed.totalCents / 100).toFixed(2)})`);
  }
  const lines = withKeys(parsed.rawLines);
  const { rawLines: _rawLines, ...header } = parsed;
  return {
    ...header,
    lines,
    contentHash: payoutContentHash({ ...header, lineKeys: lines.map(line => line.lineKey) }),
  };
};
