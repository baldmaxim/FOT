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
});
