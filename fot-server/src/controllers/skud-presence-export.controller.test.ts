import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Контроллер выгрузки: сборка visibility из трёх источников скоупа,
 * порядок «фильтры → NO_DATA → лимит» и явные 400 вместо общего 500.
 */

const scope = vi.hoisted(() => ({
  objects: { is_unrestricted: true, object_ids: [] as string[] },
  employeeIds: 'all' as Set<number> | 'all',
  viewScope: false,
}));

vi.mock('../services/employee-skud-object-access.service.js', () => ({
  resolveAccessibleObjectIdsForRequest: vi.fn(async () => scope.objects),
}));

vi.mock('../services/data-scope.service.js', () => ({
  resolveAccessibleEmployeeIds: vi.fn(async () => scope.employeeIds),
  hasObjectViewScope: vi.fn(async () => scope.viewScope),
}));

const collectMock = vi.hoisted(() => vi.fn());

vi.mock('../services/skud-presence-export.service.js', async () => {
  const actual = await vi.importActual<typeof import('../services/skud-presence-export.service.js')>(
    '../services/skud-presence-export.service.js',
  );
  return { ...actual, collectPresenceExport: collectMock };
});

const { skudPresenceExportController } = await import('./skud-presence-export.controller.js');
const { PresenceExportError, MAX_EXPORT_ROWS } = await import('../services/skud-presence-export.service.js');
const { resolveAccessibleObjectIdsForRequest } = await import('../services/employee-skud-object-access.service.js');
const { hasObjectViewScope } = await import('../services/data-scope.service.js');

type MockResponse = Response & {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  sent: unknown;
};

function makeRes(): MockResponse {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    sent: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    setHeader(name: string, value: string) { res.headers[name] = value; return res; },
    send(payload: unknown) { res.sent = payload; return res; },
  };
  return res as unknown as MockResponse;
}

const req = (query: Record<string, unknown> = {}, body: Record<string, unknown> = {}) =>
  ({ query, body, user: { id: 'u1' } } as unknown as AuthenticatedRequest);

const day = (total: number) => ({
  date: '2026-08-04',
  objects: [{
    object_key: 'obj-1',
    object_name: 'ЖК Alia',
    total,
    groups: [{
      key: 'local:dept-a',
      name: 'бр.Тоштемиров',
      company_name: 'СУ-10',
      employees: Array.from({ length: total }, (_, i) => ({
        entry_time: '07:00:00',
        full_name: `Сотрудник ${i}`,
      })),
    }],
  }],
});

beforeEach(() => {
  scope.objects = { is_unrestricted: true, object_ids: [] };
  scope.employeeIds = 'all';
  scope.viewScope = false;
  collectMock.mockReset();
  collectMock.mockResolvedValue([day(1)]);
  vi.mocked(resolveAccessibleObjectIdsForRequest).mockClear();
  vi.mocked(hasObjectViewScope).mockClear();
});

describe('getPresenceExportFilters', () => {
  it('отдаёт списки, выведенные из датасета', async () => {
    const res = makeRes();
    await skudPresenceExportController.getPresenceExportFilters(
      req({ date_from: '2026-08-04', date_to: '2026-08-04' }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: {
        objects: [{ key: 'obj-1', name: 'ЖК Alia' }],
        groups: [{ key: 'local:dept-a', name: 'бр.Тоштемиров', company_name: 'СУ-10' }],
      },
    });
  });

  it('пустой датасет — это 200 с пустыми списками, а не 400', async () => {
    collectMock.mockResolvedValue([]);
    const res = makeRes();
    await skudPresenceExportController.getPresenceExportFilters(
      req({ date_from: '2026-08-04', date_to: '2026-08-04' }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: { objects: [], groups: [] } });
  });

  it('ошибка периода — 400 с кодом, а не 500', async () => {
    collectMock.mockRejectedValue(new PresenceExportError('PERIOD_TOO_LONG', 'x'));
    const res = makeRes();
    await skudPresenceExportController.getPresenceExportFilters(
      req({ date_from: '2026-01-01', date_to: '2026-12-31' }), res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'PERIOD_TOO_LONG' });
  });
});

describe('exportPresenceByObject — visibility', () => {
  it('unrestricted: hasObjectViewScope не запрашивается', async () => {
    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-04', date_to: '2026-08-04' }), res,
    );

    expect(hasObjectViewScope).not.toHaveBeenCalled();
    expect(collectMock).toHaveBeenCalledWith(expect.objectContaining({
      visibility: {
        isUnrestricted: true,
        assignedObjectIds: new Set(),
        allowedEmployeeIds: 'all',
        hasObjectViewScope: false,
      },
    }));
  });

  it('object_employee: назначенные объекты и свои сотрудники передаются как есть (union, не пересечение)', async () => {
    scope.objects = { is_unrestricted: false, object_ids: ['obj-1'] };
    scope.employeeIds = new Set([7]);
    scope.viewScope = false;

    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-04', date_to: '2026-08-04' }), res,
    );

    expect(collectMock).toHaveBeenCalledWith(expect.objectContaining({
      visibility: {
        isUnrestricted: false,
        assignedObjectIds: new Set(['obj-1']),
        allowedEmployeeIds: new Set([7]),
        hasObjectViewScope: false,
      },
    }));
  });

  it('view-скоуп прокидывается в visibility', async () => {
    scope.objects = { is_unrestricted: false, object_ids: ['obj-1'] };
    scope.employeeIds = new Set([7]);
    scope.viewScope = true;

    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-04', date_to: '2026-08-04' }), res,
    );

    expect(collectMock).toHaveBeenCalledWith(expect.objectContaining({
      visibility: expect.objectContaining({ hasObjectViewScope: true }),
    }));
  });
});

describe('exportPresenceByObject — ответы', () => {
  it('отдаёт xlsx с корректными заголовками', async () => {
    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-03', date_to: '2026-08-04' }), res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('spreadsheetml.sheet');
    expect(res.headers['Content-Disposition']).toContain('attachment');
    expect(Buffer.isBuffer(res.sent)).toBe(true);
  });

  it('чужой object_keys не расширяет выдачу — NO_DATA', async () => {
    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, {
        date_from: '2026-08-04',
        date_to: '2026-08-04',
        object_keys: ['obj-чужой'],
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'NO_DATA' });
  });

  it('лимит строк проверяется после фильтров', async () => {
    collectMock.mockResolvedValue([{
      date: '2026-08-04',
      objects: [
        { object_key: 'obj-big', object_name: 'Большой', total: MAX_EXPORT_ROWS + 1, groups: [] },
        day(1).objects[0],
      ],
    }]);

    const wide = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-04', date_to: '2026-08-04' }), wide,
    );
    expect(wide.statusCode).toBe(400);
    expect(wide.body).toMatchObject({ code: 'EXPORT_TOO_LARGE' });

    const narrow = makeRes();
    await skudPresenceExportController.exportPresenceByObject(
      req({}, { date_from: '2026-08-04', date_to: '2026-08-04', object_keys: ['obj-1'] }), narrow,
    );
    expect(narrow.statusCode).toBe(200);
    expect(Buffer.isBuffer(narrow.sent)).toBe(true);
  });

  it('некорректное тело — 400', async () => {
    const res = makeRes();
    await skudPresenceExportController.exportPresenceByObject(req({}, { date_from: 5 }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAMS' });
  });
});
