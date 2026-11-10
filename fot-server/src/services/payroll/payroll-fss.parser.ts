/**
 * Реестр «Прямые выплаты ФСС» из ЗУП (корень `зп_документы_31`, имя «РеестрПрямыхВыплатФСС_…») — для разовой загрузки
 * в «Выплаты ФСС (1С)» (миграция 356, scripts/build-fss-payments-sql.ts). Решение пользователя 10.11.2026: больничный
 * с 4-го дня СФР платит напрямую — показывать отдельным столбцом, в расчёт ФОТ и «Остаток» не входит.
 *
 * Строка — один листок нетрудоспособности: ФИО и id_all физлица, № ЭЛН, причина, даты и дни оплаты СФР, суммы всего,
 * НДФЛ и на руки — как в 1С, без пересчёта: «на руки» бывает больше «всего − НДФЛ» на рубль округления (сентябрь 2026,
 * Селиванов: НДФЛ, видимо, по частям) — генератор выносит такие строки в «Проверить». «Расшифровки» не читаются: в
 * выгрузке они часто пустые и с итогом строки не сходятся. Месяц — «ПериодРегистрации» реестра.
 * Fail-closed: неизвестный раздел, чужой ИНН, другой месяц — ошибка. Персональные данные (паспорт, ИНН, СНИЛС,
 * гражданство, дата рождения, стаж) не извлекаются.
 */
import { createHash } from 'node:crypto';

import { parseAmountCents, PAYOUTS_1C_ORGANIZATION_INN } from './payroll-1c-payouts.parser.js';
import {
  assertKnownTags,
  child,
  fail,
  guid,
  isoDate,
  listOf,
  parseZupXmlTree,
  text,
  type XmlNode,
} from './payroll-1c-payouts.month-xml.js';

const ROOT_NAME = 'РеестрПрямыхВыплатФСС_из_ЗУП_Предст_31_В_ЗУП_УПР';
const DOC_KIND = 'Выгрузить_в_уб_ПрямыхВыплатФСС';
const ARRAY_PATHS = new Set(['зп_документы_31.РеестрыФСС.РеестрФСС']);

const ROOT_TAGS = new Set([
  'имя', 'версия', 'имя_док', 'организация_инн', 'организация_имя', 'Док_Гуид', 'Док_Номер', 'Док_Дата',
  'ПериодРегистрации', 'Автор', 'Комментарий', 'РеестрыФСС',
]);
const ENTRY_TAGS = new Set([
  'Комментарий', 'ФизЛицо', 'Сотрудник', 'РеестрСведенийНеобходимыхДляНазначенияИВыплатыПособий', 'БольничныйЛист',
  'НомерЛисткаНетрудоспособности', 'Дней_ФСС', 'Сумма_Всего_ФСС', 'СтавкаНДФЛ', 'Сумма_НДФЛ_ФСС',
  'Сумма_Всего_БезНДФЛ_ФСС', 'ПричинаНетрудоспособности', 'ДатаНачалаОплаты', 'ДатаОкончанияОплаты',
  'НомерПервичногоЛисткаНетрудоспособности', 'СтажЛет', 'СтажМесяцев', 'ЭтоЭЛН', 'ПервичныйДокумент', 'Расшифровки',
]);

export interface IFssLine {
  /** Номер строки в реестре с 1. */
  lineNo: number;
  fullName: string;
  /** Код физлица 1С (id_all), нижним регистром; null — нет в файле. */
  personIdAll: string | null;
  sickLeaveNumber: string | null;
  reason: string | null;
  /** YYYY-MM-DD; null — нет в файле. */
  dateFrom: string | null;
  dateTo: string | null;
  days: number | null;
  grossCents: number;
  ndflCents: number;
  /** На руки — как в 1С («Сумма_Всего_БезНДФЛ_ФСС»); обычно grossCents − ndflCents. */
  amountCents: number;
}

export interface IFssRegistry {
  guid: string;
  docNumber: string;
  /** YYYY-MM-DD. */
  docDate: string;
  /** Месяц — YYYY-MM-01 («ПериодРегистрации»). */
  periodMonth: string;
  lines: IFssLine[];
  /** Канонический sha256 содержимого: тот же реестр — тот же хеш, при любой правке — другой. */
  contentHash: string;
}

/** Дата раздела, если он есть и не пустой. */
const optionalDate = (node: XmlNode, tag: string, where: string): string | null => {
  const part = node[tag];
  if (part === undefined || part === '') return null;
  return isoDate(node, tag, where);
};

const optionalDays = (node: XmlNode, where: string): number | null => {
  const raw = text(node, 'Дней_ФСС', where, false);
  if (raw === null) return null;
  if (!/^\d{1,4}$/.test(raw)) fail(`${where}: «Дней_ФСС» — не число дней`);
  return Number(raw);
};

const parseEntry = (entry: XmlNode, index: number): Omit<IFssLine, 'lineNo'> => {
  const at = `Строка ${index + 1}`;
  assertKnownTags(entry, ENTRY_TAGS, at);
  const person = child(entry, 'ФизЛицо', at);
  const fullName = text(person, 'наименование', at) as string;
  const where = `${at} (${fullName})`;
  const idAll = text(person, 'id_all', where, false);
  const grossCents = parseAmountCents(text(entry, 'Сумма_Всего_ФСС', where) as string, where);
  const ndflCents = parseAmountCents(text(entry, 'Сумма_НДФЛ_ФСС', where, false) ?? '0', where);
  const amountCents = parseAmountCents(text(entry, 'Сумма_Всего_БезНДФЛ_ФСС', where) as string, where);
  const dateFrom = optionalDate(entry, 'ДатаНачалаОплаты', where);
  const dateTo = optionalDate(entry, 'ДатаОкончанияОплаты', where);
  if (dateFrom !== null && dateTo !== null && dateFrom > dateTo) fail(`${where}: начало оплаты позже окончания`);
  return {
    fullName,
    personIdAll: idAll === null ? null : guid(idAll, where),
    sickLeaveNumber: text(entry, 'НомерЛисткаНетрудоспособности', where, false),
    reason: text(entry, 'ПричинаНетрудоспособности', where, false),
    dateFrom,
    dateTo,
    days: optionalDays(entry, where),
    grossCents,
    ndflCents,
    amountCents,
  };
};

const fssContentHash = (registry: Omit<IFssRegistry, 'contentHash'>): string => createHash('sha256').update(JSON.stringify([
  registry.guid, registry.docNumber, registry.docDate, registry.periodMonth,
  registry.lines.map(line => [
    line.lineNo, line.fullName, line.personIdAll, line.sickLeaveNumber, line.reason, line.dateFrom, line.dateTo, line.days,
    line.grossCents, line.ndflCents, line.amountCents,
  ]),
])).digest('hex');

/** Разбор реестра прямых выплат ФСС за месяц month (YYYY-MM). Ошибка формата — Payout1cParseError. */
export const parseFssRegistryXml = (xml: string, month: string): IFssRegistry => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`Месяц «${month}» — не YYYY-MM`);
  const root = parseZupXmlTree(xml, ARRAY_PATHS);
  assertKnownTags(root, ROOT_TAGS, 'Файл');
  if (text(root, 'имя', 'Файл') !== ROOT_NAME) fail('Файл: не реестр прямых выплат ФСС («имя»)');
  if (text(root, 'имя_док', 'Файл') !== DOC_KIND) fail('Файл: не реестр прямых выплат ФСС («имя_док»)');
  const inn = text(root, 'организация_инн', 'Файл') as string;
  if (inn !== PAYOUTS_1C_ORGANIZATION_INN) fail(`Файл: реестр другой организации (ИНН ${inn})`);
  const docNumber = text(root, 'Док_Номер', 'Файл') as string;
  const periodMonth = isoDate(root, 'ПериодРегистрации', 'Файл');
  if (periodMonth !== `${month}-01`) fail(`Файл: месяц реестра ${periodMonth}, ожидался ${month}`);
  const container = child(root, 'РеестрыФСС', 'Файл');
  assertKnownTags(container, new Set(['РеестрФСС']), 'Файл, «РеестрыФСС»');
  const lines = listOf(container.РеестрФСС).map((entry, index) => ({ lineNo: index + 1, ...parseEntry(entry, index) }));
  if (lines.length === 0) fail('В реестре нет строк');
  const registry = {
    guid: guid(text(root, 'Док_Гуид', 'Файл') as string, 'Файл'),
    docNumber,
    docDate: isoDate(root, 'Док_Дата', 'Файл'),
    periodMonth,
    lines,
  };
  return { ...registry, contentHash: fssContentHash(registry) };
};
