import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Гейты чёрного списка (миграция 273): проверяется, что человек из списка
 * действительно останавливается на каждом действии, адресованном человеку, и
 * что при пустом списке поведение прежнее.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  findActive: vi.fn(),
  findActiveBySigurEmployeeId: vi.fn(),
  updateSigurEmployee: vi.fn(),
  unblockEmployee: vi.fn(),
  logFromRequest: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));

const strongEntry = {
  id: 'b1',
  full_name: 'Иванов Иван Иванович',
  birth_date: '1990-01-01',
  snils: null,
  email: null,
  passport_series_number: '4508123456',
  employee_id: 42,
  user_profile_id: null,
  reason: 'нарушение пропускного режима',
  created_by_name: 'Гладкая Наталья Васильевна',
  created_at: '2026-09-10T00:00:00.000Z',
  match_reason: 'passport' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('withSigurProfileGuard: сериализация блокировки и разблокировки', () => {
  it('берёт advisory-лок по профилю и проверяет список ВНУТРИ лока', async () => {
    const { withSigurProfileGuard } = await import('./blacklist.service.js');
    const client = { query: vi.fn() };
    // 1) advisory lock, 2) поиск записи по профилю → пусто
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const action = vi.fn().mockResolvedValue('ok');
    const result = await withSigurProfileGuard(777, action);

    expect(result).toBe('ok');
    expect(String(client.query.mock.calls[0][0])).toContain('pg_advisory_xact_lock');
    // Проверка идёт до действия — иначе разблокировка успела бы уйти в Sigur.
    expect(client.query.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('человек в списке → действие не выполняется вовсе', async () => {
    const { withSigurProfileGuard, BlacklistBlockedError } = await import('./blacklist.service.js');
    const client = { query: vi.fn() };
    client.query.mockResolvedValueOnce({ rows: [] });               // lock
    client.query.mockResolvedValueOnce({ rows: [strongEntry] });    // запись найдена
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    const action = vi.fn();
    await expect(withSigurProfileGuard(777, action)).rejects.toBeInstanceOf(BlacklistBlockedError);
    expect(action).not.toHaveBeenCalled();
  });

  it('текст запрета скрывает причину, если её нельзя показывать', async () => {
    const { withSigurProfileGuard } = await import('./blacklist.service.js');
    const client = { query: vi.fn() };
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [strongEntry] });
    h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

    await expect(withSigurProfileGuard(777, vi.fn(), { canSeeReason: false }))
      .rejects.toThrow(/Обратитесь к администратору/);
  });
});

describe('blockMessage: причина только для тех, у кого есть доступ к реестру', () => {
  it('с доступом — видно автора и причину', async () => {
    const { blockMessage } = await import('./blacklist.service.js');
    const text = blockMessage([strongEntry], true);
    expect(text).toContain('нарушение пропускного режима');
    expect(text).toContain('Гладкая Наталья Васильевна');
  });

  it('без доступа — нейтральный текст без ПДн и причины', async () => {
    const { blockMessage } = await import('./blacklist.service.js');
    const text = blockMessage([strongEntry], false);
    expect(text).not.toContain('нарушение');
    expect(text).not.toContain('Иванов');
  });
});

describe('resolveSigurTargets: цели блокировки', () => {
  it('один профиль Sigur не дублируется, даже если он и сотрудник, и держатель пропуска', async () => {
    const { resolveSigurTargets } = await import('./blacklist.service.js');
    // На проде таких пересечений 6515 — держатели пропусков продублированы
    // как сотрудники, поэтому дедупликация обязательна.
    h.query.mockResolvedValueOnce([
      { employee_id: 42, sigur_employee_id: 777, full_name: 'Иванов', match_reason: 'employee_id' },
    ]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', sigur_employee_id: 777, holder_name: 'Иванов', pass_number: '442', org_name: 'ООО', match_reason: 'passport' },
    ]);

    const res = await resolveSigurTargets({ employeeId: 42, passport: '4508123456' });

    expect(res.strong).toHaveLength(1);
    expect(res.strong[0].sigur_employee_id).toBe(777);
  });

  it('пропуск, найденный по ФИО без даты рождения, попадает в weak — подтверждает человек', async () => {
    const { resolveSigurTargets } = await import('./blacklist.service.js');
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', sigur_employee_id: 900, holder_name: 'Иванов Иван', pass_number: '100', org_name: 'ООО', match_reason: 'name_birth' },
    ]);

    const res = await resolveSigurTargets({ fullName: 'Иванов Иван' });

    expect(res.strong).toHaveLength(0);
    expect(res.weak).toHaveLength(1);
  });

  it('совпадение по паспорту — strong, блокируется без подтверждения', async () => {
    const { resolveSigurTargets } = await import('./blacklist.service.js');
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([
      { pass_id: 'p1', sigur_employee_id: 901, holder_name: 'Иванов Иван', pass_number: '101', org_name: 'ООО', match_reason: 'passport' },
    ]);

    const res = await resolveSigurTargets({ passport: '45 08 123456' });

    expect(res.strong).toHaveLength(1);
    expect(res.weak).toHaveLength(0);
  });
});

describe('пустой список: поведение портала не меняется', () => {
  it('findActive без совпадений не блокирует ничего', async () => {
    const { assertNotBlacklisted } = await import('./blacklist.service.js');
    h.query.mockResolvedValueOnce([]);
    const res = await assertNotBlacklisted({
      employeeId: 42, snils: '12345678900', email: 'a@b.c', passport: '4508123456',
      fullName: 'Иванов', birthDate: '1990-01-01',
    });
    expect(res.strong).toHaveLength(0);
    expect(res.weak).toHaveLength(0);
  });
});
