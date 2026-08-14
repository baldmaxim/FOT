/**
 * Денежный контур: жизненный цикл записей и защита от параллельной правки.
 *
 * Проверяется то, чего нельзя увидеть в SQL-отчёте: подписанное не правится, версия
 * ловит конкурентное сохранение, уменьшение объёма хранится отрицательным, а стоимость
 * договора не уходит в минус.
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

import { recordObjectKpiHistory, requireReasonIfMonthFixed } from './object-kpi-history.service.js';
import {
  createKs2Entry,
  setAddendumStatus,
  updateContract,
  updateKs2Entry,
} from './object-kpi.service.js';
import {
  createKs6Entry,
  deleteKs6Entry,
  setKs6Status,
  updateKs6Entry,
} from './object-kpi-ks6.service.js';

const OBJECT_ID = '11111111-1111-1111-1111-111111111111';
const CONTRACT_ID = '22222222-2222-2222-2222-222222222222';
const ACTOR = { userId: 'user-1', userName: 'Экономист' };

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

const contractRow = (overrides: Record<string, unknown> = {}) => ({
  id: CONTRACT_ID,
  skud_object_id: OBJECT_ID,
  base_amount: '600000000.00',
  version: 1,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('updateContract', () => {
  it('устаревшая версия → 409, а не тихая перезапись', async () => {
    const { client } = makeClient([
      { rows: [contractRow()] },  // SELECT ... FOR UPDATE
      { rows: [] },               // UPDATE ... WHERE version = $2 не нашёл строку
    ]);

    await expect(updateContract(
      client as never, ACTOR, CONTRACT_ID, 1, { customer_name: 'Заказчик' },
    )).rejects.toMatchObject({ __save: { http: 409, code: 'stale_version' } });
  });

  it('стоимость договора не может уйти в минус вместе с подписанными ДС', async () => {
    const { client } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ total: '-500000000.00' }] },  // сумма подписанных ДС
    ]);

    await expect(updateContract(
      client as never, ACTOR, CONTRACT_ID, 1, { base_amount: 100_000_000 },
    )).rejects.toMatchObject({ __save: { http: 409, code: 'negative_contract_total' } });
  });

  it('договор не найден → 404', async () => {
    const { client } = makeClient([{ rows: [] }]);

    await expect(updateContract(client as never, ACTOR, CONTRACT_ID, 1, { notes: 'x' }))
      .rejects.toMatchObject({ __save: { http: 404 } });
  });
});

describe('setAddendumStatus', () => {
  it('подписание проверяет сумму под блокировкой договора', async () => {
    const { client, calls } = makeClient([
      { rows: [{ id: 'add-1', contract_id: CONTRACT_ID, status: 'draft', effective_date: '2026-09-01', amount_delta: '-700000000.00', version: 1 }] },
      { rows: [contractRow()] },
      { rows: [{ total: '0.00' }] },
    ]);

    await expect(setAddendumStatus(client as never, ACTOR, 'add-1', 'signed', 1))
      .rejects.toMatchObject({ __save: { http: 409, code: 'negative_contract_total' } });

    // Договор блокируется до проверки: без FOR UPDATE два параллельных ДС прошли бы оба.
    expect(calls[1].sql).toContain('FOR UPDATE');
  });

  it('аннулированное допсоглашение подписать нельзя', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'add-1', contract_id: CONTRACT_ID, status: 'cancelled', effective_date: '2026-09-01', amount_delta: '1000.00', version: 1 }] },
      { rows: [contractRow()] },
    ]);

    await expect(setAddendumStatus(client as never, ACTOR, 'add-1', 'signed', 1))
      .rejects.toMatchObject({ __save: { http: 409, code: 'bad_transition' } });
  });

  it('месяц влияния ДС от 1-го числа — сам этот месяц', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'add-1', contract_id: CONTRACT_ID, status: 'draft', effective_date: '2026-09-01', amount_delta: '1000.00', version: 1 }] },
      { rows: [contractRow()] },
      { rows: [{ total: '0.00' }] },
      { rows: [{ id: 'add-1', status: 'signed', version: 2 }] },
    ]);

    await setAddendumStatus(client as never, ACTOR, 'add-1', 'signed', 1);

    // 01.09 → минус день → 31.08 → август → ДС учитывается уже в плане сентября.
    expect(requireReasonIfMonthFixed).toHaveBeenCalledWith(
      expect.anything(), OBJECT_ID, '2026-08-01', undefined,
    );
  });

  it('месяц влияния ДС от 20-го числа — следующий месяц', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'add-1', contract_id: CONTRACT_ID, status: 'draft', effective_date: '2026-09-20', amount_delta: '1000.00', version: 1 }] },
      { rows: [contractRow()] },
      { rows: [{ total: '0.00' }] },
      { rows: [{ id: 'add-1', status: 'signed', version: 2 }] },
    ]);

    await setAddendumStatus(client as never, ACTOR, 'add-1', 'signed', 1);

    expect(requireReasonIfMonthFixed).toHaveBeenCalledWith(
      expect.anything(), OBJECT_ID, '2026-09-01', undefined,
    );
  });
});

describe('КС-2', () => {
  it('уменьшение объёма хранится отрицательным независимо от знака во вводе', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ id: 'ks2-1' }] },
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'reduction',
      amount: 5_000_000,
      act_number: 'У-1',
      customer_signed_date: '2026-09-10',
    });

    expect(calls[1].params).toContain(-5_000_000);
  });

  it('подписанный акт не правится — только аннулирование и новая запись', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'signed', version: 1, entry_kind: 'act', amount: '100.00' }] },
    ]);

    await expect(updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, { notes: 'правка' }))
      .rejects.toMatchObject({ __save: { http: 409, code: 'not_draft' } });
  });

  it('нулевая сумма отвергается', async () => {
    const { client } = makeClient([{ rows: [contractRow()] }]);

    await expect(createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 0,
      act_number: 'А-1',
      customer_signed_date: '2026-09-10',
    })).rejects.toMatchObject({ __save: { http: 400, code: 'bad_amount' } });
  });
});

/**
 * КС-6 — справочный реестр: в план, остаток и факт он не входит. Отсюда единственное
 * отличие от КС-2, которое здесь и фиксируется: основание при закрытом месяце не требуется.
 */
describe('КС-6', () => {
  const ks6Row = (overrides: Record<string, unknown> = {}) => ({
    id: 'ks6-1',
    contract_id: CONTRACT_ID,
    skud_object_id: OBJECT_ID,
    amount: '1000.00',
    doc_number: 'КС6-1',
    customer_signed_date: '2026-09-10',
    period_month: '2026-09-01',
    status: 'draft',
    version: 1,
    ...overrides,
  });

  it('запись создаётся черновиком и блокирует договор', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [ks6Row()] },
    ]);

    await createKs6Entry(client as never, ACTOR, CONTRACT_ID, {
      amount: 1_000,
      doc_number: 'КС6-1',
      customer_signed_date: '2026-09-10',
    });

    expect(calls[0].sql).toContain('FOR UPDATE');
    expect(calls[1].sql).toContain('draft');
    expect(recordObjectKpiHistory).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ entityKind: 'ks6', action: 'create' }),
    );
  });

  it('нулевая и отрицательная сумма отвергаются: знака у КС-6 нет', async () => {
    for (const amount of [0, -1_000]) {
      const { client } = makeClient([{ rows: [contractRow()] }]);
      await expect(createKs6Entry(client as never, ACTOR, CONTRACT_ID, {
        amount,
        doc_number: 'КС6-1',
        customer_signed_date: '2026-09-10',
      })).rejects.toMatchObject({ __save: { http: 400, code: 'bad_amount' } });
    }
  });

  it('подписанная запись не правится', async () => {
    const { client } = makeClient([{ rows: [ks6Row({ status: 'signed' })] }]);

    await expect(updateKs6Entry(client as never, ACTOR, 'ks6-1', 1, { notes: 'правка' }))
      .rejects.toMatchObject({ __save: { http: 409, code: 'not_draft' } });
  });

  it('устаревшая версия при правке → 409', async () => {
    const { client } = makeClient([
      { rows: [ks6Row()] },
      { rows: [] },
    ]);

    await expect(updateKs6Entry(client as never, ACTOR, 'ks6-1', 1, { doc_number: 'КС6-2' }))
      .rejects.toMatchObject({ __save: { http: 409, code: 'stale_version' } });
  });

  it('дубль номера отдаётся понятным текстом, а не «duplicate key»', async () => {
    const calls: Array<{ sql: string }> = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push({ sql });
        if (calls.length === 1) return { rows: [contractRow()], rowCount: 1 };
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      }),
    };

    await expect(createKs6Entry(client as never, ACTOR, CONTRACT_ID, {
      amount: 1_000,
      doc_number: 'КС6-1',
      customer_signed_date: '2026-09-10',
    })).rejects.toMatchObject({ __save: { http: 409, code: 'duplicate' } });
  });

  it('аннулированную запись подписать нельзя', async () => {
    const { client } = makeClient([{ rows: [ks6Row({ status: 'cancelled' })] }]);

    await expect(setKs6Status(client as never, ACTOR, 'ks6-1', 'signed', 1))
      .rejects.toMatchObject({ __save: { http: 409, code: 'bad_transition' } });
  });

  it('смена статуса НЕ требует основания даже в закрытом месяце', async () => {
    const { client } = makeClient([
      { rows: [ks6Row()] },
      { rows: [ks6Row({ status: 'signed', version: 2 })] },
    ]);

    await setKs6Status(client as never, ACTOR, 'ks6-1', 'signed', 1);

    // Ключевая проверка: КС-6 не двигает ни план, ни факт, поэтому симметрия с КС-2
    // здесь была бы требованием основания на ровном месте.
    expect(requireReasonIfMonthFixed).not.toHaveBeenCalled();
  });

  it('удаляется только черновик', async () => {
    const { client } = makeClient([{ rows: [ks6Row({ status: 'signed' })] }]);

    await expect(deleteKs6Entry(client as never, ACTOR, 'ks6-1', 1))
      .rejects.toMatchObject({ __save: { http: 409, code: 'not_draft' } });
  });
});
