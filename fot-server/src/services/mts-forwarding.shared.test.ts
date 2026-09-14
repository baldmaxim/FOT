import { describe, it, expect } from 'vitest';
import { conflictingRuleTypes, matchesForwardingIntent, matchesForwardingMode, matchesForwardingOff, pickActiveForwardingType, validateForwardingTarget } from './mts-forwarding.shared.js';

// Сверка «что просили» с «что реально в МТС» — единственный способ узнать исход,
// когда ChangeCallForwarding отвечает 2xx без eventID (Sentry FOT-SERVER-4K).
describe('matchesForwardingIntent', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    forwardingType: 'CFU', forwardingAddress: '79161234567', ...over,
  });

  it('create: тип сравнивается без учёта регистра, адрес — после нормализации', () => {
    expect(matchesForwardingIntent([rule({ forwardingType: 'cfu' })], 'create', 'CFU', '+7 (916) 123-45-67')).toBe(true);
    expect(matchesForwardingIntent([rule({ forwardingAddress: '89161234567' })], 'create', 'CFU', '79161234567')).toBe(true);
  });

  it('create: другой адрес или другой тип — не совпало', () => {
    expect(matchesForwardingIntent([rule({ forwardingAddress: '79160000000' })], 'create', 'CFU', '79161234567')).toBe(false);
    expect(matchesForwardingIntent([rule({ forwardingType: 'CFNRY' })], 'create', 'CFU', '79161234567')).toBe(false);
    expect(matchesForwardingIntent([], 'create', 'CFU', '79161234567')).toBe(false);
    expect(matchesForwardingIntent(null, 'create', 'CFU', '79161234567')).toBe(false);
  });

  it('create без адреса назначения — не совпало (сравнивать не с чем)', () => {
    expect(matchesForwardingIntent([rule()], 'create', 'CFU')).toBe(false);
  });

  it('delete: пустая заглушка того же типа снятию не мешает', () => {
    expect(matchesForwardingIntent([rule({ forwardingAddress: null })], 'delete', 'CFU')).toBe(true);
    expect(matchesForwardingIntent([rule({ forwardingAddress: '' })], 'delete', 'CFU')).toBe(true);
    expect(matchesForwardingIntent([], 'delete', 'CFU')).toBe(true);
  });

  it('delete: живое правило этого типа — снятие не подтверждено', () => {
    expect(matchesForwardingIntent([rule()], 'delete', 'CFU')).toBe(false);
  });

  it('delete: правило ДРУГОГО типа не мешает подтвердить снятие', () => {
    expect(matchesForwardingIntent([rule({ forwardingType: 'CFNRC' })], 'delete', 'CFU')).toBe(true);
  });
});

describe('pickActiveForwardingType / validateForwardingTarget', () => {
  it('активным считается правило с непустым адресом', () => {
    expect(pickActiveForwardingType([
      { forwardingType: 'CFU', forwardingAddress: null },
      { forwardingType: 'CFNRY', forwardingAddress: '79161234567' },
    ])).toBe('CFNRY');
  });

  it('8-800 и номер сам на себя запрещены', () => {
    expect(validateForwardingTarget('88005553535', '79150000001').ok).toBe(false);
    expect(validateForwardingTarget('89150000001', '79150000001').ok).toBe(false);
  });
});

describe('matchesForwardingMode / matchesForwardingOff / conflictingRuleTypes', () => {
  const r = (forwardingType: string, forwardingAddress: string | null, noReplyTimer: number | null = 0) =>
    ({ forwardingType, forwardingAddress, noReplyTimer });

  it('лишнее активное CFU мешает режиму «не отвечаю»', () => {
    const rules = [r('CFU', '79161234567'), r('CFNRY', '79161234567', 20)];
    expect(matchesForwardingMode(rules, 'CFNRY', '79161234567', 20)).toBe(false);
    expect(conflictingRuleTypes(rules, 'CFNRY')).toEqual(['CFU']);
  });

  it('CFB и пустые заглушки не мешают и не снимаются', () => {
    const rules = [r('CFB', '79160000000'), r('CFU', null), r('CFNRC', '79161234567')];
    expect(matchesForwardingMode(rules, 'CFNRC', '79161234567')).toBe(true);
    expect(conflictingRuleTypes(rules, 'CFNRC')).toEqual([]);
    expect(matchesForwardingOff([r('CFB', '79160000000'), r('CFU', null)])).toBe(true);
  });

  it('таймер CFNRY должен совпасть; выключено — нет активных поддерживаемых правил', () => {
    expect(matchesForwardingMode([r('CFNRY', '79161234567', 30)], 'CFNRY', '79161234567', 20)).toBe(false);
    expect(matchesForwardingOff([r('CFNRY', '79161234567', 20)])).toBe(false);
    expect(conflictingRuleTypes([r('cfnry', '79161234567'), r('CFNRC', '79161234567')], null)).toEqual(['CFNRY', 'CFNRC']);
  });
});
