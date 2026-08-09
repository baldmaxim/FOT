import { describe, expect, it } from 'vitest';
import { deriveCardW26, deriveSigurCardIdentity, formatW26 } from './sigur-card-w26.util.js';

describe('deriveCardW26', () => {
  it('сырой UID с ведущим байтом 18 и хвостовыми нулями → младшие 3 байта', () => {
    expect(deriveCardW26('182678A500000000')).toEqual({
      value: '2678A5',
      facility: 0x26, // 38
      number: 0x78A5, // 30885
      w26: '38,30885',
    });
  });

  it('ground-truth: 18A83E54.. → A83E54 → 168,15956', () => {
    const r = deriveCardW26('18A83E5400000000');
    expect(r.value).toBe('A83E54');
    expect(r.w26).toBe('168,15956');
  });

  it('ground-truth: 187AE136.. → 7AE136 → 122,57654', () => {
    const r = deriveCardW26('187AE13600000000');
    expect(r.value).toBe('7AE136');
    expect(r.w26).toBe('122,57654');
  });

  it('значимый байт оканчивается нулём — НЕ стрипать по полубайтам (1827549000000000)', () => {
    const r = deriveCardW26('1827549000000000');
    expect(r.value).toBe('275490');
    expect(r.facility).toBe(0x27); // 39
    expect(r.number).toBe(0x5490); // 21648
    expect(r.w26).toBe('39,21648');
  });

  it('значимый байт оканчивается нулём (1823735000000000)', () => {
    const r = deriveCardW26('1823735000000000');
    expect(r.value).toBe('237350');
    expect(r.w26).toBe('35,29520');
  });

  it('готовый W26 (facility,number) парсится обратно в тот же value', () => {
    const r = deriveCardW26('168,15956');
    expect(r.value).toBe('A83E54');
    expect(r.facility).toBe(168);
    expect(r.number).toBe(15956);
  });

  it('W26 с пробелами вокруг запятой', () => {
    expect(deriveCardW26(' 122 , 57654 ').value).toBe('7AE136');
  });

  it('lowercase hex UID нормализуется', () => {
    expect(deriveCardW26('18a83e5400000000').value).toBe('A83E54');
  });

  it('пустой ввод → ошибка', () => {
    expect(() => deriveCardW26('')).toThrow(/Пустой/);
    expect(() => deriveCardW26('   ')).toThrow(/Пустой/);
  });

  it('мусор без hex-символов → ошибка', () => {
    expect(() => deriveCardW26('zzz')).toThrow(/Слишком короткий UID/);
  });

  it('слишком короткий UID → ошибка', () => {
    expect(() => deriveCardW26('1827')).toThrow(/Слишком короткий UID/);
  });

  it('W26 с facility вне диапазона → ошибка', () => {
    expect(() => deriveCardW26('300,5')).toThrow(/Некорректный W26/);
  });

  it('W26 с number вне диапазона → ошибка', () => {
    expect(() => deriveCardW26('1,70000')).toThrow(/Некорректный W26/);
  });
});

describe('deriveSigurCardIdentity', () => {
  // Регрессия: value каталога Sigur — 3 байта (6 hex), deriveCardW26 на нём законно бросает.
  // Раньше боевой скрипт звал декодер напрямую и падал на 100% карт.
  it('value каталога (6 hex) + formattedValue → идентичность из formattedValue', () => {
    expect(deriveSigurCardIdentity('26CFFD', '038,53245')).toEqual({
      value: '26CFFD',
      w26: '038,53245',
      facility: 38,
    });
  });

  it('сырой UID ридера (16 hex) → декодируется напрямую, value канонический', () => {
    expect(deriveSigurCardIdentity('1826CFFD00000000', '')).toEqual({
      value: '26CFFD',
      w26: '038,53245',
      facility: 38,
    });
  });

  it('только formattedValue без паддинга → канонический W26', () => {
    expect(deriveSigurCardIdentity('', '38,53245')).toEqual({
      value: '26CFFD',
      w26: '038,53245',
      facility: 38,
    });
  });

  it('мусорный value, но валидный formattedValue → фолбэк срабатывает', () => {
    const identity = deriveSigurCardIdentity('garbage', '038,53245');
    expect(identity.w26).toBe('038,53245');
    expect(identity.value).toBe('garbage');
  });

  it('мусор в обоих полях → w26 null (гасить нельзя)', () => {
    expect(deriveSigurCardIdentity('garbage', '???')).toEqual({
      value: 'garbage',
      w26: null,
      facility: null,
    });
  });

  it('оба поля пустые → всё null', () => {
    expect(deriveSigurCardIdentity('', '')).toEqual({ value: null, w26: null, facility: null });
  });
});

describe('formatW26', () => {
  it('паддит facility до 3 и number до 5 знаков', () => {
    expect(formatW26(deriveCardW26('38,53245'))).toBe('038,53245');
  });
});
