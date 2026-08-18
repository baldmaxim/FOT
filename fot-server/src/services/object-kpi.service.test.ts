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

/**
 * Месяцы считаются от сегодняшнего дня, а не зашиты константами: акт с будущим месяцем
 * теперь отвергается, и фиксированная дата протухла бы вместе с календарём.
 */
const monthOf = (delta: number): string => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
  const [year, month] = today.slice(0, 7).split('-').map(Number);
  const total = year * 12 + (month - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

const PAST_MONTH = monthOf(-1);
const PAST_DATE = `${PAST_MONTH}-10`;
/** Последний день прошлого месяца — то, что подставляет сервис при вводе месяцем. */
const PAST_MONTH_LAST_DAY = new Date(Date.UTC(
  Number(PAST_MONTH.slice(0, 4)), Number(PAST_MONTH.slice(5, 7)), 0,
)).toISOString().slice(0, 10);
const FUTURE_MONTH = monthOf(1);

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
      customer_signed_date: PAST_DATE,
    });

    expect(calls[1].params).toContain(-5_000_000);
  });

  it('без номера берётся следующий порядковый по договору', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },            // SELECT ... FOR UPDATE
      { rows: [{ next_number: '8' }] },     // расчёт следующего номера
      { rows: [{ id: 'ks2-1' }] },          // INSERT
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      customer_signed_date: PAST_DATE,
    });

    // Только полностью числовые номера: «КС-2 №1/2026» после вычистки нецифр дал бы
    // 212026, и следующий акт получил бы номер 212027.
    expect(calls[1].sql).toContain("~ '^[0-9]{1,18}$'");
    expect(calls[2].params).toContain('8');
  });

  it('явно переданный номер не подменяется автонумерацией', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ id: 'ks2-1' }] },
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      act_number: 'КС-2 №1/2026',
      customer_signed_date: PAST_DATE,
    });

    // Второго запроса (за номером) нет — сразу INSERT с переданным номером.
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toContain('КС-2 №1/2026');
  });

  it('нумерация считает и аннулированные записи: номер не переиспользуется', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ next_number: '5' }] },
      { rows: [{ id: 'ks2-1' }] },
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      customer_signed_date: PAST_DATE,
    });

    expect(calls[1].sql).not.toContain('status');
    expect(calls[2].params).toContain('5');
  });

  it('ввод месяцем: дата подписания — последний день месяца', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ next_number: '1' }] },
      { rows: [{ id: 'ks2-1' }] },
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      period_month: `${PAST_MONTH}-01`,
    });

    expect(calls[2].params).toContain(PAST_MONTH_LAST_DAY);
  });

  it('текущий месяц подписывается сегодняшним днём, а не концом месяца', async () => {
    const { client, calls } = makeClient([
      { rows: [contractRow()] },
      { rows: [{ next_number: '1' }] },
      { rows: [{ id: 'ks2-1' }] },
    ]);

    await createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      period_month: `${monthOf(0)}-01`,
    });

    // Акт с датой подписания вперёд выглядит как ошибка ввода.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());
    expect(calls[2].params).toContain(today);
  });

  it('будущий месяц отвергается — и месяцем, и датой', async () => {
    const { client } = makeClient([{ rows: [contractRow()] }]);
    await expect(createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act', amount: 1_000, period_month: `${FUTURE_MONTH}-01`,
    })).rejects.toMatchObject({ __save: { http: 400, code: 'future_month' } });

    const second = makeClient([{ rows: [contractRow()] }]);
    await expect(createKs2Entry(second.client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act', amount: 1_000, customer_signed_date: `${FUTURE_MONTH}-10`,
    })).rejects.toMatchObject({ __save: { http: 400, code: 'future_month' } });
  });

  it('месяц вместе с датой — 400, а не молчаливый приоритет одного из них', async () => {
    const { client } = makeClient([{ rows: [contractRow()] }]);

    await expect(createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 1_000,
      period_month: `${PAST_MONTH}-01`,
      customer_signed_date: PAST_DATE,
    })).rejects.toMatchObject({ __save: { http: 400, code: 'ambiguous_period' } });
  });

  it('подписанная запись правится месяцем и суммой', async () => {
    const signed = {
      id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'signed', version: 1,
      entry_kind: 'act', amount: '100.00', period_month: `${PAST_MONTH}-01`,
    };
    const { client, calls } = makeClient([
      { rows: [signed] },
      { rows: [{ ...signed, version: 2 }] },
    ]);

    await updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, {
      period_month: `${PAST_MONTH}-01`, amount: 200,
    }, 'ошибка ввода');

    expect(calls[1].params).toContain(PAST_MONTH_LAST_DAY);
    expect(calls[1].params).toContain(200);
  });

  it('комментарий подписанной записи правится вместе с суммой', async () => {
    const signed = {
      id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'signed', version: 1,
      entry_kind: 'act', amount: '100.00', period_month: `${PAST_MONTH}-01`,
    };
    const { client, calls } = makeClient([
      { rows: [signed] },
      { rows: [{ ...signed, version: 2 }] },
    ]);

    // Комментарий — основной способ пояснить правку суммы после переноса из «Плана месяца».
    await updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, {
      amount: 200, notes: 'заказчик снял объём',
    });

    expect(calls[1].params).toContain('заказчик снял объём');
  });

  it('у подписанной записи номер акта заблокирован', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'signed', version: 1, entry_kind: 'act', amount: '100.00', period_month: `${PAST_MONTH}-01` }] },
    ]);

    await expect(updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, { act_number: 'А-9' }))
      .rejects.toMatchObject({ __save: { http: 400, code: 'signed_field_locked' } });
  });

  it('аннулированная запись не правится вовсе', async () => {
    const { client } = makeClient([
      { rows: [{ id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'cancelled', version: 1, entry_kind: 'act', amount: '100.00' }] },
    ]);

    await expect(updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, { amount: 200 }))
      .rejects.toMatchObject({ __save: { http: 409, code: 'bad_transition' } });
  });

  it('перенос подписанного акта проверяет ОБА месяца: и старый, и новый', async () => {
    const before = {
      id: 'ks2-1', skud_object_id: OBJECT_ID, status: 'signed', version: 1,
      entry_kind: 'act', amount: '100.00', period_month: `${monthOf(-2)}-01`,
    };
    const { client } = makeClient([
      { rows: [before] },
      { rows: [{ ...before, version: 2 }] },
    ]);

    await updateKs2Entry(client as never, ACTOR, 'ks2-1', 1, {
      period_month: `${PAST_MONTH}-01`,
    }, 'перенос акта');

    expect(requireReasonIfMonthFixed).toHaveBeenCalledWith(
      expect.anything(), OBJECT_ID, `${monthOf(-2)}-01`, 'перенос акта',
    );
    expect(requireReasonIfMonthFixed).toHaveBeenCalledWith(
      expect.anything(), OBJECT_ID, `${PAST_MONTH}-01`, 'перенос акта',
    );
  });

  it('нулевая сумма отвергается', async () => {
    const { client } = makeClient([{ rows: [contractRow()] }]);

    await expect(createKs2Entry(client as never, ACTOR, CONTRACT_ID, {
      entry_kind: 'act',
      amount: 0,
      act_number: 'А-1',
      customer_signed_date: PAST_DATE,
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
    customer_signed_date: PAST_DATE,
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
      customer_signed_date: PAST_DATE,
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
        customer_signed_date: PAST_DATE,
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
      customer_signed_date: PAST_DATE,
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
