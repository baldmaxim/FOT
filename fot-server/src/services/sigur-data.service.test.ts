import { describe, expect, it } from 'vitest';
import { SigurDataService } from './sigur-data.service.js';

describe('SigurDataService.buildCardNumberVariants', () => {
  it('matches W26 "fac,num" with hex equivalent', () => {
    const a = SigurDataService.buildCardNumberVariants('123,45678');
    const b = SigurDataService.buildCardNumberVariants('007BB26E');
    const intersect = [...a].some(v => b.has(v));
    expect(intersect).toBe(true);
  });

  it('matches W26 with decimal representation', () => {
    const a = SigurDataService.buildCardNumberVariants('123,45678');
    expect(a.has('8106606')).toBe(true);
  });

  it('matches 16-hex with no-leading-zeros version', () => {
    const a = SigurDataService.buildCardNumberVariants('0000000001A2B3C4');
    const b = SigurDataService.buildCardNumberVariants('1A2B3C4');
    const intersect = [...a].some(v => b.has(v));
    expect(intersect).toBe(true);
  });

  it('matches hex BE with hex LE (byte reverse)', () => {
    const a = SigurDataService.buildCardNumberVariants('1A2B3C4D');
    expect(a.has('4D3C2B1A')).toBe(true);
  });

  it('matches decimal with hex', () => {
    const a = SigurDataService.buildCardNumberVariants('439041101');
    expect(a.has('1A2B3C4D')).toBe(true);
  });

  it('returns empty set for empty input', () => {
    expect(SigurDataService.buildCardNumberVariants('').size).toBe(0);
    expect(SigurDataService.buildCardNumberVariants('   ').size).toBe(0);
  });

  it('returns empty set for non-string', () => {
    expect(SigurDataService.buildCardNumberVariants(null as unknown as string).size).toBe(0);
    expect(SigurDataService.buildCardNumberVariants(undefined as unknown as string).size).toBe(0);
  });

  it('preserves uppercase original', () => {
    const a = SigurDataService.buildCardNumberVariants('1a2b3c4d');
    expect(a.has('1A2B3C4D')).toBe(true);
  });

  it('cross-matches all five formats from one card', () => {
    // Имитация: одна и та же карта в разных представлениях агента/Sigur
    const sigurCard16 = SigurDataService.buildCardNumberVariants('0000000001A2B3C4');
    const hexNoZeros = SigurDataService.buildCardNumberVariants('1A2B3C4');
    const decBe = SigurDataService.buildCardNumberVariants('27440068');
    const hex8 = SigurDataService.buildCardNumberVariants('01A2B3C4');

    const intersects = (left: Set<string>, right: Set<string>): boolean =>
      [...left].some(v => right.has(v));

    expect(intersects(sigurCard16, hexNoZeros)).toBe(true);
    expect(intersects(sigurCard16, decBe)).toBe(true);
    expect(intersects(hex8, decBe)).toBe(true);
  });

  it('W26 "53,44009" generates standalone num variants (decimal + hex)', () => {
    const a = SigurDataService.buildCardNumberVariants('53,44009');
    expect(a.has('44009')).toBe(true);  // num отдельно
    expect(a.has('ABE9')).toBe(true);   // num в hex
    expect(a.has('0000ABE9')).toBe(true); // padded
  });

  it('cross-matches W26 input with Sigur stored as plain num', () => {
    const w26 = SigurDataService.buildCardNumberVariants('53,44009');
    const stored = SigurDataService.buildCardNumberVariants('44009');
    const intersect = [...w26].some(v => stored.has(v));
    expect(intersect).toBe(true);
  });

  it('cross-matches W26 input with Sigur stored as 4-hex', () => {
    const w26 = SigurDataService.buildCardNumberVariants('53,44009');
    const stored = SigurDataService.buildCardNumberVariants('ABE9');
    const intersect = [...w26].some(v => stored.has(v));
    expect(intersect).toBe(true);
  });

  it('cross-matches sigurCard 16-hex with full UID stored in Sigur', () => {
    const agent = SigurDataService.buildCardNumberVariants('1835ABE900000000');
    const stored = SigurDataService.buildCardNumberVariants('1835ABE900000000');
    const intersect = [...agent].some(v => stored.has(v));
    expect(intersect).toBe(true);
  });

  it('cross-matches hexUid 35ABE900 with decimal 900458752', () => {
    const hex = SigurDataService.buildCardNumberVariants('35ABE900');
    const dec = SigurDataService.buildCardNumberVariants('900458752');
    const intersect = [...hex].some(v => dec.has(v));
    expect(intersect).toBe(true);
  });
});

describe('SigurDataService.collectCardSearchableValues', () => {
  it('extracts string and number values, excluding meta fields', () => {
    const card = {
      id: 42,
      cardId: 42,
      number: '53,44009',
      format: 'W26',
      status: 'active',
      expirationDate: '2030-01-01',
      employeeId: 7,
      wiegandCode: 'ABE9',
      customField: 12345,
    };
    const values = SigurDataService.collectCardSearchableValues(card);
    expect(values).toContain('53,44009');
    expect(values).toContain('ABE9');
    expect(values).toContain('12345');
    expect(values).not.toContain('42');         // id/cardId исключены
    expect(values).not.toContain('W26');        // format исключён
    expect(values).not.toContain('active');     // status исключён
    expect(values).not.toContain('2030-01-01'); // expirationDate исключён
    expect(values).not.toContain('7');          // employeeId исключён
  });

  it('skips empty/null values', () => {
    const card = { number: '', cardNumber: null, custom: '   ', other: 'real' };
    const values = SigurDataService.collectCardSearchableValues(card);
    expect(values).toEqual(['real']);
  });
});
