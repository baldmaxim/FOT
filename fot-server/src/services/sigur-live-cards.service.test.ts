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

import { assignSigurEmployeeCardBinding } from './sigur-live-cards.service.js';
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
});
