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

/** Строка подходит под один из вариантов с ошибкой (`_` — любой символ). */
const fuzzyMatcher = (variants: ReadonlyArray<string>): RegExp =>
  new RegExp(variants.map(variant => variant.split('_').map(escapeRegExp).join('.')).join('|'));

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
  const terms = fioSearchTerms(search);
  if (terms.length === 0) {
    const searchedRows = [...rows];
    return { searchedRows, visibleRows: finalize(searchedRows) };
  }
  const texts = rows.map(row => normalizeFioSearch(getText(row) ?? ''));
  const exactRows = rows.filter((_, i) => terms.some(term => texts[i].includes(term)));
  const exactVisible = finalize(exactRows);
  const fuzzy = [...new Set(terms.flatMap(buildFuzzyVariants))];
  if (exactVisible.length > 0 || fuzzy.length === 0) return { searchedRows: exactRows, visibleRows: exactVisible };
  const matcher = fuzzyMatcher(fuzzy);
  const searchedRows = rows.filter((_, i) => terms.some(term => texts[i].includes(term)) || matcher.test(texts[i]));
  return { searchedRows, visibleRows: finalize(searchedRows) };
};
