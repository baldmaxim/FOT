import { describe, it, expect } from 'vitest';
import { deriveCardW26 } from './sigur-card-w26.util.js';
import {
  normalizeW26Search,
  formatW26,
  isExactW26,
  selectPrimaryCardBinding,
} from './sigur-live-admin.service.js';

describe('normalizeW26Search', () => {
  it('035,30723 и 35,30723 дают одну карту (value 237803)', () => {
    const a = normalizeW26Search('035,30723');
    const b = normalizeW26Search('35,30723');
    expect(a?.value).toBe('237803');
    expect(b?.value).toBe('237803');
    expect(a?.value).toBe(b?.value);
  });

  it('пробелы вокруг запятой допустимы', () => {
    expect(normalizeW26Search(' 35 , 30723 ')?.value).toBe('237803');
  });

  it('без запятой (12345) → null, W26-поиск не перехватывает', () => {
    expect(normalizeW26Search('12345')).toBeNull();
  });

  it('вне диапазона (facility>255 / number>65535) → null', () => {
    expect(normalizeW26Search('999,99999')).toBeNull();
    expect(normalizeW26Search('256,0')).toBeNull();
  });

  it('валидный, но потенциально несуществующий (250,65000) → не null', () => {
    expect(normalizeW26Search('250,65000')).not.toBeNull();
  });
});

describe('formatW26', () => {
  it('всегда FFF,NNNNN', () => {
    expect(formatW26(deriveCardW26('35,30723'))).toBe('035,30723');
    expect(formatW26(deriveCardW26('1,2'))).toBe('001,00002');
    expect(formatW26(deriveCardW26('255,65535'))).toBe('255,65535');
  });
});

describe('isExactW26', () => {
  const decoded = deriveCardW26('35,30723'); // value 237803

  it('совпадение по полному value', () => {
    expect(isExactW26({ value: '237803' }, decoded)).toBe(true);
    expect(isExactW26({ value: '0237803' }, decoded)).toBe(true); // ведущие нули игнор
  });

  it('совпадение по formattedValue', () => {
    expect(isExactW26({ formattedValue: '035,30723' }, decoded)).toBe(true);
    expect(isExactW26({ value: '', formattedValue: '35,30723' }, decoded)).toBe(true);
  });

  it('чужая/префиксная карта не матчится', () => {
    expect(isExactW26({ value: '2378A3' }, decoded)).toBe(false);
    expect(isExactW26({ value: '2378' }, decoded)).toBe(false);
    expect(isExactW26({ formattedValue: '35,30724' }, decoded)).toBe(false);
    expect(isExactW26({}, decoded)).toBe(false);
  });
});

describe('selectPrimaryCardBinding', () => {
  const map = new Map<string, string>([
    ['10', '035,30723'],
    ['20', '040,00001'],
    ['30', '050,00002'],
  ]);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it('выбирает неистёкшую карту, а не истёкшую', () => {
    const w26 = selectPrimaryCardBinding(
      [{ cardId: 20, expirationDate: past }, { cardId: 10, expirationDate: future }],
      map,
    );
    expect(w26).toBe('035,30723');
  });

  it('при отсутствии дат берёт первую резолвящуюся, не падает', () => {
    const w26 = selectPrimaryCardBinding(
      [{ cardId: 30, expirationDate: null }, { cardId: 10, expirationDate: null }],
      map,
    );
    expect(w26).toBe('050,00002');
  });

  it('пустой список → null', () => {
    expect(selectPrimaryCardBinding([], map)).toBeNull();
  });

  it('карта не в каталоге → null', () => {
    expect(selectPrimaryCardBinding([{ cardId: 999, expirationDate: future }], map)).toBeNull();
  });

  it('String(cardId): числовой cardId матчит строковый ключ', () => {
    expect(selectPrimaryCardBinding([{ cardId: 10, expirationDate: future }], map)).toBe('035,30723');
  });
});
