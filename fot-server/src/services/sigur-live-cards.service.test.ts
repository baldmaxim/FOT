import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./sigur.service.js', () => ({
  sigurService: {},
}));

vi.mock('./sigur-linked-employees.service.js', () => ({
  getEmployeeAccessPointBindings: vi.fn(),
  invalidateEmployeeAccessPointBindingsCache: vi.fn(),
  replaceEmployeeAccessPointBindings: vi.fn(),
}));

vi.mock('./sigur-access-point-meta.service.js', () => ({
  loadAccessPointObjectMetaMap: vi.fn(async () => new Map()),
}));

import {
  applyCardExpirationChange,
  assignSigurEmployeeCardBinding,
  updateSigurEmployeeCardBinding,
} from './sigur-live-cards.service.js';
import { sigurService } from './sigur.service.js';

const sig = sigurService as unknown as Record<string, ReturnType<typeof vi.fn>>;

// Сырая карта Sigur: toCardSummary вытащит cardId из `id` и format.
const CARD_RAW = { id: 38046, value: '26CFFD', format: 'W26' };
const UID = '1826CFFD00000000'; // deriveCardW26 → value 26CFFD

const http = (status: number): { response: { status: number } } => ({ response: { status } });

beforeEach(() => {
  sig.findCardByCandidates = vi.fn(async () => ({ matches: [CARD_RAW], tried: [], sample: [] }));
  sig.createCard = vi.fn(async () => CARD_RAW);
  sig.getCardBindings = vi.fn(async () => [] as Record<string, unknown>[]);
  sig.getEmployeeById = vi.fn(async () => ({ id: 0, name: '' }));
  sig.patchEmployeeCardBinding = vi.fn(async () => undefined);
  sig.deleteEmployeeCardBinding = vi.fn(async () => undefined);
  sig.createEmployeeCardBinding = vi.fn(async () => undefined);
  sig.invalidateCardListCache = vi.fn(() => undefined);
});

describe('assignSigurEmployeeCardBinding', () => {
  it('карта найдена по W26 (unbound) → createCard НЕ вызывается, создаётся привязка', async () => {
    sig.getCardBindings = vi.fn(async () => []);

    await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true);

    expect(sig.createCard).not.toHaveBeenCalled();
    expect(sig.createEmployeeCardBinding).toHaveBeenCalledWith(500, 38046, expect.any(String), expect.any(String), 'external', 'W26');
    expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    // искали и по сырому UID, и по выведенному W26-значению
    const searched = sig.findCardByCandidates.mock.calls[0][0] as string[];
    expect(searched).toEqual(expect.arrayContaining([UID, '26CFFD', '38,53245']));
  });

  it('карта у того же сотрудника → patch (продление), без delete/create', async () => {
    sig.getCardBindings = vi.fn(async () => [{ employeeId: 500 }]);

    await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true);

    expect(sig.patchEmployeeCardBinding).toHaveBeenCalledWith(500, 38046, expect.any(String), expect.any(String), 'external', 'W26');
    expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    expect(sig.createEmployeeCardBinding).not.toHaveBeenCalled();
  });

  it('safe-only + владелец orphan (getEmployeeById 404) → перепривязка', async () => {
    sig.getCardBindings = vi.fn(async () => [{ employeeId: 999 }]);
    sig.getEmployeeById = vi.fn(async () => { throw http(404); });

    const res = await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true, {
      expectedHolderName: 'Иванов Иван Иванович',
      reassignPolicy: 'safe-only',
    });

    expect(sig.deleteEmployeeCardBinding).toHaveBeenCalledWith(999, 38046, 'W26', 'external');
    expect(sig.createEmployeeCardBinding).toHaveBeenCalled();
    expect(res.reassigned).toBe(true);
    expect(res.previousSigurEmployeeId).toBe(999);
  });

  it('safe-only + другой активный владелец с другим ФИО → конфликт, БЕЗ delete', async () => {
    sig.getCardBindings = vi.fn(async () => [{ employeeId: 146109 }]);
    sig.getEmployeeById = vi.fn(async () => ({ id: 146109, name: 'Каравашкин Роман Владимирович', departmentId: 142705 }));

    await expect(
      assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true, {
        expectedHolderName: 'Каравашкин Роман Александрович',
        reassignPolicy: 'safe-only',
      }),
    ).rejects.toThrow(/ручная проверка/);

    expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    expect(sig.createEmployeeCardBinding).not.toHaveBeenCalled();
  });

  it('safe-only + точное совпадение ФИО → перепривязка', async () => {
    sig.getCardBindings = vi.fn(async () => [{ employeeId: 146110 }]);
    sig.getEmployeeById = vi.fn(async () => ({ id: 146110, name: 'Бухаров Дмитрий Андреевич', departmentId: 142705 }));

    const res = await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true, {
      expectedHolderName: 'Бухаров  Дмитрий Андреевич ', // лишние пробелы — нормализуются
      reassignPolicy: 'safe-only',
    });

    expect(sig.deleteEmployeeCardBinding).toHaveBeenCalledWith(146110, 38046, 'W26', 'external');
    expect(sig.createEmployeeCardBinding).toHaveBeenCalled();
    expect(res.reassigned).toBe(true);
  });

  it('always (ручная админ-привязка) + другой владелец → перепривязка без проверки ФИО', async () => {
    sig.getCardBindings = vi.fn(async () => [{ employeeId: 146109 }]);

    await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', false);

    expect(sig.getEmployeeById).not.toHaveBeenCalled();
    expect(sig.deleteEmployeeCardBinding).toHaveBeenCalledWith(146109, 38046, 'W26', 'external');
    expect(sig.createEmployeeCardBinding).toHaveBeenCalled();
  });

  it('ложное частичное совпадение (чужая карта с другим value) → игнор, создаётся новая карта', async () => {
    // UID нового пластика → value 267876; матчер по «голому» номеру ошибочно вернул чужую карту 71A2C0.
    const UID_NEW = '1826787600000000'; // deriveCardW26 → value 267876 (W26 38,30838)
    const FOREIGN_CARD = { id: 15318, value: '71A2C0', format: 'W26', holder: { holderId: 137365, type: 'EMP' } };
    const NEW_CARD = { id: 99001, value: '267876', format: 'W26' };
    sig.findCardByCandidates = vi.fn(async () => ({ matches: [FOREIGN_CARD], tried: [], sample: [] }));
    sig.createCard = vi.fn(async () => NEW_CARD);
    sig.getCardBindings = vi.fn(async () => []); // новая карта свободна

    const res = await assignSigurEmployeeCardBinding(500, [UID_NEW], undefined, 'external', true, {
      expectedHolderName: 'Рахмонкулов Огабек Отабек Угли',
      reassignPolicy: 'safe-only',
    });

    expect(sig.createCard).toHaveBeenCalledWith('267876', 'W26', 'external');
    expect(sig.createEmployeeCardBinding).toHaveBeenCalledWith(500, 99001, expect.any(String), expect.any(String), 'external', 'W26');
    expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    expect(res.card.cardId).toBe(99001);
  });

  it('createCard вернул 422 (гонка/дубль) → refetch по W26 и привязка', async () => {
    sig.findCardByCandidates = vi.fn()
      .mockResolvedValueOnce({ matches: [], tried: [], sample: [] }) // первичный поиск — пусто
      .mockResolvedValueOnce({ matches: [CARD_RAW], tried: [], sample: [] }); // refetch после 422
    sig.createCard = vi.fn(async () => { throw http(422); });
    sig.getCardBindings = vi.fn(async () => []);

    await assignSigurEmployeeCardBinding(500, [UID], undefined, 'external', true, { reassignPolicy: 'safe-only' });

    expect(sig.createCard).toHaveBeenCalledTimes(1);
    expect(sig.findCardByCandidates).toHaveBeenCalledTimes(2);
    expect(sig.createEmployeeCardBinding).toHaveBeenCalledWith(500, 38046, expect.any(String), expect.any(String), 'external', 'W26');
  });

  describe('дубли номера в каталоге Sigur (пропуск 2050, 18.11.2026)', () => {
    // Две карты 9E4AF3 / 158,19187: 38624 свободна, 38625 уже у профиля 146261.
    const PROFILE = 146261;
    const W26 = '158,19187';
    const FREE_DUP = { id: 38624, value: '9E4AF3', formattedValue: W26, format: 'W26' };
    const OWN_DUP = { id: 38625, value: '9E4AF3', formattedValue: W26, format: 'W26', holder: { holderId: PROFILE, type: 'EMP' } };
    const OWN_BINDING = { employeeId: PROFILE, cardId: 38625, startDate: '2026-06-29 11:30:20', expirationDate: '2031-06-29 11:30:20', format: 'W26' };

    const bindingsByFilter = (own: Record<string, unknown>[]) =>
      vi.fn(async (filters?: Record<string, unknown>) => {
        if (filters?.employeeId === PROFILE) return own;
        if (filters?.cardId === 38625) return [OWN_BINDING];
        return [];
      });

    it('берётся карта, уже привязанная к профилю → PATCH срока, без create/delete', async () => {
      sig.findCardByCandidates = vi.fn(async () => ({ matches: [FREE_DUP, OWN_DUP], tried: [], sample: [] }));
      sig.getCardBindings = bindingsByFilter([OWN_BINDING]);

      const res = await assignSigurEmployeeCardBinding(PROFILE, [W26], undefined, 'external', true, {
        expectedHolderName: 'Угаров Сергей Николаевич',
        reassignPolicy: 'safe-only',
      });

      expect(sig.getCardBindings).toHaveBeenCalledWith({ employeeId: PROFILE }, 'external');
      expect(sig.getCardBindings).toHaveBeenCalledWith({ cardId: 38625 }, 'external');
      expect(sig.getCardBindings).not.toHaveBeenCalledWith({ cardId: 38624 }, 'external');
      expect(sig.patchEmployeeCardBinding).toHaveBeenCalledWith(PROFILE, 38625, expect.any(String), expect.any(String), 'external', 'W26');
      expect(sig.createEmployeeCardBinding).not.toHaveBeenCalled();
      expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
      expect(sig.createCard).not.toHaveBeenCalled();
      expect(res.reassigned).toBe(false);
    });

    it('своей карты среди дублей нет → первая, как раньше', async () => {
      sig.findCardByCandidates = vi.fn(async () => ({ matches: [FREE_DUP, OWN_DUP], tried: [], sample: [] }));
      sig.getCardBindings = bindingsByFilter([]);
      const OTHER_PROFILE = 146300;

      await assignSigurEmployeeCardBinding(OTHER_PROFILE, [W26], undefined, 'external', true);

      expect(sig.getCardBindings).toHaveBeenCalledWith({ employeeId: OTHER_PROFILE }, 'external');
      expect(sig.createEmployeeCardBinding).toHaveBeenCalledWith(OTHER_PROFILE, 38624, expect.any(String), expect.any(String), 'external', 'W26');
      expect(sig.patchEmployeeCardBinding).not.toHaveBeenCalled();
      expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    });

    it('refetch после 422 у createCard нашёл дубли → своя карта, PATCH', async () => {
      sig.findCardByCandidates = vi.fn()
        .mockResolvedValueOnce({ matches: [], tried: [], sample: [] })
        .mockResolvedValueOnce({ matches: [FREE_DUP, OWN_DUP], tried: [], sample: [] });
      sig.createCard = vi.fn(async () => { throw http(422); });
      sig.getCardBindings = bindingsByFilter([OWN_BINDING]);

      await assignSigurEmployeeCardBinding(PROFILE, [W26], undefined, 'external', true, { reassignPolicy: 'safe-only' });

      expect(sig.createCard).toHaveBeenCalledTimes(1);
      expect(sig.patchEmployeeCardBinding).toHaveBeenCalledWith(PROFILE, 38625, expect.any(String), expect.any(String), 'external', 'W26');
      expect(sig.createEmployeeCardBinding).not.toHaveBeenCalled();
      expect(sig.deleteEmployeeCardBinding).not.toHaveBeenCalled();
    });
  });
});

/**
 * Ядро записи срока: им пользуются и кнопка «Сохранить» в сайдбаре, и массовое
 * продление. Расхождение здесь означало бы, что массовая операция делает не то же
 * самое, что поштучная.
 */
describe('applyCardExpirationChange', () => {
  const START = '2026-01-01T00:00:00.000Z';
  const TARGET = '2026-12-31T20:59:59.000Z';

  beforeEach(() => {
    sig.getCardBindings = vi.fn(async () => [
      { id: 100, cardId: 100, employeeId: 1, startDate: START, expirationDate: TARGET, format: 'W26' },
    ]);
  });

  it('шлёт PATCH с неизменным startDate и новым сроком', async () => {
    await applyCardExpirationChange({
      sigurEmployeeId: 1, cardId: 100, startDate: START, expirationDate: TARGET, format: 'W26',
    });

    expect(sig.patchEmployeeCardBinding).toHaveBeenCalledWith(1, 100, START, TARGET, undefined, 'W26');
  });

  it('по умолчанию не читает состояние «до» — на сотнях карт это лишний трафик и лог', async () => {
    await applyCardExpirationChange({
      sigurEmployeeId: 1, cardId: 100, startDate: START, expirationDate: TARGET,
    });

    // Единственное чтение — контрольное, уже после PATCH.
    expect(sig.getCardBindings).toHaveBeenCalledTimes(1);
  });

  it('ошибку записи пробрасывает: классификация исхода — забота вызывающего', async () => {
    sig.patchEmployeeCardBinding = vi.fn(async () => { throw new Error('sigur 500'); });

    await expect(applyCardExpirationChange({
      sigurEmployeeId: 1, cardId: 100, startDate: START, expirationDate: TARGET,
    })).rejects.toThrow('sigur 500');
  });

  it('некорректные даты отсекаются до обращения к Sigur', async () => {
    await expect(applyCardExpirationChange({
      sigurEmployeeId: 1, cardId: 100, startDate: 'что-то', expirationDate: TARGET,
    })).rejects.toThrow('Некорректная дата начала доступа');

    await expect(applyCardExpirationChange({
      sigurEmployeeId: 1, cardId: 100, startDate: START, expirationDate: 'что-то',
    })).rejects.toThrow('Некорректная дата срока действия');

    expect(sig.patchEmployeeCardBinding).not.toHaveBeenCalled();
  });

  it('одиночное «Сохранить» выполняет тот же PATCH и возвращает прежние даты для журнала', async () => {
    const PREVIOUS = '2026-10-09T20:59:59.000Z';
    sig.getCardBindings = vi.fn()
      .mockResolvedValueOnce([{ id: 100, cardId: 100, employeeId: 1, startDate: START, expirationDate: PREVIOUS, format: 'W26' }])
      .mockResolvedValueOnce([{ id: 100, cardId: 100, employeeId: 1, startDate: START, expirationDate: TARGET, format: 'W26' }]);

    const { card, before } = await updateSigurEmployeeCardBinding(1, 100, START, TARGET, undefined, 'W26');

    expect(sig.patchEmployeeCardBinding).toHaveBeenCalledWith(1, 100, START, TARGET, undefined, 'W26');
    expect(sig.getCardBindings).toHaveBeenCalledTimes(2);
    expect(card).toMatchObject({ cardId: 100, expirationDate: TARGET });
    expect(before).toEqual({ startDate: START, expirationDate: PREVIOUS });
  });

  it('сбой чтения прежних дат не мешает сохранению: before = null', async () => {
    sig.getCardBindings = vi.fn()
      .mockRejectedValueOnce(new Error('sigur timeout'))
      .mockResolvedValueOnce([{ id: 100, cardId: 100, employeeId: 1, startDate: START, expirationDate: TARGET, format: 'W26' }]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { card, before } = await updateSigurEmployeeCardBinding(1, 100, START, TARGET);

    expect(sig.patchEmployeeCardBinding).toHaveBeenCalledTimes(1);
    expect(card).toMatchObject({ cardId: 100, expirationDate: TARGET });
    expect(before).toBeNull();
  });
});
