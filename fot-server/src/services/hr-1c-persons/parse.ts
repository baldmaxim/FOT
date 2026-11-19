/**
 * Выгрузка 1С «ФизЛица» → нормализованные физлица для «Реквизитов».
 *
 * Файл: строка — запись трудоустройства, ключ физлица — Физлицо_id_all (у повторно
 * принятых строк несколько). Числовые ячейки Excel теряют ведущие нули (ИНН, номер
 * паспорта) — форматы восстановлены по хэшам уже заведённых профилей:
 *   ИНН 11 цифр → 12 (с проверкой контрольной суммы);
 *   паспорт РФ — «серия номер», номер до 6 цифр; иностранный — серия+номер слитно,
 *   у Узбекистана номер до 7 цифр;
 *   патент — `{серия}№{номер}` (так хранит PassDesk-перенос).
 * Значения ПДн из модуля наружу не логируются — только номера строк и названия полей.
 */
import { createHash } from 'node:crypto';

export const PERSONS_1C_REQUIRED_COLUMNS = [
  'ФизЛицо', 'Физлицо_id_all', 'ИНН', 'СтраховойНомерПФР', 'Отдел', 'Паспорт_Вид', 'Паспорт_Серия',
  'Паспорт_Номер', 'Паспорт_ДатаВыдачи', 'Паспорт_КемВыдан', 'Паспорт_КодПодразделения',
  'Паспорт_ФМС_ДокументСрокДействия', 'Гражданство', 'КИГ', 'Патент_ДатаВыдачи', 'Патент_Номер',
  'Патент_Серия', 'АдресПоПрописке', 'ТелефонФЛ', 'ДатаРождения', 'ДатаУвольнения',
] as const;

type Column = typeof PERSONS_1C_REQUIRED_COLUMNS[number];

const RF_PASSPORT = 'паспорт гражданина российской федерации';
const FOREIGN_PASSPORT = 'паспорт иностранного гражданина';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IPassport1c {
  type: 'russian' | 'foreign';
  number: string;
  date: string | null;
  issuer: string | null;
  departmentCode: string | null;
  expiryDate: string | null;
}

export interface IPatent1c {
  number: string;
  issueDate: string | null;
}

/** Строка файла после нормализации. */
export interface IRow1c {
  rowNumber: number;
  idAll: string;
  fullName: string;
  department: string;
  dismissalDate: string | null;
  birthDate: string | null;
  snils: string | null;
  inn: string | null;
  citizenship: string | null;
  passport: IPassport1c | null;
  patent: IPatent1c | null;
  kig: string | null;
  registrationAddress: string | null;
  phone: string | null;
  /** Что отброшено при разборе (без значений): «ИНН: контрольная сумма». */
  problems: string[];
}

/** Физлицо, работающее на дату среза: поля и блоки — из активных строк, без смешивания. */
export interface IPerson1c {
  idAll: string;
  fullName: string;
  departments: string[];
  rowNumbers: number[];
  activeRows: number;
  birthDate: string | null;
  snils: string | null;
  inn: string | null;
  citizenship: string | null;
  passport: IPassport1c | null;
  patent: IPatent1c | null;
  kig: string | null;
  registrationAddress: string | null;
  phone: string | null;
  /** Поля/блоки, различающиеся между активными строками, — не заносятся. */
  rowConflicts: string[];
  /** ФИО, ДР, СНИЛС или ИНН различаются между активными строками — только ручная проверка. */
  keyConflict: boolean;
  problems: string[];
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
const orNull = (s: string): string | null => (s ? s : null);
const digits = (v: unknown): string => text(v).replace(/\D/g, '');

export const sha256OfBuffer = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** «дд.мм.гггг» (или ISO из ячейки-даты) → «гггг-мм-дд»; несуществующая дата → null. */
export const parseRuDate = (v: unknown): string | null => {
  const s = text(v);
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = s.includes('.') ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return `${y}-${mo}-${d}`;
};

/** Контрольное число СНИЛС; номера до 001-001-998 не проверяются. */
export const isValidSnils = (d: string): boolean => {
  if (!/^\d{11}$/.test(d)) return false;
  const body = d.slice(0, 9);
  if (Number(body) <= 1001998) return true;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(body[i]) * (9 - i);
  let ctrl = sum < 100 ? sum : sum % 101;
  if (ctrl === 100) ctrl = 0;
  return ctrl === Number(d.slice(9));
};

/** Контрольные разряды ИНН физлица (12 цифр). */
export const isValidPersonInn = (d: string): boolean => {
  if (!/^\d{12}$/.test(d)) return false;
  const n = (weights: number[]): number => weights.reduce((s, w, i) => s + w * Number(d[i]), 0) % 11 % 10;
  return n([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[10]) && n([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(d[11]);
};

/** СНИЛС: цифры, ведущие нули числовой ячейки — только если контрольное число сходится. */
export const normalizeSnils1c = (v: unknown): { value: string | null; problem: string | null } => {
  const d = digits(v);
  if (!d) return { value: null, problem: null };
  const padded = d.length >= 9 && d.length < 11 ? d.padStart(11, '0') : d;
  if (padded.length !== 11 || !isValidSnils(padded)) return { value: null, problem: 'СНИЛС: неверный формат или контрольное число' };
  return { value: padded, problem: null };
};

/** ИНН: 11 цифр — потерянный ведущий 0 (подтверждено хэшами), затем контрольные разряды. */
export const normalizeInn1c = (v: unknown): { value: string | null; problem: string | null } => {
  const d = digits(v);
  if (!d || /^0+$/.test(d)) return { value: null, problem: d ? 'ИНН: пустое значение' : null };
  const padded = d.length === 11 ? `0${d}` : d;
  if (!isValidPersonInn(padded)) return { value: null, problem: 'ИНН: неверный формат или контрольная сумма' };
  return { value: padded, problem: null };
};

export const normalizePassport1c = (row: Record<Column, unknown>): { value: IPassport1c | null; problem: string | null } => {
  const kind = text(row['Паспорт_Вид']).toLowerCase();
  const rawNumber = text(row['Паспорт_Номер']).replace(/\s/g, '').toUpperCase();
  if (!kind && !rawNumber) return { value: null, problem: null };
  const common = {
    date: parseRuDate(row['Паспорт_ДатаВыдачи']),
    issuer: orNull(text(row['Паспорт_КемВыдан'])),
    departmentCode: orNull(text(row['Паспорт_КодПодразделения'])),
    expiryDate: parseRuDate(row['Паспорт_ФМС_ДокументСрокДействия']),
  };
  if (kind === RF_PASSPORT) {
    let series = digits(row['Паспорт_Серия']);
    let num = rawNumber.replace(/\D/g, '');
    if (!series && num.length === 10) [series, num] = [num.slice(0, 4), num.slice(4)];
    else if (num.length === 10 && num.startsWith(series)) num = num.slice(4);
    if (series.length !== 4 || num.length < 1 || num.length > 6) return { value: null, problem: 'Паспорт РФ: неверная серия или номер' };
    return { value: { type: 'russian', number: `${series} ${num.padStart(6, '0')}`, ...common }, problem: null };
  }
  if (kind === FOREIGN_PASSPORT) {
    const series = text(row['Паспорт_Серия']).replace(/\s/g, '').toUpperCase();
    if (!rawNumber) return { value: null, problem: 'Паспорт: нет номера' };
    const uzbek = text(row['Гражданство']).toUpperCase() === 'УЗБЕКИСТАН';
    const num = uzbek && /^[A-Z]{2}$/.test(series) && /^\d{1,6}$/.test(rawNumber) ? rawNumber.padStart(7, '0') : rawNumber;
    return { value: { type: 'foreign', number: `${series}${num}`, ...common }, problem: null };
  }
  return { value: null, problem: 'Документ не паспорт (вид документа в 1С другой) — паспорт не заносится' };
};

export const normalizePatent1c = (row: Record<Column, unknown>): IPatent1c | null => {
  const num = digits(row['Патент_Номер']);
  if (!num) return null;
  const series = digits(row['Патент_Серия']);
  return { number: series ? `${series}№${num}` : num, issueDate: parseRuDate(row['Патент_ДатаВыдачи']) };
};

/** Телефон → «+7…» для российских 10/11-значных, «+…» для остальных. */
export const normalizePhone1c = (v: unknown): string | null => {
  let d = digits(v);
  if (d.length === 11 && d.startsWith('8')) d = `7${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith('9')) d = `7${d}`;
  return d.length >= 10 && d.length <= 15 ? `+${d}` : null;
};

/** Строки листа (первая — заголовок) → нормализованные строки; неизвестный формат — ошибка. */
export const parsePersons1cRows = (rows: string[][]): { rows: IRow1c[]; headers: string[] } => {
  if (rows.length === 0) throw new Error('Файл пуст');
  const headers = rows[0].map(h => text(h));
  const missing = PERSONS_1C_REQUIRED_COLUMNS.filter(c => !headers.includes(c));
  if (missing.length > 0) throw new Error(`В файле нет столбцов: ${missing.join(', ')}`);
  const out: IRow1c[] = [];
  rows.slice(1).forEach((cells, i) => {
    if (cells.every(c => !text(c))) return;
    const row = Object.fromEntries(headers.map((h, k) => [h, cells[k] ?? ''])) as Record<Column, unknown>;
    const rowNumber = i + 2;
    const idAll = text(row['Физлицо_id_all']).toLowerCase();
    if (!UUID_RE.test(idAll)) throw new Error(`Строка ${rowNumber}: Физлицо_id_all не UUID`);
    const problems: string[] = [];
    const snils = normalizeSnils1c(row['СтраховойНомерПФР']);
    const inn = normalizeInn1c(row['ИНН']);
    const passport = normalizePassport1c(row);
    for (const p of [snils.problem, inn.problem, passport.problem]) if (p) problems.push(p);
    const birthRaw = text(row['ДатаРождения']);
    const birthDate = parseRuDate(birthRaw);
    if (birthRaw && !birthDate) problems.push('Дата рождения: неверный формат');
    out.push({
      rowNumber,
      idAll,
      fullName: text(row['ФизЛицо']),
      department: text(row['Отдел']),
      dismissalDate: parseRuDate(row['ДатаУвольнения']),
      birthDate,
      snils: snils.value,
      inn: inn.value,
      citizenship: orNull(text(row['Гражданство'])),
      passport: passport.value,
      patent: normalizePatent1c(row),
      kig: orNull(text(row['КИГ']).replace(/\s/g, '').toUpperCase()),
      registrationAddress: orNull(text(row['АдресПоПрописке'])),
      phone: normalizePhone1c(row['ТелефонФЛ']),
      problems,
    });
  });
  return { rows: out, headers };
};

const nameKey = (s: string): string => s.normalize('NFKC').replace(/ё/gi, 'е').replace(/\s+/g, ' ').trim().toLowerCase();

/** Строка активна на дату среза: без даты увольнения или уволен позже среза. */
export const isRowActive = (row: IRow1c, asOf: string): boolean => row.dismissalDate === null || row.dismissalDate > asOf;

/** Одно значение из всех активных строк; разные — конфликт (не смешиваем записи разных приёмов). */
const pick = <T>(rows: IRow1c[], get: (r: IRow1c) => T | null, name: string, conflicts: string[]): T | null => {
  const values = new Map<string, T>();
  for (const r of rows) {
    const v = get(r);
    values.set(v === null ? '' : JSON.stringify(v), v as T);
  }
  if (values.size === 1) return values.values().next().value ?? null;
  conflicts.push(name);
  return null;
};

/** Строки файла → работающие на дату среза физлица (по id_all) + число уволенных. */
export const collapsePersons = (rows: IRow1c[], asOf: string): { working: IPerson1c[]; dismissed: number } => {
  const groups = new Map<string, IRow1c[]>();
  for (const r of rows) groups.set(r.idAll, [...(groups.get(r.idAll) ?? []), r]);
  const working: IPerson1c[] = [];
  let dismissed = 0;
  for (const [idAll, all] of groups) {
    const active = all.filter(r => isRowActive(r, asOf));
    if (active.length === 0) { dismissed += 1; continue; }
    const conflicts: string[] = [];
    const keyNames = new Set(active.map(r => nameKey(r.fullName)));
    const birthDate = pick(active, r => r.birthDate, 'birth_date', conflicts);
    const snils = pick(active, r => r.snils, 'snils', conflicts);
    const inn = pick(active, r => r.inn, 'inn', conflicts);
    const keyConflict = keyNames.size > 1 || ['birth_date', 'snils', 'inn'].some(k => conflicts.includes(k));
    working.push({
      idAll,
      fullName: active[0].fullName,
      departments: [...new Set(active.map(r => r.department).filter(Boolean))],
      rowNumbers: active.map(r => r.rowNumber),
      activeRows: active.length,
      birthDate,
      snils,
      inn,
      citizenship: pick(active, r => r.citizenship, 'citizenship', conflicts),
      passport: pick(active, r => r.passport, 'passport', conflicts),
      patent: pick(active, r => r.patent, 'patent', conflicts),
      kig: pick(active, r => r.kig, 'kig', conflicts),
      registrationAddress: pick(active, r => r.registrationAddress, 'registration_address', conflicts),
      phone: pick(active, r => r.phone, 'phone', conflicts),
      rowConflicts: conflicts,
      keyConflict,
      problems: [...new Set(active.flatMap(r => r.problems))],
    });
  }
  return { working, dismissed };
};
