import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HIDDEN_STAFF_COLUMNS,
  isDefaultStaffColumns,
  loadHiddenStaffColumns,
  parseHiddenStaffColumns,
  saveHiddenStaffColumns,
  serializeHiddenStaffColumns,
  STAFF_COLUMNS_KEY,
  staffTableMinWidth,
  visibleStaffColumns,
} from './staffColumns';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseHiddenStaffColumns', () => {
  it('ничего не сохранено или мусор — умолчание: скрыт только «Участок»', () => {
    for (const raw of [null, '', '{', '{"site":true}', '"site"']) {
      expect([...parseHiddenStaffColumns(raw)], String(raw)).toEqual(['site']);
    }
  });

  it('явный пустой выбор — всё видно; неизвестные ключи отбрасываются', () => {
    expect(parseHiddenStaffColumns('[]').size).toBe(0);
    expect([...parseHiddenStaffColumns('["comment","sign","name",1,"department"]')]).toEqual(['comment', 'department']);
  });
});

describe('serializeHiddenStaffColumns', () => {
  it('пустой выбор сохраняется как [], порядок — таблицы', () => {
    expect(serializeHiddenStaffColumns(new Set())).toBe('[]');
    expect(serializeHiddenStaffColumns(new Set(['comment', 'site', 'department'] as const))).toBe('["department","site","comment"]');
    expect(parseHiddenStaffColumns(serializeHiddenStaffColumns(new Set())).size).toBe(0);
  });
});

describe('хранилище', () => {
  it('«Показать все» переживает перезагрузку; недоступное хранилище — умолчание без ошибки', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => { store.set(key, value); },
      },
    });
    expect([...loadHiddenStaffColumns()]).toEqual(['site']);
    saveHiddenStaffColumns(new Set());
    expect(store.get(STAFF_COLUMNS_KEY)).toBe('[]');
    expect(loadHiddenStaffColumns().size).toBe(0);

    vi.stubGlobal('window', { localStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
    expect([...loadHiddenStaffColumns()]).toEqual(['site']);
    expect(() => saveHiddenStaffColumns(new Set(['site'] as const))).not.toThrow();
  });
});

describe('видимые столбцы и ширина', () => {
  it('по умолчанию — прежние столбцы и прежние 1610/1654px', () => {
    expect(isDefaultStaffColumns(DEFAULT_HIDDEN_STAFF_COLUMNS)).toBe(true);
    expect(isDefaultStaffColumns(new Set())).toBe(false);
    expect(visibleStaffColumns(DEFAULT_HIDDEN_STAFF_COLUMNS)).toEqual(
      ['department', 'position', 'hire_date', 'birth_date', 'schedule', 'main_object', 'comment'],
    );
    expect(staffTableMinWidth(DEFAULT_HIDDEN_STAFF_COLUMNS, false)).toBe(1610);
    expect(staffTableMinWidth(DEFAULT_HIDDEN_STAFF_COLUMNS, true)).toBe(1654);
  });

  it('«Участок» — между «Отделом» и «Должностью», +150px', () => {
    expect(visibleStaffColumns(new Set()).slice(0, 3)).toEqual(['department', 'site', 'position']);
    expect(staffTableMinWidth(new Set(), false)).toBe(1760);
  });
});
