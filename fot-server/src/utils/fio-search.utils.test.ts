import { describe, expect, it, vi } from 'vitest';
import {
  buildFioSearch,
  buildFuzzyVariants,
  createFioTextMatcher,
  fioConditionSql,
  fioExactConditionSql,
  fioFuzzyConditionSql,
  fioSearchTerms,
  includesText,
  switchLayoutToRu,
  withFioFallback,
  type FioSearchTable,
} from './fio-search.utils.js';

// Те же случаи — в fot-app/src/utils/fioSearch.test.ts: алгоритм сервера и фронта один.
describe('fio-search: термы', () => {
  it('регистр, ё = е, пробелы', () => {
    expect(fioSearchTerms('  Гринё  ')).toEqual(['грине']);
    expect(fioSearchTerms('ГРИНЁВ   андрей')).toEqual(['гринев андрей']);
    expect(fioSearchTerms('   ')).toEqual([]);
  });

  it('английская раскладка: строчные, заглавные, Shift и пунктуация; результат нормализован', () => {
    expect(fioSearchTerms('uhbyt')).toEqual(['uhbyt', 'грине']);
    expect(fioSearchTerms('UHBYT')).toEqual(['uhbyt', 'грине']);
    expect(fioSearchTerms('uhby`d')).toEqual(['uhby`d', 'гринев']);
    expect(switchLayoutToRu("qwertyuiop[]asdfghjkl;'zxcvbnm,.`")).toBe('йцукенгшщзхъфывапролджэячсмитьбюе');
    expect(switchLayoutToRu('{}:"<>~')).toBe('хъжэбюе');
    expect(switchLayoutToRu('Uhby`d Fylhtq')).toBe('гринев андрей');
  });

  it('кириллица без латиницы — без второго терма', () => {
    expect(fioSearchTerms('Иванов И.И.')).toEqual(['иванов и.и.']);
  });

  it('ввод длиннее 64 символов обрезается', () => {
    expect(fioSearchTerms('а'.repeat(70))[0]).toHaveLength(64);
  });
});

describe('fio-search: одна ошибка', () => {
  it('пропуск, лишняя, неверная буква, перестановка', () => {
    expect(buildFuzzyVariants('грнев')).toContain('гр_нев'); // пропуск
    expect(buildFuzzyVariants('гринеев')).toContain('гринев'); // лишняя
    expect(buildFuzzyVariants('грибев')).toContain('гри_ев'); // неверная
    expect(buildFuzzyVariants('гирнев')).toContain('гринев'); // перестановка
  });

  it('без самого терма, без дублей и без «любого символа» по краям (его покрывает «лишняя буква»)', () => {
    const variants = buildFuzzyVariants('гринев');
    expect(variants).not.toContain('гринев');
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.filter(v => v.startsWith('_') || v.endsWith('_'))).toEqual([]);
    expect(variants).toContain('гринв'); // неверная последняя — через «лишнюю»
  });

  it('границы длины: 4 и 21 — нет, 5 и 20 — да', () => {
    expect(buildFuzzyVariants('гриш')).toEqual([]);
    expect(buildFuzzyVariants('грише').length).toBeGreaterThan(0);
    expect(buildFuzzyVariants('а'.repeat(19) + 'б').length).toBeGreaterThan(0);
    expect(buildFuzzyVariants('а'.repeat(20) + 'б')).toEqual([]);
  });

  it('цифры и спецсимволы — без вариантов', () => {
    expect(buildFuzzyVariants('12345')).toEqual([]);
    expect(buildFuzzyVariants('грин%')).toEqual([]);
    expect(buildFuzzyVariants('грин_в')).toEqual([]);
    expect(buildFuzzyVariants('гр\\нев')).toEqual([]);
  });

  it('двойной фамилии и ФИО с пробелом — допустимы', () => {
    expect(buildFuzzyVariants('петров-водкин').length).toBeGreaterThan(0);
    expect(buildFuzzyVariants('гринев андрй')).toContain('гринев андр_й');
  });
});

describe('fio-search: регулярные выражения', () => {
  it('ё = е, раскладка, пробелы — любые пробелы', () => {
    expect(buildFioSearch('Гринё')?.exact).toEqual(['грин[её]']);
    expect(buildFioSearch('uhbyt')?.exact).toEqual(['uhbyt', 'грин[её]']);
    expect(buildFioSearch('гринев  андрей')?.exact).toEqual(['грин[её]в\\s+андр[её]й']);
  });

  it('спецсимволы regex — буквально; % и _ — как есть', () => {
    expect(buildFioSearch('а.б(в[г*д+ж?з|и\\к')?.exact).toEqual(['а\\.б\\(в\\[г\\*д\\+ж\\?з\\|и\\\\к']);
    expect(buildFioSearch('50%_')?.exact).toEqual(['50%_']);
  });

  it('обрезка до 64 символов не ломает экранирование', () => {
    expect(buildFioSearch('а'.repeat(63) + '\\\\')?.exact[0]).toBe(`${'а'.repeat(63)}\\\\`);
  });

  it('варианты с ошибкой: `_` — один символ нормализованного ФИО; без совпадающих с точными', () => {
    const search = buildFioSearch('грнев');
    expect(search?.exact).toEqual(['грн[её]в']);
    expect(search?.fuzzy).toContain('гр(?:\\s+|\\S)н[её]в');
    expect(search?.fuzzy).not.toContain('грн[её]в');
  });

  it('пустой ввод — null; короткий — без вариантов', () => {
    expect(buildFioSearch('  ')).toBeNull();
    expect(buildFioSearch('гри')).toEqual({ exact: ['гри'], fuzzy: [] });
  });
});

describe('fio-search: условия SQL', () => {
  it('точное — OR в скобках, номера параметров от текущих', () => {
    const params: unknown[] = ['x'];
    const sql = fioExactConditionSql('employees', params, buildFioSearch('uhbyt')!);
    expect(sql).toBe('(full_name ~* $2 OR full_name ~* $3)');
    expect(params).toEqual(['x', 'uhbyt', 'грин[её]']);
  });

  it('с ошибкой — точные ∪ варианты одним массивом, по индексу отдельно (LATERAL)', () => {
    const params: unknown[] = [];
    const search = buildFioSearch('грнев')!;
    const sql = fioFuzzyConditionSql('e', params, search);
    expect(sql).toMatch(/^e\.id IN \(SELECT fz\.id FROM unnest\(\$1::text\[\]\)/);
    expect(sql).toContain('fx.full_name ~* fz_re.re');
    expect(params).toEqual([[...search.exact, ...search.fuzzy]]);
  });

  it('таблица — только из белого списка', () => {
    expect(() => fioExactConditionSql('x; DROP TABLE employees' as FioSearchTable, [], buildFioSearch('а')!)).toThrow();
  });
});

describe('fio-search: user_profiles, режим, подсказки', () => {
  it('user_profiles (up): точное — по up.full_name (индекс 110), с ошибкой — перебором ~* ANY', () => {
    const search = buildFioSearch('грнев')!;
    const exactParams: unknown[] = [];
    expect(fioExactConditionSql('up', exactParams, search)).toBe('(up.full_name ~* $1)');
    const fuzzyParams: unknown[] = ['x'];
    expect(fioConditionSql('up', fuzzyParams, search, 'fuzzy')).toBe('up.full_name ~* ANY($2::text[])');
    expect(fuzzyParams[1]).toEqual([...search.exact, ...search.fuzzy]);
  });

  it('withFioFallback: точное есть — второго запроса нет; пусто — с ошибкой; вариантов нет — без второго', async () => {
    const run = vi.fn(async (mode: 'exact' | 'fuzzy') => (mode === 'exact' ? ['точный'] : ['с ошибкой']));
    expect(await withFioFallback(buildFioSearch('грнев')!, run)).toEqual(['точный']);
    expect(run).toHaveBeenCalledTimes(1);

    const empty = vi.fn(async (mode: 'exact' | 'fuzzy') => (mode === 'exact' ? [] : ['с ошибкой']));
    expect(await withFioFallback(buildFioSearch('грнев')!, empty)).toEqual(['с ошибкой']);
    expect(await withFioFallback(buildFioSearch('гри')!, empty)).toEqual([]);
  });
});

describe('fio-search: проверка в JS', () => {
  it('точно: ё = е, регистр, пробелы, раскладка; с ошибкой — только в режиме fuzzy', () => {
    const matcher = createFioTextMatcher('грнев')!;
    expect(matcher.hasFuzzy).toBe(true);
    expect(matcher.matches('Гринёв  Андрей', 'exact')).toBe(false);
    expect(matcher.matches('Гринёв  Андрей', 'fuzzy')).toBe(true);
    expect(matcher.matches('Петров', 'fuzzy')).toBe(false);
    expect(createFioTextMatcher('uhbyt')!.matches('ГРИНЁВ', 'exact')).toBe(true);
    expect(createFioTextMatcher('гринев андрей')!.matches('Гринёв   Андрей', 'exact')).toBe(true);
    expect(createFioTextMatcher('  ')).toBeNull();
  });

  it('спецсимволы — буквально; две ошибки — нет', () => {
    expect(createFioTextMatcher('и.и')!.matches('Иванов ИХИ', 'fuzzy')).toBe(false);
    expect(createFioTextMatcher('и.и')!.matches('Иванов И.И.', 'exact')).toBe(true);
    expect(createFioTextMatcher('гирнеф')!.matches('Гринёв', 'fuzzy')).toBe(false);
  });

  it('includesText: прочие поля — вхождение, ё = е, без раскладки', () => {
    expect(includesText('Главный инженёр', 'инженер')).toBe(true);
    expect(includesText('Бухгалтерия', ',e[')).toBe(false);
    expect(includesText(null, 'а')).toBe(false);
  });
});
