/**
 * Регистр выплат ЗУП («ВыгрузкаЗУП_представительской…», xlsx взаиморасчётов с персоналом) → ведомости выплаты
 * «Перечислено (1С)» (миграция 328). Только разбор и проверка — без БД: сопоставление с сотрудниками и SQL —
 * scripts/build-payouts-register-sql.ts.
 *
 * Строка регистра — выплата человеку по одному документу («Регистратор»): ведомости «в банк» / «на счета» или
 * «Премия» с выплатой в межрасчетный период. Документ = регистратор: номер, дата, способ выплаты; месяц —
 * ПериодВзаиморасчетов («Период» — месяц регистрации, бывает позже: премия за сентябрь, проведённая в октябре).
 * ГУИДа документа в регистре нет — синтетический UUID v5 от номера и даты (повторный разбор даёт те же). Тип
 * регистратора в идентичность не входит: в XML его нет, а загрузка XML той же ведомости отсекается по номеру и дате
 * (payroll-1c-payouts.service).
 *
 * ЗУП выгружает регистр в двух наборах столбцов: с «НомерСтроки», «Сторно», «Группа…» и без них (с «Статьями»).
 * Столбцы ищем по имени; без «НомерСтроки» строка ведомости нумеруется по порядку в файле.
 *
 * Отрицательная строка — зачёт внутри ведомости (−аванс + аванс): строки человека в такой ведомости сворачиваются
 * в одну, итог обязан быть > 0. Повтор человека без минуса — две строки, как в XML; line_key — общий
 * buildPayoutLineKeys, поэтому строки совпадают со строками XML той же ведомости.
 */
import { v5 as uuidv5 } from 'uuid';

import { buildPayoutLineKeys, normalizePayoutName, payoutContentHash } from './payroll-1c-payouts.parser.js';

/** Столбцы регистра по порядку — первый формат выгрузки ЗУП (с «НомерСтроки», «Сторно», «Группа…»). */
export const PAYOUTS_REGISTER_HEADER = [
  'Период', 'Регистратор', 'НомерСтроки', 'Организация', 'ФизическоеЛицо', 'РегистраторСпособВыплаты', 'Сотрудник',
  'Подразделение', 'ВидДоходаИсполнительногоПроизводства', 'СуммаВзаиморасчетов', 'ПериодВзаиморасчетов',
  'ВидВзаиморасчетов', 'Сторно', 'ГруппаНачисленияУдержанияВыплаты',
] as const;

const REQUIRED_COLUMNS = [
  'Период', 'Регистратор', 'Организация', 'ФизическоеЛицо', 'РегистраторСпособВыплаты', 'Сотрудник', 'Подразделение',
  'СуммаВзаиморасчетов', 'ПериодВзаиморасчетов', 'ВидВзаиморасчетов',
] as const;
const OPTIONAL_COLUMNS = [
  'НомерСтроки', 'Сторно', 'ГруппаНачисленияУдержанияВыплаты', 'ВидДоходаИсполнительногоПроизводства',
  'СтатьяФинансирования', 'СтатьяРасходов',
] as const;
type RegisterColumn = (typeof REQUIRED_COLUMNS)[number] | (typeof OPTIONAL_COLUMNS)[number];

export const PAYOUTS_REGISTER_ORGANIZATION = 'ООО "СУ-10"';

/** Пространство имён UUID v5 ведомостей регистра. Не менять: от него зависят ГУИДы уже загруженных ведомостей. */
export const PAYOUTS_REGISTER_GUID_NAMESPACE = '3379cd79-ce2d-4242-90b4-98a9f8c0d2ea';

export class PayoutsRegisterError extends Error {}

// Явный тип — чтобы `if (…) fail(…)` сужал типы дальше по коду.
const fail: (message: string) => never = message => {
  throw new PayoutsRegisterError(message);
};

const REGISTRAR_RE = /^(Ведомость в банк|Ведомость на счета|Премия) (\d{4}-\d{6}) от (\d{2})\.(\d{2})\.(\d{4})$/;
const MONTH_START_RE = /^01\.(\d{2})\.(\d{4}) 0:00:00$/;

export interface IRegisterLine {
  /** Номер строки в ведомости с 1 (после сворачивания). */
  lineNo: number;
  fullName: string;
  department: string | null;
  amountCents: number;
  lineKey: string;
  /** «НомерСтроки» регистра, из которых строка собрана (больше одного — свёрнутый зачёт). */
  sourceRows: number[];
}

export interface IRegisterDocument {
  guid: string;
  /** Регистратор как в файле: «Ведомость в банк 0000-002644 от 09.10.2026», «Премия 0000-000788 от 05.10.2026». */
  registrar: string;
  docNumber: string;
  /** YYYY-MM-DD. */
  docDate: string;
  /** YYYY-MM-01. */
  periodMonth: string;
  paymentMethod: string;
  totalCents: number;
  contentHash: string;
  lines: IRegisterLine[];
}

interface IRegisterRow {
  registrar: string;
  rowNo: number;
  fullName: string;
  paymentMethod: string;
  department: string | null;
  amountCents: number;
}

/** Синтетический ГУИД ведомости регистра: UUID v5 от «номер|дата». */
export const registerDocGuid = (docNumber: string, docDate: string): string => (
  uuidv5(`${docNumber}|${docDate}`, PAYOUTS_REGISTER_GUID_NAMESPACE)
);

const optionalText = (value: unknown, where: string): string | null => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  if (typeof value !== 'string') return fail(`${where}: ожидался текст, а не «${String(value)}»`);
  return value.trim();
};

const requiredText = (value: unknown, where: string): string => optionalText(value, where) ?? fail(`${where}: пусто`);

/** Сумма xlsx (число) → копейки; больше двух знаков или не число — ошибка. */
export const registerAmountCents = (value: unknown, where: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${where}: сумма «${String(value)}» не число`);
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6) fail(`${where}: в сумме ${value} больше двух знаков после запятой`);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > 999_999_999_999) fail(`${where}: сумма ${value} слишком большая`);
  if (cents === 0) fail(`${where}: нулевая сумма`);
  return cents;
};

const isoDate = (day: string, month: string, year: string, where: string): string => {
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) fail(`${where}: дата ${day}.${month}.${year}`);
  return iso;
};

/** Заголовок → номер столбца по имени. Неизвестный, повторный или пропущенный обязательный столбец — ошибка. */
const parseHeader = (header: readonly unknown[] | undefined): Map<RegisterColumn, number> => {
  const got = (header ?? []).map(cell => String(cell ?? '').trim());
  const known = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  const lastNamed = got.reduce((last, name, index) => (name === '' ? last : index), -1);
  const columns = new Map<RegisterColumn, number>();
  got.slice(0, lastNamed + 1).forEach((name, index) => {
    if (!known.has(name) || columns.has(name as RegisterColumn)) fail(`Заголовок не тот: ${got.join(' | ')}`);
    columns.set(name as RegisterColumn, index);
  });
  if (REQUIRED_COLUMNS.some(name => !columns.has(name))) fail(`Заголовок не тот: ${got.join(' | ')}`);
  return columns;
};

/** Строки листа (первая — заголовок, `sheet_to_json(header: 1, raw: true)`) → проверенные строки регистра. */
const parseRows = (sheet: readonly unknown[][], month: string): IRegisterRow[] => {
  const [header, ...body] = sheet;
  const columns = parseHeader(header);
  const [year, mm] = month.split('-');
  const rowNos = new Map<string, number>();
  const rows: IRegisterRow[] = [];
  body.forEach((cells, index) => {
    if (cells.every(cell => cell === null || cell === undefined || String(cell).trim() === '')) return;
    const where = `Строка ${index + 2}`;
    const has = (name: RegisterColumn): boolean => columns.has(name);
    const cell = (name: RegisterColumn): unknown => cells[columns.get(name) ?? -1];
    const settlement = MONTH_START_RE.exec(String(cell('ПериодВзаиморасчетов') ?? '').trim());
    if (!settlement || settlement[1] !== mm || settlement[2] !== year) fail(`${where}: «ПериодВзаиморасчетов» не ${month}`);
    // Месяц регистрации — этот или позже: премию за месяц проводят и в следующем.
    const registered = MONTH_START_RE.exec(String(cell('Период') ?? '').trim());
    if (!registered || `${registered[2]}-${registered[1]}` < month) fail(`${where}: «Период» раньше ${month}`);
    if (requiredText(cell('Организация'), where) !== PAYOUTS_REGISTER_ORGANIZATION) fail(`${where}: другая организация`);
    if (has('Сторно') && requiredText(cell('Сторно'), where) !== 'Нет') fail(`${where}: сторно`);
    if (has('ГруппаНачисленияУдержанияВыплаты')
      && requiredText(cell('ГруппаНачисленияУдержанияВыплаты'), where) !== 'Выплачено') {
      fail(`${where}: группа не «Выплачено»`);
    }
    const kind = requiredText(cell('ВидВзаиморасчетов'), `${where}, ВидВзаиморасчетов`);
    if (!kind.startsWith('Выплата ')) fail(`${where}: вид взаиморасчётов «${kind}» — не выплата`);
    const fullName = requiredText(cell('ФизическоеЛицо'), `${where}, ФизическоеЛицо`);
    const employee = requiredText(cell('Сотрудник'), `${where}, Сотрудник`);
    if (normalizePayoutName(fullName) !== normalizePayoutName(employee)) {
      fail(`${where}: ФизическоеЛицо «${fullName}» ≠ Сотрудник «${employee}»`);
    }
    const registrar = requiredText(cell('Регистратор'), `${where}, Регистратор`);
    // Без «НомерСтроки» — номер по порядку строк документа в файле.
    const rowNo = has('НомерСтроки') ? cell('НомерСтроки') : (rowNos.get(registrar) ?? 0) + 1;
    if (typeof rowNo !== 'number' || !Number.isInteger(rowNo) || rowNo <= 0) {
      return fail(`${where}: НомерСтроки «${String(rowNo)}»`);
    }
    rowNos.set(registrar, rowNo);
    rows.push({
      registrar,
      rowNo,
      fullName,
      paymentMethod: requiredText(cell('РегистраторСпособВыплаты'), `${where}, способ выплаты`),
      department: optionalText(cell('Подразделение'), `${where}, Подразделение`),
      amountCents: registerAmountCents(cell('СуммаВзаиморасчетов'), where),
    });
  });
  if (rows.length === 0) fail('В регистре нет строк');
  return rows;
};

/** Строки одной ведомости по «НомерСтроки»; у человека с минусом — одна свёрнутая строка на месте первой. */
const documentLines = (registrar: string, rows: readonly IRegisterRow[]): Omit<IRegisterLine, 'lineKey'>[] => {
  const byPerson = new Map<string, IRegisterRow[]>();
  for (const row of rows) {
    const key = normalizePayoutName(row.fullName);
    byPerson.set(key, [...(byPerson.get(key) ?? []), row]);
  }
  const lines: Omit<IRegisterLine, 'lineKey'>[] = [];
  const collapsed = new Set<string>();
  for (const row of rows) {
    const key = normalizePayoutName(row.fullName);
    const group = byPerson.get(key) ?? [row];
    if (!group.some(item => item.amountCents < 0)) {
      lines.push({ lineNo: 0, fullName: row.fullName, department: row.department, amountCents: row.amountCents, sourceRows: [row.rowNo] });
      continue;
    }
    if (collapsed.has(key)) continue;
    collapsed.add(key);
    if (new Set(group.map(item => item.department)).size > 1) fail(`${registrar}: ${row.fullName} — разные подразделения`);
    const amountCents = group.reduce((sum, item) => sum + item.amountCents, 0);
    if (amountCents <= 0) fail(`${registrar}: ${row.fullName} — итог после зачёта ${amountCents / 100} не больше нуля`);
    lines.push({
      lineNo: 0, fullName: row.fullName, department: row.department, amountCents, sourceRows: group.map(item => item.rowNo),
    });
  }
  return lines.map((line, index) => ({ ...line, lineNo: index + 1 }));
};

/** Регистр за месяц (YYYY-MM) → документы по дате и номеру. Любое расхождение с ожидаемым форматом — ошибка. */
export const buildRegisterDocuments = (sheet: readonly unknown[][], month: string): IRegisterDocument[] => {
  if (!/^\d{4}-\d{2}$/.test(month)) fail(`Месяц «${month}» — нужен YYYY-MM`);
  const rows = parseRows(sheet, month);
  const byRegistrar = new Map<string, IRegisterRow[]>();
  for (const row of rows) byRegistrar.set(row.registrar, [...(byRegistrar.get(row.registrar) ?? []), row]);

  const seenNumberDate = new Map<string, string>();
  const documents = [...byRegistrar].map(([registrar, docRows]): IRegisterDocument => {
    const match = REGISTRAR_RE.exec(registrar) ?? fail(`Регистратор «${registrar}» — формат не поддержан`);
    const docNumber = match[2];
    const docDate = isoDate(match[3], match[4], match[5], registrar);
    const numberDate = `${docNumber}|${docDate}`;
    const other = seenNumberDate.get(numberDate);
    if (other) fail(`Номер и дата совпали у «${other}» и «${registrar}»`);
    seenNumberDate.set(numberDate, registrar);
    const methods = new Set(docRows.map(row => row.paymentMethod));
    if (methods.size > 1) fail(`${registrar}: несколько способов выплаты — ${[...methods].join(', ')}`);
    const rowNos = new Set(docRows.map(row => row.rowNo));
    if (rowNos.size !== docRows.length) fail(`${registrar}: НомерСтроки повторяется`);

    const raw = documentLines(registrar, [...docRows].sort((a, b) => a.rowNo - b.rowNo));
    const keys = buildPayoutLineKeys(raw);
    const lines = raw.map((line, index) => ({ ...line, lineKey: keys[index] }));
    const guid = registerDocGuid(docNumber, docDate);
    const periodMonth = `${month}-01`;
    const paymentMethod = docRows[0].paymentMethod;
    const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
    return {
      guid,
      registrar,
      docNumber,
      docDate,
      periodMonth,
      paymentMethod,
      totalCents,
      contentHash: payoutContentHash({ guid, docNumber, docDate, periodMonth, paymentMethod, totalCents, lineKeys: keys }),
      lines,
    };
  });
  return documents.sort((a, b) => a.docDate.localeCompare(b.docDate) || a.docNumber.localeCompare(b.docNumber));
};
