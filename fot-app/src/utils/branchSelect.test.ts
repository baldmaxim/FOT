import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  branchOptionLabel,
  buildBranchOptions,
  readStoredBranch,
  resolveSelectedBranch,
  writeStoredBranch,
} from './branchSelect';

const LINE = { id: 'line', name: 'ЛИНИЯ', visibleCount: 6 };
const GENERAL = { id: 'general', name: 'ЛИНИЯ-Общестрой', visibleCount: 18 };
const OPENED = { id: 'opened', name: 'Склад', visibleCount: 0, keepWhenEmpty: true };
const EMPTY = { id: 'empty', name: 'Тендерный отдел', visibleCount: 0 };

describe('buildBranchOptions', () => {
  it('без поиска: отделы со строками и открытые кнопкой (0); пустые без кнопки — нет', () => {
    const options = buildBranchOptions([LINE, OPENED, EMPTY, GENERAL], false);
    expect(options).toEqual([
      { id: 'line', name: 'ЛИНИЯ', count: 6 },
      { id: 'opened', name: 'Склад', count: 0 },
      { id: 'general', name: 'ЛИНИЯ-Общестрой', count: 18 },
    ]);
    expect(options.map(branchOptionLabel)).toEqual(['ЛИНИЯ (6)', 'Склад (0)', 'ЛИНИЯ-Общестрой (18)']);
  });

  it('при поиске: только отделы с совпадениями, открытый пустой не держится', () => {
    expect(buildBranchOptions([{ ...LINE, visibleCount: 0 }, OPENED, { ...GENERAL, visibleCount: 1 }], true)).toEqual([
      { id: 'general', name: 'ЛИНИЯ-Общестрой', count: 1 },
    ]);
  });

  it('пустой список', () => {
    expect(buildBranchOptions([EMPTY], false)).toEqual([]);
    expect(buildBranchOptions([], true)).toEqual([]);
  });
});

describe('resolveSelectedBranch', () => {
  const options = buildBranchOptions([LINE, GENERAL], false);

  it('по умолчанию — первый отдел', () => {
    expect(resolveSelectedBranch(options, null)).toBe('line');
  });

  it('сохранённый отдел есть в списке — он', () => {
    expect(resolveSelectedBranch(options, 'general')).toBe('general');
  });

  it('сохранённый отдел исчез — первый, а ручной выбор вернётся, когда отдел снова появится', () => {
    const narrowed = buildBranchOptions([{ ...LINE, visibleCount: 1 }, { ...GENERAL, visibleCount: 0 }], true);
    expect(resolveSelectedBranch(narrowed, 'general')).toBe('line');
    expect(resolveSelectedBranch(options, 'general')).toBe('general');
  });

  it('список пуст — ничего не выбрано', () => {
    expect(resolveSelectedBranch([], 'general')).toBeNull();
  });
});

describe('хранилище выбора', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('пишет и читает', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    });
    writeStoredBranch('k', 'general');
    expect(readStoredBranch('k')).toBe('general');
  });

  it('хранилище бросает исключение — null и без ошибки', () => {
    const denied = (): never => { throw new Error('denied'); };
    vi.stubGlobal('window', { localStorage: { getItem: denied, setItem: denied } });
    expect(() => writeStoredBranch('k', 'general')).not.toThrow();
    expect(readStoredBranch('k')).toBeNull();
  });

  it('хранилища нет вовсе — null и без ошибки', () => {
    vi.stubGlobal('window', {});
    expect(() => writeStoredBranch('k', 'general')).not.toThrow();
    expect(readStoredBranch('k')).toBeNull();
  });
});
