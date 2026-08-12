import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery, pgQueryOne } = vi.hoisted(() => ({
  pgQuery: vi.fn(),
  pgQueryOne: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: pgQueryOne,
}));

const { responsiblesByEmpMock } = vi.hoisted(() => ({
  responsiblesByEmpMock: vi.fn(async () => new Map<number, number[]>()),
}));
vi.mock('./approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsByEmployee: responsiblesByEmpMock,
}));

import { resolveRoutedLeaveApprovers } from './recipients.service.js';

describe('resolveRoutedLeaveApprovers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pgQuery.mockResolvedValue([]);
  });

  it('назначенный руководитель приоритетнее начальника отдела (решает routing-сервис)', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7]]]));
    pgQuery.mockResolvedValue([{ id: 'manager-user-uuid' }]);

    const result = await resolveRoutedLeaveApprovers(247, 'dep-1');

    expect(responsiblesByEmpMock).toHaveBeenCalledWith([{ employee_id: 247, org_department_id: 'dep-1' }]);
    expect(pgQuery.mock.calls[0][1]).toEqual([[7]]);
    expect(result).toEqual(['manager-user-uuid']);
  });

  it('несколько начальников отдела — все получают уведомление', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7, 8]]]));
    pgQuery.mockResolvedValue([{ id: 'head-1-uuid' }, { id: 'head-2-uuid' }]);

    const result = await resolveRoutedLeaveApprovers(247, 'dep-1');

    expect(result).toEqual(['head-1-uuid', 'head-2-uuid']);
  });

  it('нет ответственных → пустой список, БД не опрашиваем', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, []]]));

    const result = await resolveRoutedLeaveApprovers(247, null);

    expect(result).toEqual([]);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('ответственный без учётной записи портала отбрасывается', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map([[247, [7, 8]]]));
    // У сотрудника 8 нет строки в user_profiles.
    pgQuery.mockResolvedValue([{ id: 'head-1-uuid' }]);

    const result = await resolveRoutedLeaveApprovers(247, 'dep-1');

    expect(result).toEqual(['head-1-uuid']);
  });

  it('supervisor_id не используется как запасной адресат', async () => {
    responsiblesByEmpMock.mockResolvedValue(new Map());

    const result = await resolveRoutedLeaveApprovers(247, 'dep-1');

    expect(result).toEqual([]);
    expect(pgQueryOne).not.toHaveBeenCalled();
  });
});
