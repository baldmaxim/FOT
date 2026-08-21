/**
 * Проверки ручного остатка по договору.
 *
 * Сам пересчёт живёт в OBJECT_KPI_REPORT_SQL и здесь не дублируется — проверяется
 * только гард: три условия, при которых сохранённый остаток дал бы неверные цифры.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./object-kpi-history.service.js', () => ({
  recordObjectKpiHistory: vi.fn(),
  requireReasonIfMonthFixed: vi.fn(),
  requireReasonIfObjectHasFixedMonths: vi.fn(),
}));

import { extractObjectKpiError } from './object-kpi-errors.js';
import { assertOpeningRemainderValid } from './object-kpi.service.js';

const OBJECT_ID = '11111111-1111-1111-1111-111111111111';
const CONTRACT_ID = '22222222-2222-2222-2222-222222222222';

/** Мини-клиент: отдаёт заготовленные ответы по порядку вызовов. */
function makeClient(responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let index = 0;
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const response = responses[index] ?? { rows: [] };
      index += 1;
      return { rows: response.rows, rowCount: response.rowCount ?? response.rows.length };
    }),
  };
  return { client, calls };
}

/** Ответы по порядку: сумма подписанных ДС на отсечку, затем поиск закрытых месяцев. */
const responses = (addenda: string, fixedMonths = 0) => [
  { rows: [{ total: addenda }] },
  { rows: fixedMonths > 0 ? [{ '?column?': 1 }] : [], rowCount: fixedMonths },
];

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return extractObjectKpiError(error)?.code;
  }
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assertOpeningRemainderValid', () => {
  it('без первого расчётного месяца остаток не сохраняется', async () => {
    const { client } = makeClient(responses('0'));

    const code = await codeOf(assertOpeningRemainderValid(client as never, OBJECT_ID, CONTRACT_ID, {
      baseAmount: 100,
      planStartMonth: null,
      openingRemainder: 50,
    }));

    expect(code).toBe('opening_remainder_month_required');
    // До БД дело не доходит: месяц проверяется первым.
    expect(client.query).not.toHaveBeenCalled();
  });

  it('остаток выше стоимости договора с ДС отклоняется', async () => {
    const { client } = makeClient(responses('0'));

    const code = await codeOf(assertOpeningRemainderValid(client as never, OBJECT_ID, CONTRACT_ID, {
      baseAmount: 100,
      planStartMonth: '2026-08-01',
      openingRemainder: 120,
    }));

    expect(code).toBe('opening_remainder_above_contract');
  });

  it('подписанное ДС поднимает потолок остатка', async () => {
    const { client, calls } = makeClient(responses('50'));

    await expect(assertOpeningRemainderValid(client as never, OBJECT_ID, CONTRACT_ID, {
      baseAmount: 100,
      planStartMonth: '2026-08-01',
      openingRemainder: 150,
    })).resolves.toBeUndefined();

    // Отсечка ДС — ровно первый расчётный месяц: допник, заехавший позже, потолок
    // этого месяца не поднимает.
    expect(calls[0].sql).toContain('effective_date <= $2::date');
    expect(calls[0].params).toEqual([CONTRACT_ID, '2026-08-01']);
  });

  it('закрытый месяц раньше точки отсчёта запрещает остаток', async () => {
    const { client, calls } = makeClient(responses('0', 1));

    const code = await codeOf(assertOpeningRemainderValid(client as never, OBJECT_ID, CONTRACT_ID, {
      baseAmount: 100,
      planStartMonth: '2026-08-01',
      openingRemainder: 100,
    }));

    // Решётка отчёта режет всё до plan_start_month: такой месяц вместе с посчитанной
    // по нему премией просто исчез бы из отчёта.
    expect(code).toBe('opening_remainder_over_fixed_months');
    expect(calls[1].sql).toContain('period_month < $2::date');
  });

  it('нулевой остаток допустим — это «всё закрыто», а не «не задано»', async () => {
    const { client } = makeClient(responses('0'));

    await expect(assertOpeningRemainderValid(client as never, OBJECT_ID, CONTRACT_ID, {
      baseAmount: 100,
      planStartMonth: '2026-08-01',
      openingRemainder: 0,
    })).resolves.toBeUndefined();
  });

  it('у нового договора ДС не запрашиваются', async () => {
    const { client, calls } = makeClient([{ rows: [] }]);

    await expect(assertOpeningRemainderValid(client as never, OBJECT_ID, null, {
      baseAmount: 100,
      planStartMonth: '2026-08-01',
      openingRemainder: 100,
    })).resolves.toBeUndefined();

    // Единственный запрос — поиск закрытых месяцев.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('object_kpi_month_plans');
  });
});
