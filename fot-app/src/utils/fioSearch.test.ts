import { describe, expect, it } from 'vitest';
import { buildFuzzyVariants, fioSearchTerms, searchRowsByFio, switchLayoutToRu } from './fioSearch';

// Те же случаи — в fot-server/src/utils/fio-search.utils.test.ts: алгоритм сервера и фронта один.
describe('fioSearch: термы', () => {
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

describe('fioSearch: одна ошибка', () => {
  it('пропуск, лишняя, неверная буква, перестановка', () => {
    expect(buildFuzzyVariants('грнев')).toContain('гр_нев');
    expect(buildFuzzyVariants('гринеев')).toContain('гринев');
    expect(buildFuzzyVariants('грибев')).toContain('гри_ев');
    expect(buildFuzzyVariants('гирнев')).toContain('гринев');
  });

  it('без самого терма, без дублей и без «любого символа» по краям (его покрывает «лишняя буква»)', () => {
    const variants = buildFuzzyVariants('гринев');
    expect(variants).not.toContain('гринев');
    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.filter(v => v.startsWith('_') || v.endsWith('_'))).toEqual([]);
    expect(variants).toContain('гринв');
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

interface IRow { name: string; dept: string }

const ROWS: IRow[] = [
  { name: 'Гринёв Андрей Александрович', dept: 'Линия' },
  { name: 'Гриневич  Николай', dept: 'Склад' },
  { name: 'Смирнова Анна', dept: 'Склад' },
  { name: 'Смирнава Ольга', dept: 'Линия' },
  { name: 'Тест_Подчёркивание', dept: 'Линия' },
  { name: 'Процент 50%', dept: 'Линия' },
  { name: 'Иванов И.И.', dept: 'Линия' },
  { name: 'Иванов ИХИ', dept: 'Линия' },
];
const nameOf = (row: IRow): string => row.name;
const all = (rows: IRow[]): IRow[] => rows;
const onlyLine = (rows: IRow[]): IRow[] => rows.filter(row => row.dept === 'Линия');
const names = (rows: IRow[]): string[] => rows.map(nameOf);

describe('searchRowsByFio', () => {
  it('ё = е, раскладка, пробелы, спецсимволы буквально', () => {
    const grin = ['Гринёв Андрей Александрович', 'Гриневич  Николай'];
    expect(names(searchRowsByFio(ROWS, nameOf, 'грине', all).visibleRows)).toEqual(grin);
    expect(names(searchRowsByFio(ROWS, nameOf, 'uhbyt', all).visibleRows)).toEqual(grin);
    expect(names(searchRowsByFio(ROWS, nameOf, 'Гриневич Николай', all).visibleRows)).toEqual(['Гриневич  Николай']);
    expect(names(searchRowsByFio(ROWS, nameOf, '_', all).visibleRows)).toEqual(['Тест_Подчёркивание']);
    expect(names(searchRowsByFio(ROWS, nameOf, '50%', all).visibleRows)).toEqual(['Процент 50%']);
    expect(names(searchRowsByFio(ROWS, nameOf, 'и.и', all).visibleRows)).toEqual(['Иванов И.И.']);
  });

  it('одна ошибка находит, две — нет', () => {
    const grin = ['Гринёв Андрей Александрович', 'Гриневич  Николай'];
    for (const typo of ['гинёв', 'гриневв', 'гринеф', 'гирнев']) {
      expect(names(searchRowsByFio(ROWS, nameOf, typo, all).visibleRows), typo).toEqual(grin);
    }
    expect(searchRowsByFio(ROWS, nameOf, 'гирнеф', all).visibleRows).toEqual([]);
  });

  it('опечатка — только если среди видимых нет точных', () => {
    expect(names(searchRowsByFio(ROWS, nameOf, 'смирнова', all).visibleRows)).toEqual(['Смирнова Анна']);
    // Точная «Смирнова» скрыта фильтром столбца — видна похожая.
    const filtered = searchRowsByFio(ROWS, nameOf, 'смирнова', onlyLine);
    expect(names(filtered.visibleRows)).toEqual(['Смирнава Ольга']);
    // Для вариантов фильтров — строки до фильтра столбца.
    expect(names(filtered.searchedRows)).toEqual(['Смирнова Анна', 'Смирнава Ольга']);
  });

  it('пустой поиск — все строки', () => {
    const result = searchRowsByFio(ROWS, nameOf, '  ', all);
    expect(result.searchedRows).toEqual(ROWS);
    expect(result.visibleRows).toEqual(ROWS);
  });
});
