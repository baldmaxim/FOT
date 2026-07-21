import { describe, expect, it } from 'vitest';
import { getMoscowDismissalTiming, moscowTodayIso } from './date.utils.js';

describe('moscowTodayIso', () => {
  it('returns Moscow calendar date in YYYY-MM-DD', () => {
    // 14:00 UTC = 17:00 MSK — обе зоны дают одно и то же число.
    const noonUtc = new Date('2026-05-20T14:00:00Z');
    expect(moscowTodayIso(noonUtc)).toBe('2026-05-20');
  });

  it('catches UTC↔MSK rollover at 22:00 UTC (01:00 next-day MSK)', () => {
    // 22:30 UTC = 01:30 MSK следующих суток. UTC slice вернул бы 2026-05-19,
    // moscowTodayIso должна вернуть 2026-05-20.
    const lateUtc = new Date('2026-05-19T22:30:00Z');
    expect(moscowTodayIso(lateUtc)).toBe('2026-05-20');
    expect(lateUtc.toISOString().slice(0, 10)).toBe('2026-05-19'); // контраст с прежним поведением
  });

  it('handles 00:30 UTC (03:30 MSK same day)', () => {
    const earlyUtc = new Date('2026-05-20T00:30:00Z');
    expect(moscowTodayIso(earlyUtc)).toBe('2026-05-20');
  });
});

describe('getMoscowDismissalTiming', () => {
  // МСК = UTC+3 круглый год.
  const atMsk = (iso: string): Date => new Date(`${iso}+03:00`);

  it('до порога: 22:59 МСК — увольнение «на сегодня» откладывается', () => {
    const t = getMoscowDismissalTiming(atMsk('2026-05-20T22:59:00'));
    expect(t).toMatchObject({ today: '2026-05-20', timeHm: '22:59', cutoffPassed: false, dueCutoff: '2026-05-19' });
  });

  it('ровно 23:00 МСК — порог пройден, dueCutoff = сегодня', () => {
    const t = getMoscowDismissalTiming(atMsk('2026-05-20T23:00:00'));
    expect(t).toMatchObject({ today: '2026-05-20', timeHm: '23:00', cutoffPassed: true, dueCutoff: '2026-05-20' });
  });

  it('00:00 МСК — новый день, порог не пройден', () => {
    const t = getMoscowDismissalTiming(atMsk('2026-05-20T00:00:00'));
    expect(t).toMatchObject({ today: '2026-05-20', timeHm: '00:00', cutoffPassed: false, dueCutoff: '2026-05-19' });
  });

  it('полдень UTC = 15:00 МСК — до порога', () => {
    const t = getMoscowDismissalTiming(new Date('2026-05-20T12:00:00Z'));
    expect(t).toMatchObject({ today: '2026-05-20', timeHm: '15:00', cutoffPassed: false });
  });

  it('UTC-время, попадающее в следующие московские сутки', () => {
    // 22:30 UTC = 01:30 МСК 21-го.
    const t = getMoscowDismissalTiming(new Date('2026-05-20T22:30:00Z'));
    expect(t).toMatchObject({ today: '2026-05-21', timeHm: '01:30', cutoffPassed: false, dueCutoff: '2026-05-20' });
  });

  it('граница месяца: 01 числа до порога → dueCutoff = последний день прошлого месяца', () => {
    const t = getMoscowDismissalTiming(atMsk('2026-03-01T10:00:00'));
    expect(t.dueCutoff).toBe('2026-02-28');
  });

  it('граница года: 01 января до порога → 31 декабря', () => {
    const t = getMoscowDismissalTiming(atMsk('2026-01-01T09:15:00'));
    expect(t).toMatchObject({ today: '2026-01-01', dueCutoff: '2025-12-31' });
  });

  it('h23: полночь возвращается как 00:xx, а не 24:xx', () => {
    expect(getMoscowDismissalTiming(atMsk('2026-05-20T00:45:00')).timeHm).toBe('00:45');
  });
});
