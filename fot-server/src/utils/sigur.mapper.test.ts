import { describe, expect, it } from 'vitest';

import { mapSigurEvent } from './sigur.mapper.js';

const buildPassRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1001,
  eventType: 'PASS_DETECTED',
  eventTypeId: 6,
  timestamp: '2026-05-08T10:23:23+03:00',
  data: { direction: 'IN', cardKey: 'AABBCCDD', employeeId: 42 },
  additionalData: {
    accessObject: { type: 'EMPLOYEE', data: { id: 42, name: 'Иванов Иван Иванович' } },
    accessPoint: { name: 'Главный вход' },
  },
  ...overrides,
});

const buildFailureRaw = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 2002,
  eventType: 'PASS_DENY',
  eventTypeId: 12,
  timestamp: '2026-05-08T10:25:11+03:00',
  description: 'Неизвестная карта',
  data: { direction: 'IN', cardKey: 'DEADBEEF' },
  additionalData: {},
  ...overrides,
});

describe('mapSigurEvent', () => {
  it('распознаёт PASS_DETECTED как pass-событие со всеми полями', () => {
    const result = mapSigurEvent(buildPassRaw());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('pass');
    if (result?.kind === 'pass') {
      expect(result.physicalPerson).toBe('Иванов Иван Иванович');
      expect(result.cardNumber).toBe('AABBCCDD');
      expect(result.eventDate).toBe('2026-05-08');
      expect(result.eventTime).toBe('10:23:23');
      expect(result.direction).toBe('entry');
      expect(result.accessPoint).toBe('Главный вход');
      expect(result.employeeId).toBe(42);
    }
  });

  it('возвращает null для PASS_DETECTED без имени и без карты', () => {
    const raw = buildPassRaw({
      data: { direction: 'IN' },
      additionalData: {},
    });
    expect(mapSigurEvent(raw)).toBeNull();
  });

  it('возвращает null без timestamp', () => {
    const raw = buildPassRaw({ timestamp: undefined });
    expect(mapSigurEvent(raw)).toBeNull();
  });

  it('распознаёт PASS_DENY как failure-событие с типом и причиной', () => {
    const result = mapSigurEvent(buildFailureRaw());
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('failure');
    if (result?.kind === 'failure') {
      expect(result.failureType).toBe('PASS_DENY');
      expect(result.failureTypeId).toBe(12);
      expect(result.cardNumber).toBe('DEADBEEF');
      expect(result.physicalPerson).toBeNull();
      expect(result.eventDate).toBe('2026-05-08');
      expect(result.eventTime).toBe('10:25:11');
      expect(result.direction).toBe('entry');
      expect(result.reason).toBe('Неизвестная карта');
      expect(result.rawId).toBe(2002);
    }
  });

  it('сохраняет PASS_DENY даже без имени и без карты — это лог', () => {
    const result = mapSigurEvent(buildFailureRaw({
      data: { direction: 'OUT' },
      description: 'Таймаут',
      additionalData: {},
    }));
    expect(result?.kind).toBe('failure');
    if (result?.kind === 'failure') {
      expect(result.physicalPerson).toBeNull();
      expect(result.cardNumber).toBeNull();
      expect(result.direction).toBe('exit');
      expect(result.reason).toBe('Таймаут');
    }
  });

  it('извлекает reason из data.reason / data.failureReason при отсутствии description', () => {
    const result = mapSigurEvent(buildFailureRaw({
      description: undefined,
      data: { direction: 'IN', cardKey: 'X', reason: 'Срок действия истёк' },
    }));
    expect(result?.kind).toBe('failure');
    if (result?.kind === 'failure') {
      expect(result.reason).toBe('Срок действия истёк');
    }
  });

  it('для неизвестного eventType сохраняет тип строкой', () => {
    const result = mapSigurEvent(buildFailureRaw({
      eventType: 'READER_ERROR',
      eventTypeId: 99,
      description: null,
    }));
    expect(result?.kind).toBe('failure');
    if (result?.kind === 'failure') {
      expect(result.failureType).toBe('READER_ERROR');
      expect(result.failureTypeId).toBe(99);
    }
  });

  it('конвертирует timestamp с любым TZ-offset в МСК', () => {
    const result = mapSigurEvent(buildPassRaw({ timestamp: '2026-05-08T07:00:00+00:00' }));
    expect(result?.kind).toBe('pass');
    if (result?.kind === 'pass') {
      expect(result.eventDate).toBe('2026-05-08');
      expect(result.eventTime).toBe('10:00:00');
    }
  });
});
