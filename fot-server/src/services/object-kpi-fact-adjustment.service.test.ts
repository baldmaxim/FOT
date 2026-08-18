/**
 * Корректировка факта месяца.
 *
 * Факт по приказу — сумма подписанных КС-2 (п. 3.1), поэтому проверяется главное:
 * правка заводит запись на РАЗНИЦУ и сразу её подписывает, а не переписывает число.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./object-kpi.service.js', () => ({
  createKs2Entry: vi.fn(),
  getContractByObject: vi.fn(),
  setKs2Status: vi.fn(),
}));

import { createKs2Entry, getContractByObject, setKs2Status } from './object-kpi.service.js';
import { adjustMonthFact } from './object-kpi-fact-adjustment.service.js';

const OBJECT_ID = '11111111-1111-1111-1111-111111111111';
const CONTRACT_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR = { userId: 'user-1', userName: 'Экономист' };

const asMock = (fn: unknown) => fn as unknown as {
  mockResolvedValue: (v: unknown) => void;
  mockRejectedValue: (v: unknown) => void;
  mock: { calls: unknown[][] };
};

/** Клиент отдаёт одну строку с разницей — она считается в SQL на numeric. */
const clientWithDelta = (delta: string) => ({
  query: vi.fn(async () => ({ rows: [{ delta }], rowCount: 1 })),
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-14T09:00:00Z'));
  asMock(getContractByObject).mockResolvedValue({ id: CONTRACT_ID, skud_object_id: OBJECT_ID });
  asMock(createKs2Entry).mockResolvedValue({ id: 'ks2-new', version: 1 });
  asMock(setKs2Status).mockResolvedValue({ id: 'ks2-new', version: 2, status: 'signed' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('adjustMonthFact', () => {
  it('недостача закрывается актом на разницу и сразу подписывается', async () => {
    const client = clientWithDelta('15000000.00');

    await adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-07-01',
      targetAmount: '120000000.00',
      reason: 'Акт от 31.07 не был внесён',
    });

    const [, , , input] = asMock(createKs2Entry).mock.calls[0] as [unknown, unknown, unknown, {
      entry_kind: string; amount: number; source: string; notes: string; customer_signed_date: string;
    }];
    expect(input.entry_kind).toBe('act');
    expect(input.amount).toBe(15_000_000);
    expect(input.source).toBe('fact_adjustment');
    expect(input.notes).toBe('Акт от 31.07 не был внесён');
    // Прошлый месяц — дата подписания последний день месяца.
    expect(input.customer_signed_date).toBe('2026-07-31');
    // Черновик факт не двигает: запись подписывается той же транзакцией.
    expect(setKs2Status).toHaveBeenCalledWith(
      client, ACTOR, 'ks2-new', 'signed', 1, 'Акт от 31.07 не был внесён',
    );
  });

  it('превышение снимается записью «уменьшение объёма»', async () => {
    const client = clientWithDelta('-5000000.00');

    await adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-07-01',
      targetAmount: '100000000.00',
      reason: 'Заказчик снял объём',
    });

    const [, , , input] = asMock(createKs2Entry).mock.calls[0] as [unknown, unknown, unknown, {
      entry_kind: string; amount: number;
    }];
    expect(input.entry_kind).toBe('reduction');
    expect(input.amount).toBe(5_000_000);
  });

  it('текущий месяц подписывается сегодняшним днём, а не концом месяца', async () => {
    const client = clientWithDelta('1000.00');

    await adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-08-01',
      targetAmount: '1000.00',
      reason: 'Уточнение',
    });

    const [, , , input] = asMock(createKs2Entry).mock.calls[0] as [unknown, unknown, unknown, {
      customer_signed_date: string;
    }];
    // Акт, подписанный будущей датой, выглядит как ошибка ввода.
    expect(input.customer_signed_date).toBe('2026-08-14');
  });

  it('совпадающая сумма → 400 fact_unchanged, записи не создаются', async () => {
    const client = clientWithDelta('0');

    await expect(adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-07-01',
      targetAmount: '105000000.00',
      reason: 'Ничего не меняем',
    })).rejects.toMatchObject({ __save: { http: 400, code: 'fact_unchanged' } });

    expect(createKs2Entry).not.toHaveBeenCalled();
  });

  it('будущий месяц отклоняется до похода в БД', async () => {
    const client = clientWithDelta('1000.00');

    await expect(adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-09-01',
      targetAmount: '1000.00',
      reason: 'Заранее',
    })).rejects.toMatchObject({ __save: { http: 400, code: 'future_month' } });

    expect(getContractByObject).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('падение подписания пробрасывается — транзакция вызывающего откатит и создание', async () => {
    const client = clientWithDelta('1000.00');
    asMock(setKs2Status).mockRejectedValue(new Error('signature failed'));

    await expect(adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-07-01',
      targetAmount: '1000.00',
      reason: 'Уточнение',
    })).rejects.toThrow('signature failed');
  });

  it('объект без договора → 404', async () => {
    asMock(getContractByObject).mockResolvedValue(null);
    const client = clientWithDelta('1000.00');

    await expect(adjustMonthFact(client as never, ACTOR, {
      objectId: OBJECT_ID,
      periodMonth: '2026-07-01',
      targetAmount: '1000.00',
      reason: 'Уточнение',
    })).rejects.toMatchObject({ __save: { http: 404 } });
  });
});
