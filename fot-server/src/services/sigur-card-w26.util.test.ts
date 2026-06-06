import { describe, expect, it } from 'vitest';
import { deriveCardW26 } from './sigur-card-w26.util.js';

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
    expect(() => deriveCardW26('zzz')).toThrow(/Некорректный UID/);
  });

  it('W26 с facility вне диапазона → ошибка', () => {
    expect(() => deriveCardW26('300,5')).toThrow(/Некорректный W26/);
  });

  it('W26 с number вне диапазона → ошибка', () => {
    expect(() => deriveCardW26('1,70000')).toThrow(/Некорректный W26/);
  });
});
