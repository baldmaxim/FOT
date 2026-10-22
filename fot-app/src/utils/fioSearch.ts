/**
 * Поиск по ФИО над таблицей: без учёта регистра, ё = е, пробелы схлопнуты; ввод в английской раскладке ищется
 * и как русский; ничего точного в видимых строках — допуск одной ошибки. Тот же алгоритм —
 * fot-server/src/utils/fio-search.utils.ts (случаи в тестах совпадают).
 */
const MAX_TERM_LENGTH = 64;
const FUZZY_MIN_LENGTH = 5;
// Число вариантов растёт линейно (~4 на символ); дальше 20 символов перебор заметно тормозит.
const FUZZY_MAX_LENGTH = 20;
const FUZZY_TERM_RE = /^[\p{L} -]+$/u;

// QWERTY → ЙЦУКЕН, включая Shift-символы на месте русских букв.
const EN_TO_RU: Readonly<Record<string, string>> = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з', '[': 'х', ']': 'ъ',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д', ';': 'ж', "'": 'э',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь', ',': 'б', '.': 'ю', '`': 'ё',
  '{': 'х', '}': 'ъ', ':': 'ж', '"': 'э', '<': 'б', '>': 'ю', '~': 'ё',
};

export const normalizeFioSearch = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е');

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

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Точный поиск или с одной ошибкой — решается по итоговому набору экрана. */
export type FioSearchMode = 'exact' | 'fuzzy';

export interface IFioMatcher {
  /** Есть варианты с одной ошибкой (ввод 5–20 символов из букв, пробелов и дефисов). */
  hasFuzzy: boolean;
  /** ФИО: точно (ё = е, регистр, пробелы, раскладка) или ещё и с одной ошибкой. */
  matches: (text: string | null | undefined, mode: FioSearchMode) => boolean;
}

/** null — пустой ввод: фильтра нет. */
export const createFioMatcher = (search: string): IFioMatcher | null => {
  const terms = fioSearchTerms(search);
  if (terms.length === 0) return null;
  const variants = [...new Set(terms.flatMap(buildFuzzyVariants))];
  // Текст нормализован (пробелы схлопнуты), поэтому `_` — просто любой символ.
  const fuzzyRe = variants.length > 0
    ? new RegExp(variants.map(variant => variant.split('_').map(escapeRegExp).join('.')).join('|'))
    : null;
  return {
    hasFuzzy: fuzzyRe !== null,
    matches: (text, mode) => {
      const normalized = normalizeFioSearch(text ?? '');
      if (terms.some(term => normalized.includes(term))) return true;
      return mode === 'fuzzy' && fuzzyRe !== null && fuzzyRe.test(normalized);
    },
  };
};

/**
 * Фильтр с поиском по ФИО: run('exact'); пусто и есть варианты — run('fuzzy'). run считает итоговый набор
 * экрана целиком (все прочие фильтры внутри), иначе точный, убранный другим фильтром, ошибочно не пустит опечатку.
 */
export const withFioFallback = <T,>(matcher: IFioMatcher | null, run: (mode: FioSearchMode) => T[]): T[] => {
  const exact = run('exact');
  if (exact.length > 0 || !matcher?.hasFuzzy) return exact;
  return run('fuzzy');
};

/** Список, где ищут только по ФИО: пустой ввод — тот же список; иначе точные, а без них — с одной ошибкой. */
export const filterByFio = <T,>(rows: T[], getFio: (row: T) => string | null | undefined, search: string): T[] => {
  const matcher = createFioMatcher(search);
  if (!matcher) return rows;
  return withFioFallback(matcher, mode => rows.filter(row => matcher.matches(getFio(row), mode)));
};

/** Прочие текстовые поля (должность, отдел, организация, объект): вхождение без учёта регистра, ё = е. */
export const includesText = (text: string | null | undefined, search: string): boolean =>
  normalizeFioSearch(text ?? '').includes(normalizeFioSearch(search));

export interface IFioSearchResult<Row> {
  /** После поиска, до фильтров столбцов — для вариантов фильтров. */
  searchedRows: Row[];
  /** После поиска и вида таблицы (фильтры, сортировка). */
  visibleRows: Row[];
}

/**
 * Поиск по ФИО + вид таблицы (finalize). Точные совпадения среди видимых есть — только они;
 * нет — плюс строки с одной ошибкой.
 */
export const searchRowsByFio = <Row,>(
  rows: ReadonlyArray<Row>,
  getText: (row: Row) => string | null,
  search: string,
  finalize: (rows: Row[]) => Row[],
): IFioSearchResult<Row> => {
  const matcher = createFioMatcher(search);
  if (!matcher) {
    const searchedRows = [...rows];
    return { searchedRows, visibleRows: finalize(searchedRows) };
  }
  let searchedRows: Row[] = [];
  const visibleRows = withFioFallback(matcher, mode => {
    searchedRows = rows.filter(row => matcher.matches(getText(row), mode));
    return finalize(searchedRows);
  });
  return { searchedRows, visibleRows };
};
