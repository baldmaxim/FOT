import { describe, it, expect } from 'vitest';
import { matchesForwardingIntent, pickActiveForwardingType, validateForwardingTarget } from './mts-forwarding.shared.js';

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
