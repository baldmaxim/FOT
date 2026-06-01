import { describe, expect, it } from 'vitest';

import { computeDedupHash, computeFailureDedupHash } from './dedup.utils.js';

describe('computeDedupHash', () => {
  it('одинаковые входные параметры дают одинаковый hash', () => {
    const a = computeDedupHash('Иванов И.И.', '2026-05-08', '10:23:00', 'Вход', 'entry');
    const b = computeDedupHash('Иванов И.И.', '2026-05-08', '10:23:30', 'Вход', 'entry');
    // HH:MM precision — 10:23:00 и 10:23:30 → одинаковый ключ
    expect(a).toBe(b);
  });

  it('разные direction/access point дают разные hash', () => {
    const a = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'Вход', 'entry');
    const b = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'Вход', 'exit');
    const c = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'Выход', 'entry');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('Sigur rawId: разные id в одну минуту → разные hash (within-minute проходы не теряются)', () => {
    // Кейс Вакулиной: 14:22:20 exit и 14:22:22 exit на одной точке — раньше HH:MM
    // схлопывал в один хэш, второй проход терялся. С rawId — два разных события.
    const a = computeDedupHash('Иванов', '2026-05-08', '14:22:20', 'Офис', 'exit', 100);
    const b = computeDedupHash('Иванов', '2026-05-08', '14:22:22', 'Офис', 'exit', 101);
    expect(a).not.toBe(b);
  });

  it('Sigur rawId: один id из разных путей/страниц → одинаковый hash (повтор события ловится)', () => {
    // Одно физическое событие, пришедшее из presence-polling и sigur-sync (или из
    // двух страниц пагинации) с тем же raw.id — должно дедуплицироваться.
    const a = computeDedupHash('Иванов', '2026-05-08', '14:22:20', 'Офис', 'exit', 100);
    const b = computeDedupHash('Иванов', '2026-05-08', '14:22:21', 'Офис', 'exit', 100);
    expect(a).toBe(b);
  });

  it('Sigur rawId: одинаковый id, но разная точка/направление → разные hash', () => {
    // Страховка от переиспользования raw.id Sigur'ом между точками/направлениями.
    const a = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'КПП-1', 'entry', 100);
    const b = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'КПП-2', 'entry', 100);
    const c = computeDedupHash('Иванов', '2026-05-08', '10:00:00', 'КПП-1', 'exit', 100);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('computeFailureDedupHash', () => {
  it('включает failureType — два разных типа в одну минуту дают разные hash', () => {
    const a = computeFailureDedupHash('Иванов', 'CARD1', '2026-05-08', '10:00:00', 'Вход', 'entry', 'PASS_DENY', 1);
    const b = computeFailureDedupHash('Иванов', 'CARD1', '2026-05-08', '10:00:00', 'Вход', 'entry', 'READER_ERROR', 1);
    expect(a).not.toBe(b);
  });

  it('включает rawId — две одинаковые ошибки с разными raw id хранятся раздельно', () => {
    const a = computeFailureDedupHash(null, null, '2026-05-08', '10:00:00', 'Вход', null, 'PASS_DENY', 100);
    const b = computeFailureDedupHash(null, null, '2026-05-08', '10:00:00', 'Вход', null, 'PASS_DENY', 101);
    expect(a).not.toBe(b);
  });

  it('включает card_number — без имени, два отказа с разными картами разные', () => {
    const a = computeFailureDedupHash(null, 'CARD_A', '2026-05-08', '10:00:00', 'Вход', null, 'PASS_DENY', null);
    const b = computeFailureDedupHash(null, 'CARD_B', '2026-05-08', '10:00:00', 'Вход', null, 'PASS_DENY', null);
    expect(a).not.toBe(b);
  });

  it('детерминирован: одинаковые входы → одинаковый hash', () => {
    const a = computeFailureDedupHash('Иванов И.И.', 'CARD', '2026-05-08', '10:23:30', 'Вход', 'entry', 'PASS_DENY', 7);
    const b = computeFailureDedupHash('иванов и.и.', 'card', '2026-05-08', '10:23:00', 'вход', 'entry', 'pass_deny', 7);
    // case-insensitive + минутная точность по времени
    expect(a).toBe(b);
  });
});
