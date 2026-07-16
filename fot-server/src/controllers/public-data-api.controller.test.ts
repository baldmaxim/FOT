import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const {
  pgQuery,
  getKeyTables,
  fetchTimesheetDataForEmployees,
  listScopedMembersByDepartment,
  resolveTimesheetPeriodRange,
} = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  getKeyTables: vi.fn(),
  fetchTimesheetDataForEmployees: vi.fn(),
  listScopedMembersByDepartment: vi.fn(),
  resolveTimesheetPeriodRange: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
}));

vi.mock('../services/data-api-key.service.js', () => ({
  dataApiKeyService: {
    getKeyTables,
  },
}));

vi.mock('../services/timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees,
}));

vi.mock('../services/timesheet-department-assignments.service.js', () => ({
  listScopedMembersByDepartment,
  resolveTimesheetDateRange: vi.fn(),
  resolveTimesheetPeriodRange,
}));

vi.mock('../services/schedule.service.js', () => ({
  getDayNormHours: vi.fn(() => 9),
  getFullDayThresholdHoursForDate: vi.fn(() => 8),
  getScheduleForDate: vi.fn(() => ({
    work_start: '09:00:00',
    work_end: '19:00:00',
    work_hours: 9,
    lunch_minutes: 60,
  })),
  isWorkingDay: vi.fn(() => true),
}));

import { publicDataApiController } from './public-data-api.controller.js';

function makeReq(query: Record<string, string> = {}): Request {
  return {
    query,
    dataApiKey: { id: 'key-1', name: 'OdintsovLive', rate_limit_per_minute: 60 },
  } as unknown as Request;
}

function makeRes() {
  const response = {
    statusCode: 200,
    payload: null as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.payload = body;
      return this;
    },
  };

  return response as unknown as Response & {
    statusCode: number;
    payload: unknown;
    headers: Record<string, string>;
  };
}

describe('publicDataApiController.getEmployeeEvents', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    getKeyTables.mockReset();
    getKeyTables.mockResolvedValue([
      { table_name: 'skud_events', allowed_fields: ['id', 'employee_id', 'event_date'] },
    ]);
  });

  it('возвращает безопасные события и пагинацию без ФИО и номера карты', async () => {
    pgQuery
      .mockResolvedValueOnce([{ id: 42 }])
      .mockResolvedValueOnce([
        {
          id: 101,
          employee_id: 42,
          event_at: '2026-07-14T08:15:00+03:00',
          event_date: '2026-07-14',
          event_time: '08:15:00',
          access_point: 'Главный вход',
          direction: 'entry',
        },
        {
          id: 100,
          employee_id: 42,
          event_at: '2026-07-13T18:05:00+03:00',
          event_date: '2026-07-13',
          event_time: '18:05:00',
          access_point: 'Главный вход',
          direction: 'exit',
        },
      ]);

    const req = makeReq({
      employee_id: '42',
      from: '2026-07-01',
      to: '2026-07-31',
      limit: '1',
      offset: '0',
    });
    const res = makeRes();

    await publicDataApiController.getEmployeeEvents(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(res.payload).toEqual({
      success: true,
      period: { from: '2026-07-01', to: '2026-07-31' },
      data: [{
        id: 101,
        employee_id: 42,
        event_at: '2026-07-14T08:15:00+03:00',
        event_date: '2026-07-14',
        event_time: '08:15:00',
        access_point: 'Главный вход',
        direction: 'entry',
      }],
      pagination: { limit: 1, offset: 0, has_more: true, next_offset: 1 },
    });
    expect(String(pgQuery.mock.calls[1][0])).not.toContain('physical_person');
    expect(String(pgQuery.mock.calls[1][0])).not.toContain('card_number');
    expect(pgQuery.mock.calls[1][1]).toEqual([42, '2026-07-01', '2026-07-31', 2, 0]);
  });

  it('не даёт доступ без capability skud_events', async () => {
    getKeyTables.mockResolvedValueOnce([{ table_name: 'employees', allowed_fields: ['id'] }]);
    const res = makeRes();

    await publicDataApiController.getEmployeeEvents(makeReq({
      employee_id: '42',
      from: '2026-07-01',
      to: '2026-07-31',
    }), res);

    expect(res.statusCode).toBe(403);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('проверяет employee_id, период и максимальную длину диапазона', async () => {
    const invalidIdRes = makeRes();
    await publicDataApiController.getEmployeeEvents(makeReq({
      employee_id: 'abc',
      from: '2026-07-01',
      to: '2026-07-31',
    }), invalidIdRes);
    expect(invalidIdRes.statusCode).toBe(400);

    const invalidRangeRes = makeRes();
    await publicDataApiController.getEmployeeEvents(makeReq({
      employee_id: '42',
      from: '2025-01-01',
      to: '2026-07-31',
    }), invalidRangeRes);
    expect(invalidRangeRes.statusCode).toBe(400);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('возвращает 404 для неизвестного сотрудника', async () => {
    pgQuery.mockResolvedValueOnce([]);
    const res = makeRes();

    await publicDataApiController.getEmployeeEvents(makeReq({
      employee_id: '404',
      from: '2026-07-01',
      to: '2026-07-31',
    }), res);

    expect(res.statusCode).toBe(404);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});

describe('publicDataApiController.getDepartmentTimesheet', () => {
  beforeEach(() => {
    pgQuery.mockReset();
    getKeyTables.mockReset();
    fetchTimesheetDataForEmployees.mockReset();
    listScopedMembersByDepartment.mockReset();
    resolveTimesheetPeriodRange.mockReset();
    getKeyTables.mockResolvedValue([{ table_name: 'employees', allowed_fields: ['id'] }]);
    resolveTimesheetPeriodRange.mockReturnValue({
      year: 2026,
      month: 7,
      daysInMonth: 31,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
  });

  it('возвращает рассчитанный план дня и метаданные корректировки', async () => {
    const schedule = {
      schedule_id: 'schedule-1',
      name: 'Основной',
      schedule_type: 'office',
      source: 'employee',
    };
    pgQuery
      .mockResolvedValueOnce([{ id: '11111111-1111-1111-1111-111111111111', name: 'Отдел' }])
      .mockResolvedValueOnce([{ id: 42, tab_number: 'T-42' }]);
    listScopedMembersByDepartment.mockResolvedValue(new Map([
      [42, '11111111-1111-1111-1111-111111111111'],
    ]));
    fetchTimesheetDataForEmployees.mockResolvedValue({
      employees: [{ id: 42, full_name: 'Иванов Иван', position_id: null, sigur_employee_id: 7 }],
      dataMap: new Map([[42, new Map([['2026-07-01', {
        status: 'work', hours: 9, corrected: true, hoursOverridden: true,
      }]])]]),
      dailySchedulesMap: new Map([[42, new Map([['2026-07-01', schedule]])]]),
      calendarMonth: null,
      entries: [{
        employee_id: 42,
        work_date: '2026-07-01',
        reason: 'Исправлены часы',
        corrected_by_name: 'Руководитель',
        corrected_at: '2026-07-01T18:00:00.000Z',
        approval_status: 'approved',
        source_type: 'manual',
      }],
      posMap: new Map(),
    });

    const res = makeRes();
    await publicDataApiController.getDepartmentTimesheet(makeReq({
      department_id: '11111111-1111-1111-1111-111111111111',
      month: '2026-07',
      half: 'FULL',
    }), res);

    expect(res.statusCode).toBe(200);
    const payload = res.payload as { departments: Array<{ employees: Array<Record<string, unknown>> }> };
    expect(payload.departments[0].employees[0]).toMatchObject({
      days: {
        '2026-07-01': {
          corrected: true,
          correction: {
            reason: 'Исправлены часы',
            corrected_by_name: 'Руководитель',
            approval_status: 'approved',
          },
        },
      },
      plans: {
        '2026-07-01': {
          schedule_id: 'schedule-1',
          schedule_name: 'Основной',
          schedule_type: 'office',
          schedule_source: 'employee',
          is_working_day: true,
          planned_hours: 9,
          full_day_threshold_hours: 8,
          work_start: '09:00:00',
          work_end: '19:00:00',
          lunch_minutes: 60,
        },
      },
    });
  });
});
