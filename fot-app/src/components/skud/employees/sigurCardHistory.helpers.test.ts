import { describe, expect, it } from 'vitest';
import type { SigurCardHistoryEntry } from '../../../types';
import {
  describeSigurCardHistoryEntry,
  findSigurCardExpirationMismatch,
  formatSigurCardHistoryMoment,
} from './sigurCardHistory.helpers';

const entry = (over: Partial<SigurCardHistoryEntry>): SigurCardHistoryEntry => ({
  id: '1',
  createdAt: '2026-08-12T07:32:48.313Z',
  kind: 'update_card_binding',
  startDate: '2021-05-12 21:00:00',
  expirationDate: '2026-12-11 20:59:59',
  previousExpiration: null,
  previousStartDate: null,
  actorName: 'Есенов Максим АДМ',
  ...over,
});

describe('describeSigurCardHistoryEntry: поштучная правка', () => {
  it('старая запись без прежних дат — только «Срок до», без даты начала', () => {
    expect(describeSigurCardHistoryEntry(entry({}))).toBe('Срок до 11.12.2026');
  });

  it('изменился срок — «было → стало», неизменное начало не показывается', () => {
    expect(describeSigurCardHistoryEntry(entry({
      previousExpiration: '2026-10-09 20:59:59',
      previousStartDate: '2021-05-12 21:00:00',
    }))).toBe('Срок: 09.10.2026 → 11.12.2026');
  });

  it('изменились срок и начало — обе пары через запятую', () => {
    expect(describeSigurCardHistoryEntry(entry({
      startDate: '2026-10-01 00:00:00',
      previousExpiration: '2026-10-09 20:59:59',
      previousStartDate: '2021-05-12 21:00:00',
    }))).toBe('Срок: 09.10.2026 → 11.12.2026, Начало: 12.05.2021 → 01.10.2026');
  });

  it('другое время того же дня — не изменение', () => {
    expect(describeSigurCardHistoryEntry(entry({
      previousExpiration: '2026-12-11 23:59:59',
      previousStartDate: '2021-05-12 21:00:00',
    }))).toBe('Срок до 11.12.2026');
  });

  it('массовое продление — как раньше', () => {
    expect(describeSigurCardHistoryEntry(entry({
      kind: 'bulk_extend',
      startDate: null,
      expirationDate: '2026-12-31',
      previousExpiration: '2026-10-01 23:59:59',
    }))).toBe('Массовое продление: 01.10.2026 → 31.12.2026');
  });
});

describe('findSigurCardExpirationMismatch', () => {
  it('текущий срок не совпадает с последней записью — возвращает текущий', () => {
    expect(findSigurCardExpirationMismatch([entry({})], '2026-10-09 20:59:59')).toBe('09.10.2026');
  });

  it('совпадает по дню — null', () => {
    expect(findSigurCardExpirationMismatch([entry({})], '2026-12-11 23:59:59')).toBeNull();
  });

  it('отвязку пропускает, сравнивает с последней записью со сроком', () => {
    const entries = [
      entry({ id: '2', kind: 'remove_card_binding', expirationDate: null }),
      entry({ id: '1' }),
    ];
    expect(findSigurCardExpirationMismatch(entries, '2026-12-11 20:59:59')).toBeNull();
  });

  it('без записей со сроком или без текущего срока — null', () => {
    expect(findSigurCardExpirationMismatch([], '2026-10-09 20:59:59')).toBeNull();
    expect(findSigurCardExpirationMismatch([entry({})], null)).toBeNull();
  });
});

describe('formatSigurCardHistoryMoment', () => {
  it('время по Москве, без запятой', () => {
    expect(formatSigurCardHistoryMoment('2026-08-12T07:32:48.313Z')).toBe('12.08.2026 10:32');
  });
});
