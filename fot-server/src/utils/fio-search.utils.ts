/**
 * Поиск по ФИО: без учёта регистра, ё = е, пробелы схлопнуты; ввод в английской раскладке ищется и как
 * русский; при пустом точном результате — допуск одной ошибки. Тот же алгоритм — fot-app/src/utils/fioSearch.ts
 * (случаи в тестах совпадают).
 *
 * В SQL — регулярные выражения `full_name ~* …` по сырому ФИО: их берёт trigram-индекс
 * idx_employees_full_name_trgm (миграция 080); выражение над нормализованным ФИО индекс отключало.
 */
import { normalizeFullName } from './fio.utils.js';

const MAX_TERM_LENGTH = 64;
const FUZZY_MIN_LENGTH = 5;
// Число вариантов растёт линейно (~4 на символ); дальше 20 символов перебор заметно тормозит.
const FUZZY_MAX_LENGTH = 20;
const FUZZY_TERM_RE = /^[\p{L} -]+$/u;
const REGEX_SPECIAL_RE = /[.^$*+?()[\]{}|\\]/g;

// QWERTY → ЙЦУКЕН, включая Shift-символы на месте русских букв.
const EN_TO_RU: Readonly<Record<string, string>> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
  '{': 'х', '}': 'ъ', ':': 'ж', '"': 'э', '<': 'б', '>': 'ю', '~': 'ё',
};

export const normalizeFioSearch = (value: string): string => normalizeFullName(value, { collapseYo: true });

export const switchLayoutToRu = (value: string): string =>
  normalizeFioSearch([...value.toLowerCase()].map(c => EN_TO_RU[c] ?? c).join(''));

/** Варианты с одной ошибкой для поиска подстрокой; `_` — любой один символ. */
export const buildFuzzyVariants = (term: string): string[] => {
  if (term.length < FUZZY_MIN_LENGTH || term.length > FUZZY_MAX_LENGTH || !FUZZY_TERM_RE.test(term)) return [];
  const variants = new Set<string>();
  for (let i = 0; i < term.length; i += 1) {
    // Лишняя буква во вводе.
    variants.add(term.slice(0, i) + term.slice(i + 1));
    // Неверная буква (по краям её покрывает «лишняя»).
    if (i > 0 && i < term.length - 1) variants.add(`${term.slice(0, i)}_${term.slice(i + 1)}`);
    // Пропущенная буква (по краям подстроки вставка ничего не меняет).
    if (i > 0) variants.add(`${term.slice(0, i)}_${term.slice(i)}`);
    // Переставлены соседние.
    if (i < term.length - 1 && term[i] !== term[i + 1]) {
      variants.add(term.slice(0, i) + term[i + 1] + term[i] + term.slice(i + 2));
    }
  }
  variants.delete(term);
  return [...variants];
};

/** Нормализованные термы: ввод и, если в нём есть латиница, он же в русской раскладке. */
export const fioSearchTerms = (raw: string): string[] => {
  const term = normalizeFioSearch(raw).slice(0, MAX_TERM_LENGTH).trim();
  if (!term) return [];
  const terms = [term];
  if (/[a-z]/.test(term)) {
    const switched = switchLayoutToRu(term);
    if (switched && switched !== term) terms.push(switched);
  }
  return terms;
};

/**
 * Нормализованный терм → регулярное выражение по сырому ФИО (`~*`, без учёта регистра): е — и «е», и «ё»,
 * пробел — любые пробелы; `_` варианта с ошибкой — один символ нормализованного ФИО.
 */
const termToRegex = (term: string, wildcard: boolean): string => [...term].map(c => {
  if (c === 'е') return '[её]';
  if (c === ' ') return '\\s+';
  if (wildcard && c === '_') return '(?:\\s+|\\S)';
  return c.replace(REGEX_SPECIAL_RE, '\\$&');
}).join('');

export interface IFioSearch {
  /** Регулярные выражения точного поиска. */
  exact: string[];
  /** Регулярные выражения с одной ошибкой — только если точный поиск ничего не нашёл. */
  fuzzy: string[];
}

export const buildFioSearch = (raw: string): IFioSearch | null => {
  const terms = fioSearchTerms(raw);
  if (terms.length === 0) return null;
  const exact = terms.map(term => termToRegex(term, false));
  const exactSet = new Set(exact);
  // Варианты только из букв, пробела и дефиса: `_` в них — всегда «любой символ».
  const fuzzy = [...new Set(terms.flatMap(buildFuzzyVariants).map(variant => termToRegex(variant, true)))]
    .filter(regex => !exactSet.has(regex));
  return { exact, fuzzy };
};

const FIO_SEARCH_COLUMNS = {
  employees: { name: 'full_name', id: 'id' },
  e: { name: 'e.full_name', id: 'e.id' },
} as const;
/** Таблица employees в запросе: без алиаса или `e`. */
export type FioSearchTable = keyof typeof FIO_SEARCH_COLUMNS;

const fioColumns = (table: FioSearchTable) => {
  const columns = FIO_SEARCH_COLUMNS[table];
  if (!columns) throw new Error(`Недопустимая таблица поиска ФИО: ${table}`);
  return columns;
};

/** Точные совпадения: OR по выражениям — каждое идёт по trigram-индексу (BitmapOr). */
export const fioExactConditionSql = (table: FioSearchTable, params: unknown[], search: IFioSearch): string => {
  const { name } = fioColumns(table);
  return `(${search.exact.map(regex => {
    params.push(regex);
    return `${name} ~* $${params.length}`;
  }).join(' OR ')})`;
};

/**
 * Точные и с одной ошибкой. Одно выражение со всеми вариантами индекс не берёт — каждое ищется по индексу
 * отдельно (LATERAL), найденные id объединяются.
 */
export const fioFuzzyConditionSql = (table: FioSearchTable, params: unknown[], search: IFioSearch): string => {
  const { id } = fioColumns(table);
  params.push([...search.exact, ...search.fuzzy]);
  return `${id} IN (SELECT fz.id FROM unnest($${params.length}::text[]) AS fz_re(re)`
    + ' CROSS JOIN LATERAL (SELECT fx.id FROM employees fx WHERE fx.full_name ~* fz_re.re) fz)';
};
