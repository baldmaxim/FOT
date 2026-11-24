import { describe, expect, it } from 'vitest';

import {
  clearSessionStates,
  parseOneOf,
  readSessionState,
  sessionStateKey,
  writeSessionState,
} from './sessionState';

// Состояние экранов «Проживания» в sessionStorage (24.11.2026): у каждой учётки свой ключ, битое — начальное,
// при выходе стирается.

const memoryStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
    clear: () => data.clear(),
  };
};

const parseMode = parseOneOf(['current', 'archive'] as const);

describe('состояние экрана в sessionStorage', () => {
  it('ключ — свой у каждого пользователя; без пользователя не храним', () => {
    expect(sessionStateKey('housing.dormitory.mode', 'u1')).toBe('housing.dormitory.mode:u1');
    expect(sessionStateKey('housing.dormitory.mode', null)).toBeNull();
    expect(sessionStateKey(null, 'u1')).toBeNull();

    const storage = memoryStorage();
    writeSessionState(storage, sessionStateKey('housing.dormitory.mode', 'u1'), 'archive');
    expect(readSessionState(storage, sessionStateKey('housing.dormitory.mode', 'u1'), parseMode)).toBe('archive');
    // Следующая учётка в той же вкладке — не видит.
    expect(readSessionState(storage, sessionStateKey('housing.dormitory.mode', 'u2'), parseMode)).toBeNull();
  });

  it('битый JSON и чужая форма — null (начальное значение)', () => {
    const storage = memoryStorage();
    storage.setItem('housing.dormitory.mode:u1', '{не json');
    expect(readSessionState(storage, 'housing.dormitory.mode:u1', parseMode)).toBeNull();
    storage.setItem('housing.dormitory.mode:u1', '"history"');
    expect(readSessionState(storage, 'housing.dormitory.mode:u1', parseMode)).toBeNull();
  });

  it('выход стирает состояние экранов всех учёток, остальное не трогает', () => {
    const storage = memoryStorage();
    storage.setItem('housing.dormitory.place:u1', '"Общ. Свободы 35"');
    storage.setItem('registry-view:housing.dormitory:u2', '{}');
    storage.setItem('2fa_verified', 'true');
    clearSessionStates(storage);
    expect([...Array(storage.length).keys()].map(index => storage.key(index))).toEqual(['2fa_verified']);
  });
});
