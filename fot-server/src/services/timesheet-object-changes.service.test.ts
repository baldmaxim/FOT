import { beforeEach, describe, expect, it, vi } from 'vitest';

// «Изменения объекта табелирования» (миграция 289): подпись по автору, сохранённому рядом
// с личным режимом. Кто — по пути записи (set_by) и роли автора, когда — дата по МСК.

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: queryMock }));

import {
  buildObjectChangeLabel,
  loadTimesheetObjectChanges,
  type IObjectChangeRow,
} from './timesheet-object-changes.service.js';

const SEP_29_MSK = '2026-09-29T07:40:00Z'; // 29.09.2026 10:40 МСК

const row = (over: Partial<IObjectChangeRow> = {}): IObjectChangeRow => ({
  employee_id: 444,
  freeze_missing: false,
  mode: 'object',
  set_by: 'manager',
  set_at: SEP_29_MSK,
  author_profile_name: 'Боюкян Микаел Варужанович',
  author_employee_name: 'Боюкян Микаел Варужанович',
  author_is_admin: false,
  ...over,
});

describe('buildObjectChangeLabel', () => {
  it('сам сотрудник в ЛК — без ФИО', () => {
    expect(buildObjectChangeLabel(row({ set_by: 'employee', author_employee_name: 'Шупта Максим Сергеевич' })))
      .toBe('Сам сотрудник, 29.09.2026');
  });

  it('ведущий табель — «Руководитель Фамилия И. О.»', () => {
    expect(buildObjectChangeLabel(row())).toBe('Руководитель Боюкян М. В., 29.09.2026');
  });

  it('админ через табель (set_by = manager) — «Админ», служебная учётка — имя профиля как есть', () => {
    expect(buildObjectChangeLabel(row({
      mode: 'current_activity',
      author_employee_name: null,
      author_profile_name: 'Есенов Максим АДМ',
      author_is_admin: true,
    }))).toBe('Админ Есенов Максим АДМ, 29.09.2026');
  });

  it('прежняя ручная настройка (set_by = NULL) — «Админ», даже если правили кадры', () => {
    expect(buildObjectChangeLabel(row({
      set_by: null,
      author_employee_name: 'Иванова Ирина Петровна',
      author_is_admin: false,
    }))).toBe('Админ Иванова И. П., 29.09.2026');
  });

  it('учётка удалена — только «кто» и дата', () => {
    const deleted = { author_profile_name: null, author_employee_name: null, author_is_admin: null };
    expect(buildObjectChangeLabel(row(deleted))).toBe('Руководитель, 29.09.2026');
    expect(buildObjectChangeLabel(row({ ...deleted, set_by: null }))).toBe('Админ, 29.09.2026');
    expect(buildObjectChangeLabel(row({ ...deleted, set_by: 'employee' }))).toBe('Сам сотрудник, 29.09.2026');
  });

  it('удалённый админ, менявший в табеле, — «Руководитель»: роль берётся текущая (ограничение)', () => {
    expect(buildObjectChangeLabel(row({
      author_profile_name: null, author_employee_name: null, author_is_admin: null,
    }))).toBe('Руководитель, 29.09.2026');
  });

  it('без подписи: скрипт или миграция (нет даты), авто, «По СКУД», объект отдела, нет фиксации месяца', () => {
    expect(buildObjectChangeLabel(row({ set_at: null }))).toBeNull();
    expect(buildObjectChangeLabel(row({ set_by: 'auto' }))).toBeNull();
    expect(buildObjectChangeLabel(row({ mode: 'skud' }))).toBeNull();
    expect(buildObjectChangeLabel(row({ mode: null }))).toBeNull();
    expect(buildObjectChangeLabel(row({ freeze_missing: true }))).toBeNull();
  });

  it('дата — по МСК: 30.09 21:30 UTC — уже 01.10', () => {
    expect(buildObjectChangeLabel(row({ set_by: 'employee', set_at: new Date('2026-09-30T21:30:00Z') })))
      .toBe('Сам сотрудник, 01.10.2026');
  });
});

describe('loadTimesheetObjectChanges', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('один запрос: id без дублей, месяц выгрузки и текущий месяц по «сейчас»; подписи только у ручных', async () => {
    queryMock.mockResolvedValue([
      row({ employee_id: 444 }),
      row({ employee_id: 2160, set_by: 'employee' }),
      row({ employee_id: 77, set_by: 'auto' }),
    ]);

    const result = await loadTimesheetObjectChanges(
      [444, 2160, 77, 444, 0], '2026-09-17', { now: new Date('2026-10-02T09:00:00Z') },
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([[444, 2160, 77], '2026-09-01', '2026-10-01']);
    // Автор — из фиксации месяца, если она есть, иначе живой.
    expect(sql).toContain('employee_timesheet_object_months');
    expect(sql).toContain('f.set_by_user_id');
    expect(result).toEqual(new Map([
      [444, 'Руководитель Боюкян М. В., 29.09.2026'],
      [2160, 'Сам сотрудник, 29.09.2026'],
    ]));
  });

  it('без месяца — живое значение (NULL в параметре); пустой список — без запроса', async () => {
    queryMock.mockResolvedValue([]);
    await loadTimesheetObjectChanges([444], null, { now: new Date('2026-09-29T09:00:00Z') });
    expect((queryMock.mock.calls[0] as [string, unknown[]])[1]).toEqual([[444], null, '2026-09-01']);

    queryMock.mockClear();
    expect(await loadTimesheetObjectChanges([], '2026-09')).toEqual(new Map());
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('с клиентом снимка запрос идёт через него, а не через пул', async () => {
    const exec = { query: vi.fn(async () => ({ rows: [row({ employee_id: 445 })] })) };

    const result = await loadTimesheetObjectChanges(
      [445], '2026-09', { exec: exec as unknown as import('pg').PoolClient },
    );

    expect(exec.query).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
    expect(result.get(445)).toBe('Руководитель Боюкян М. В., 29.09.2026');
  });
});
