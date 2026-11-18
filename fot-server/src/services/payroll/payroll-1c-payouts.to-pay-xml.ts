/**
 * Выгрузка ЗУП2 «ЗП к выплате» (корень `ЗУП_ВЫПЛАТЫ`, `<имя>данные_из_зуп_зп_к_выплате</имя>`) — для разовой загрузки в
 * «Перечислено (1С)» генератором scripts/build-payouts-xml-sql.ts. Решение пользователя 18.11.2026 (октябрь, документ
 * 0000000403): кнопку «Загрузить из 1С» не трогать, грузить скриптом.
 *
 * Формат (описание программиста 1С): документ — гуид, номер и дата ЗУП2, период регистрации; строка — ФИО, код физлица
 * (id_all), «сумма» к выплате, «ндфл» и «кНачислению» справочно. Вида выплаты, ИНН организации и итога в файле нет:
 * вид и ИНН задаёт пользователь (options), итог — сумма строк. Сотрудник — только по id_all («не нашли — не загрузили»),
 * это решает генератор.
 *
 * Ключи строк и content_hash — те же функции, что у кнопки и выгрузки ведомостей (payroll-1c-payouts.parser.ts).
 * Fail-closed: неизвестный тег, сумма ≤ 0 или ≠ кНачислению − ндфл, несуществующая дата, период не 1-го числа или не
 * month, повтор ГУИДа или номера с датой — ошибка. НДФЛ и «к начислению» только сверяются, не сохраняются.
 */
import {
  buildPayoutLineKeys,
  parseAmountCents,
  PAYOUT_XML_ORGANIZATION_INNS,
  payoutContentHash,
} from './payroll-1c-payouts.parser.js';
import {
  assertKnownTags,
  child,
  fail,
  guid,
  isNode,
  listOf,
  parseXmlRoot,
  parseZupXmlTree,
  text,
  type IPayout1cMonthDocument,
  type XmlNode,
} from './payroll-1c-payouts.month-xml.js';

export const TO_PAY_ROOT = 'ЗУП_ВЫПЛАТЫ';
export const TO_PAY_NAME = 'данные_из_зуп_зп_к_выплате';

const ARRAY_PATHS = new Set([`${TO_PAY_ROOT}.Документ`, `${TO_PAY_ROOT}.Документ.строки.строка`]);
const DOC_TAGS = new Set(['гуид', 'док_ном', 'док_дата', 'период_регистрации', 'строки']);
const LINE_TAGS = new Set(['фио', 'id_all', 'сумма', 'ндфл', 'кНачислению']);
/** «12.11.2026 16:30:32», «01.10.2026 0:00:00», «12.11.2026». */
const DATE_RE = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?: \d{1,2}:\d{2}(?::\d{2})?)?$/;

export interface IPayout1cToPayOptions {
  /** Вид выплаты — в файле его нет (решение пользователя). */
  paymentMethod: string;
  /** ИНН организации — в файле его нет; только PAYOUT_XML_ORGANIZATION_INNS. */
  organizationInn: string;
}

export type PayoutXmlKind = 'zup_month' | 'to_pay';

/** Вид выгрузки по корню и `<имя>`: «ЗП к выплате» или (всё прочее) выгрузка ведомостей ЗУП за месяц. */
export const detectPayoutXmlKind = (xml: string): PayoutXmlKind => {
  const { name, value } = parseXmlRoot(xml, new Set());
  return name === TO_PAY_ROOT && isNode(value) && value.имя === TO_PAY_NAME ? 'to_pay' : 'zup_month';
};

/** «ДД.ММ.ГГГГ[ Ч:ММ:СС]» → YYYY-MM-DD; только существующая дата календаря. */
const dateOf = (node: XmlNode, tag: string, where: string): string => {
  const raw = text(node, tag, where) as string;
  const match = DATE_RE.exec(raw);
  if (!match) return fail(`${where}: «${tag}» «${raw}» — не дата`);
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    fail(`${where}: «${tag}» «${raw}» — несуществующая дата`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const parseDocument = (doc: XmlNode, index: number, month: string, options: IPayout1cToPayOptions): IPayout1cMonthDocument => {
  const at = `Документ ${index + 1}`;
  assertKnownTags(doc, DOC_TAGS, at);
  const docNumber = text(doc, 'док_ном', at) as string;
  const where = `${at} (${docNumber})`;
  const periodMonth = dateOf(doc, 'период_регистрации', where);
  if (!periodMonth.endsWith('-01')) fail(`${where}: «период_регистрации» не первое число месяца (${periodMonth})`);
  if (periodMonth !== `${month}-01`) fail(`${where}: месяц начисления ${periodMonth}, ожидался ${month}`);

  const rows = doc.строки === undefined || doc.строки === '' ? {} : child(doc, 'строки', where);
  assertKnownTags(rows, new Set(['строка']), `${where}, «строки»`);
  const rawLines = listOf(rows.строка).map((entry, lineIndex) => {
    const lineAt = `${where}, строка ${lineIndex + 1}`;
    assertKnownTags(entry, LINE_TAGS, lineAt);
    const amountCents = parseAmountCents(text(entry, 'сумма', lineAt) as string, lineAt);
    if (amountCents <= 0) fail(`${lineAt}: сумма должна быть больше нуля`);
    const accruedCents = parseAmountCents(text(entry, 'кНачислению', lineAt) as string, lineAt);
    const taxCents = parseAmountCents(text(entry, 'ндфл', lineAt) as string, lineAt);
    if (amountCents !== accruedCents - taxCents) {
      fail(`${lineAt}: сумма ${amountCents / 100} ≠ кНачислению ${accruedCents / 100} − ндфл ${taxCents / 100}`);
    }
    const idAll = text(entry, 'id_all', lineAt, false);
    return {
      fullName: text(entry, 'фио', lineAt) as string,
      personIdAll: idAll === null ? null : guid(idAll, lineAt),
      brigade: null,
      amountCents,
    };
  });
  if (rawLines.length === 0) fail(`${where}: нет строк`);

  const totalCents = rawLines.reduce((sum, line) => sum + line.amountCents, 0);
  const keys = buildPayoutLineKeys(rawLines);
  const header = {
    format: 'zup2' as const,
    guid: guid(text(doc, 'гуид', where) as string, where),
    docNumber,
    zup2Number: null,
    docDate: dateOf(doc, 'док_дата', where),
    periodMonth,
    paymentMethod: options.paymentMethod,
    salaryProject: null,
    organizationInn: options.organizationInn,
    totalCents,
  };
  return {
    ...header,
    lines: rawLines.map((line, i) => ({ ...line, lineNo: i + 1, lineKey: keys[i] })),
    contentHash: payoutContentHash({ ...header, lineKeys: keys }),
    docKind: TO_PAY_NAME,
    fileTotalCents: totalCents,
    duplicateCents: 0,
    leadershipLines: 0,
    sourcePeriodMonth: null,
  };
};

/** Разбор выгрузки «ЗП к выплате» за месяц month (YYYY-MM). Ошибка формата — Payout1cParseError. */
export const parsePayout1cToPayXml = (xml: string, month: string, options: IPayout1cToPayOptions): IPayout1cMonthDocument[] => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`Месяц «${month}» — не YYYY-MM`);
  const paymentMethod = options.paymentMethod.trim();
  if (paymentMethod === '' || paymentMethod.length > 100) fail('Вид выплаты: от 1 до 100 знаков');
  if (!PAYOUT_XML_ORGANIZATION_INNS.includes(options.organizationInn)) {
    fail(`ИНН ${options.organizationInn} не из принимаемых (${PAYOUT_XML_ORGANIZATION_INNS.join(', ')})`);
  }
  const root = parseZupXmlTree(xml, ARRAY_PATHS, TO_PAY_ROOT);
  assertKnownTags(root, new Set(['имя', 'Документ']), 'Файл');
  if (text(root, 'имя', 'Файл') !== TO_PAY_NAME) fail(`Файл: не выгрузка «ЗП к выплате» («имя» не «${TO_PAY_NAME}»)`);
  const docs = listOf(root.Документ).map((doc, index) => parseDocument(doc, index, month, { ...options, paymentMethod }));
  if (docs.length === 0) fail('В файле нет документов');

  const guids = new Set<string>();
  const numbers = new Set<string>();
  for (const doc of docs) {
    if (guids.has(doc.guid)) fail(`ГУИД ${doc.guid} повторяется`);
    const key = `${doc.docNumber}|${doc.docDate}`;
    if (numbers.has(key)) fail(`Документ ${doc.docNumber} от ${doc.docDate} повторяется`);
    guids.add(doc.guid);
    numbers.add(key);
  }
  return docs;
};
