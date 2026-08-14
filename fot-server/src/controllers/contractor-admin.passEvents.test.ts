/**
 * GET /passes/:id/events — проходы СКУД текущего держателя пропуска.
 *
 * Главное, что здесь проверяется: нижняя граница выборки строится по approved_at
 * (фактическая выдача), а не по valid_from (дата, которую вводит подрядчик).
 * Иначе нынешнему держателю приписались бы проходы предыдущего — пропуск это
 * переиспользуемый слот.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  queryOne: vi.fn(),
  query: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  resolveCompanyScope: vi.fn(),
  hasPageView: vi.fn(),
  hasPageEdit: vi.fn(),
  getContractorRootId: vi.fn(),
  getInternalAccessPoints: vi.fn(),
  moscowTodayIso: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  queryOne: h.queryOne,
  query: h.query,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/data-scope.service.js', () => ({ resolveCompanyScope: h.resolveCompanyScope }));
vi.mock('../services/access-control.service.js', () => ({
  hasPageView: h.hasPageView,
  hasPageEdit: h.hasPageEdit,
}));
vi.mock('../config/contractor.js', () => ({
  isContractorSigurDryRun: vi.fn(() => false),
  getContractorRootId: h.getContractorRootId,
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
}));
vi.mock('../services/skud-shared.service.js', () => ({
  getInternalAccessPoints: h.getInternalAccessPoints,
}));
// Частичный мок: контроллер использует moscowTodayIso и в других методах.
vi.mock('../utils/date.utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/date.utils.js')>()),
  moscowTodayIso: h.moscowTodayIso,
}));

import { contractorAdminController } from './contractor-admin.controller.js';

const PASS_ID = '11111111-1111-4111-8111-111111111111';
/** «Сегодня» во всех тестах — 2026-08-14 по Москве. */
const TODAY = '2026-08-14';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn(function (this: { statusCode: number }, c: number) { this.statusCode = c; return res; }),
    json: vi.fn(function (this: { body: unknown }, b: unknown) { this.body = b; return res; }),
  };
  return res;
};

const makeReq = (query: Record<string, string> = {}, id: string = PASS_ID) => ({
  user: { id: 'admin-1', is_admin: true, company_scope: { roots: 'all' } },
  params: { id },
  query,
  ip: '127.0.0.1',
  headers: {},
  socket: {},
}) as never;

/**
 * Строка пропуска с текущим держателем (первый queryOne).
 * approved_at — Date: timestamptz приходит из pg объектом (парсер 1184 не
 * переопределён в config/postgres.ts), valid_from — строка (для date парсер есть).
 */
const passRow = (over: Record<string, unknown> = {}) => ({
  pass_number: '2634',
  sigur_employee_id: 500,
  holder_name: 'Смышляев Владимир Валерьевич',
  valid_from: '2026-08-01',
  approved_at: new Date('2026-08-05T09:00:00.000Z'),
  ...over,
});

/** Границы окна (второй queryOne) — обычно их считает Postgres. */
const boundsRow = (over: Record<string, unknown> = {}) => ({
  start_at: new Date('2026-08-05T09:00:00.000Z'),
  end_at: new Date('2026-08-14T21:00:00.000Z'),
  clipped: true,
  ...over,
});

const skudEvent = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  physical_person: 'Смышляев Владимир Валерьевич',
  card_number: null,
  event_date: '2026-08-12',
  event_time: '08:12:00',
  access_point: 'Инджой-2',
  direction: 'entry',
  ...over,
});

type Body = {
  success: boolean;
  error?: string;
  data?: {
    pass_number: string;
    holder_name: string | null;
    date_from: string;
    date_to: string;
    effective_start_at: string | null;
    clipped: boolean;
    truncated: boolean;
    reason?: string;
    events: unknown[];
    internal_points: string[];
  };
};

/** Полный успешный прогон: пропуск → границы → сотрудники → события. */
const mockHappyPath = (events: unknown[] = [], bounds = boundsRow()) => {
  h.queryOne.mockResolvedValueOnce(passRow()).mockResolvedValueOnce(bounds);
  h.query.mockResolvedValueOnce([{ id: 900 }]).mockResolvedValueOnce(events);
};

describe('contractorAdminController.passEvents', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.resolveCompanyScope.mockResolvedValue({ roots: 'all' });
    h.getInternalAccessPoints.mockResolvedValue(new Set(['кпп ASTERUS']));
    h.moscowTodayIso.mockReturnValue(TODAY);
  });

  describe('граница держателя', () => {
    it('нижняя граница считается по approved_at, а не по valid_from', async () => {
      mockHappyPath([skudEvent(1)]);
      const res = makeRes();
      await contractorAdminController.passEvents(
        makeReq({ date_from: '2026-08-01', date_to: TODAY }), res as never,
      );

      // Границы считает Postgres: GREATEST(период, valid_from, approved_at).
      const boundsCall = h.queryOne.mock.calls[1];
      expect(String(boundsCall[0])).toContain('GREATEST');
      expect(boundsCall[1]).toEqual([
        '2026-08-01',                              // начало периода
        '2026-08-01',                              // valid_from
        new Date('2026-08-05T09:00:00.000Z'),      // approved_at — он и победит
        TODAY,                                     // конец периода
      ]);

      // В выборку событий уходит именно посчитанный start_at, а не дата периода.
      const eventsParams = h.query.mock.calls[1][1] as unknown[];
      expect(eventsParams[1]).toEqual(new Date('2026-08-05T09:00:00.000Z'));
      const body = res.body as Body;
      expect(body.data?.clipped).toBe(true);
      expect(body.data?.effective_start_at).toBe('2026-08-05T09:00:00.000Z');
      expect(body.data?.events).toHaveLength(1);
    });

    it('держатель без approved_at → holder_not_approved, событий не запрашиваем', async () => {
      h.queryOne.mockResolvedValueOnce(passRow({ approved_at: null }));
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.reason).toBe('holder_not_approved');
      expect(body.data?.events).toEqual([]);
      expect(h.query).not.toHaveBeenCalled();
    });

    it('весь период раньше выдачи → пусто и clipped, событий не запрашиваем', async () => {
      h.queryOne
        .mockResolvedValueOnce(passRow())
        .mockResolvedValueOnce(boundsRow({
          start_at: new Date('2026-08-05T09:00:00.000Z'),
          end_at: new Date('2026-08-01T21:00:00.000Z'),
        }));
      const res = makeRes();
      await contractorAdminController.passEvents(
        makeReq({ date_from: '2026-07-01', date_to: '2026-08-01' }), res as never,
      );

      const body = res.body as Body;
      expect(body.data?.clipped).toBe(true);
      expect(body.data?.events).toEqual([]);
      expect(h.query).not.toHaveBeenCalled();
    });
  });

  describe('период', () => {
    it('без параметров — 14 календарных дней до «сегодня» по Москве', async () => {
      mockHappyPath();
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.date_from).toBe('2026-08-01');
      expect(body.data?.date_to).toBe(TODAY);
    });

    it('только date_to — начало достраивается на 13 дней назад', async () => {
      mockHappyPath();
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq({ date_to: '2026-06-30' }), res as never);

      const body = res.body as Body;
      expect(body.data?.date_from).toBe('2026-06-17');
      expect(body.data?.date_to).toBe('2026-06-30');
    });

    it('только date_from — конец не уезжает в будущее дальше «сегодня»', async () => {
      mockHappyPath();
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq({ date_from: '2026-08-10' }), res as never);

      const body = res.body as Body;
      expect(body.data?.date_from).toBe('2026-08-10');
      expect(body.data?.date_to).toBe(TODAY);
    });

    it('ровно 92 дня — валидно', async () => {
      mockHappyPath();
      const res = makeRes();
      await contractorAdminController.passEvents(
        makeReq({ date_from: '2026-05-15', date_to: TODAY }), res as never,
      );
      expect(res.statusCode).toBe(200);
    });

    it('93 дня — 400', async () => {
      const res = makeRes();
      await contractorAdminController.passEvents(
        makeReq({ date_from: '2026-05-14', date_to: TODAY }), res as never,
      );
      expect(res.statusCode).toBe(400);
      expect((res.body as Body).error).toContain('92');
      expect(h.queryOne).not.toHaveBeenCalled();
    });

    it('начало позже конца — 400', async () => {
      const res = makeRes();
      await contractorAdminController.passEvents(
        makeReq({ date_from: '2026-08-10', date_to: '2026-08-01' }), res as never,
      );
      expect(res.statusCode).toBe(400);
    });

    it('несуществующая дата — 400', async () => {
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq({ date_from: '2026-02-30' }), res as never);
      expect(res.statusCode).toBe(400);
    });
  });

  describe('состояния пропуска', () => {
    it('битый passId — 400, а не 500', async () => {
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq({}, 'not-a-uuid'), res as never);
      expect(res.statusCode).toBe(400);
      expect(h.queryOne).not.toHaveBeenCalled();
    });

    it('пропуска нет — 404', async () => {
      h.queryOne.mockResolvedValueOnce(null);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);
      expect(res.statusCode).toBe(404);
    });

    it('пропуск без держателя → no_holder', async () => {
      h.queryOne.mockResolvedValueOnce(passRow({ holder_name: null, approved_at: null }));
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      expect((res.body as Body).data?.reason).toBe('no_holder');
    });

    it('профиль Sigur не сматчен в employees → no_employee', async () => {
      h.queryOne.mockResolvedValueOnce(passRow()).mockResolvedValueOnce(boundsRow());
      h.query.mockResolvedValueOnce([]); // employees пуст
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.reason).toBe('no_employee');
      expect(h.query).toHaveBeenCalledTimes(1); // до skud_events не дошли
    });

    it('сотрудник есть, событий нет → пустой список БЕЗ reason', async () => {
      mockHappyPath([]);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.reason).toBeUndefined();
      expect(body.data?.events).toEqual([]);
    });
  });

  describe('выборка событий', () => {
    it('в SQL есть фильтр направления и границы по event_at', async () => {
      mockHappyPath([skudEvent(1)]);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const sql = String(h.query.mock.calls[1][0]);
      expect(sql).toContain("se.direction IN ('entry', 'exit')");
      expect(sql).toContain('se.event_at >=');
      expect(sql).toContain('se.event_at <');
      // event_date остаётся ради отсечения партиций
      expect(sql).toContain('se.event_date BETWEEN');
      expect(res.statusCode).toBe(200);
    });

    it('внутренние точки отдаются клиенту', async () => {
      mockHappyPath([skudEvent(1)]);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      expect((res.body as Body).data?.internal_points).toEqual(['кпп ASTERUS']);
    });

    it('достижение лимита → ровно 2000 событий и truncated', async () => {
      const rows = Array.from({ length: 2001 }, (_, i) => skudEvent(i + 1));
      mockHappyPath(rows);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.truncated).toBe(true);
      expect(body.data?.events).toHaveLength(2000);
    });

    it('событий меньше лимита → truncated false', async () => {
      mockHappyPath([skudEvent(1), skudEvent(2, { direction: 'exit', event_time: '17:40:00' })]);
      const res = makeRes();
      await contractorAdminController.passEvents(makeReq(), res as never);

      const body = res.body as Body;
      expect(body.data?.truncated).toBe(false);
      expect(body.data?.events).toHaveLength(2);
    });
  });

  it('нет доступа к разделу → 403', async () => {
    h.resolveCompanyScope.mockResolvedValue({ roots: ['other-root'] });
    h.getContractorRootId.mockResolvedValue('contractor-root');
    const res = makeRes();
    await contractorAdminController.passEvents(makeReq(), res as never);

    expect(res.statusCode).toBe(403);
    expect(h.queryOne).not.toHaveBeenCalled();
  });
});
