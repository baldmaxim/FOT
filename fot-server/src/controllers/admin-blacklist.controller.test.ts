import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Контроллер чёрного списка (миграция 273):
 *  - данные записи формирует сервер по ref_id, клиент их не присылает;
 *  - повторное добавление не плодит записи и не пишет второй аудит;
 *  - без идентификатора запись не создаётся;
 *  - снятие требует причину и идемпотентно.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  addEntryIn: vi.fn(),
  removeEntryIn: vi.fn(),
  insertTargetsIn: vi.fn(),
  resolveSigurTargets: vi.fn(),
  resolveAffectedProfiles: vi.fn(),
  applyAccountLock: vi.fn(),
  logFromRequestWithClient: vi.fn(),
  loadUserFullName: vi.fn(),
  disconnectUserSockets: vi.fn(),
  kickBlacklistSigur: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequestWithClient: h.logFromRequestWithClient, logFromRequest: vi.fn() },
}));
vi.mock('../services/audit-context.helpers.js', () => ({ loadUserFullName: h.loadUserFullName }));
vi.mock('../socket/io-instance.js', () => ({ disconnectUserSockets: h.disconnectUserSockets }));
vi.mock('../services/blacklist-sigur.scheduler.js', () => ({ kickBlacklistSigur: h.kickBlacklistSigur }));
vi.mock('../utils/search.utils.js', () => ({ escapeLike: (v: string) => v }));
vi.mock('../services/blacklist.service.js', () => ({
  addEntryIn: h.addEntryIn,
  removeEntryIn: h.removeEntryIn,
  insertTargetsIn: h.insertTargetsIn,
  resolveSigurTargets: h.resolveSigurTargets,
  resolveAffectedProfiles: h.resolveAffectedProfiles,
  applyAccountLock: h.applyAccountLock,
  normalizeEmailForMatch: (v: string | null) => (v ? v.trim().toLowerCase() : null),
  normalizeSnilsForMatch: (v: string | null) => {
    const digits = (v ?? '').replace(/\D/g, '');
    return digits.length === 11 ? digits : null;
  },
}));

const { adminBlacklistController } = await import('./admin-blacklist.controller.js');

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res;
};

const req = (body: unknown, params: Record<string, string> = {}) => ({
  body,
  params,
  query: {},
  user: { id: '22222222-2222-2222-2222-222222222222' },
  ip: '127.0.0.1',
  socket: { remoteAddress: '127.0.0.1' },
  headers: {},
} as never);

const entry = {
  id: 'b1',
  full_name: 'Иванов Иван Иванович',
  reason: 'нарушение',
  employee_id: 42,
  email: null,
  snils: null,
  user_profile_id: null,
  birth_date: null,
  passport_series_number: null,
  created_by_name: 'Админ',
  created_at: '2026-09-10T00:00:00.000Z',
};

beforeEach(() => {
  vi.resetAllMocks();
  h.loadUserFullName.mockResolvedValue('Гладкая Наталья Васильевна');
  h.resolveSigurTargets.mockResolvedValue({ strong: [], weak: [] });
  h.resolveAffectedProfiles.mockResolvedValue([]);
  h.applyAccountLock.mockResolvedValue([]);
  h.insertTargetsIn.mockResolvedValue(0);
  h.withTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn({ query: vi.fn() }));
});

describe('добавление', () => {
  it('данные берёт из БД по ref_id, а не из тела запроса', async () => {
    h.queryOne.mockResolvedValueOnce({
      id: 42, full_name: 'Иванов Иван Иванович', birth_date: '1990-01-01',
      pension_number: '123-456-789 00', email: 'ivan@x.ru', profile_id: 'p1',
    });
    h.queryOne.mockResolvedValueOnce(null); // поиск учётки по email
    h.addEntryIn.mockResolvedValue({ entry, created: true });
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({ person: { kind: 'employee', ref_id: '42' }, reason: 'нарушение' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const passed = h.addEntryIn.mock.calls[0][1];
    expect(passed.fullName).toBe('Иванов Иван Иванович');
    expect(passed.snils).toBe('123-456-789 00');
    expect(passed.employeeId).toBe(42);
  });

  it('повторное добавление → created=false, цели и аудит не пишутся', async () => {
    h.queryOne.mockResolvedValueOnce({
      id: 42, full_name: 'Иванов', birth_date: null,
      pension_number: '12345678900', email: null, profile_id: null,
    });
    h.queryOne.mockResolvedValueOnce(null);
    h.addEntryIn.mockResolvedValue({ entry, created: false });
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({ person: { kind: 'employee', ref_id: '42' }, reason: 'нарушение' }),
      res as never,
    );

    expect((res.body as { created: boolean }).created).toBe(false);
    expect(h.insertTargetsIn).not.toHaveBeenCalled();
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
    expect(h.kickBlacklistSigur).not.toHaveBeenCalled();
  });

  it('без идентификаторов запись не создаётся', async () => {
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({ manual: { full_name: 'Иванов Иван' }, reason: 'нарушение' }),
      res as never,
    );

    expect(res.statusCode).toBe(400);
    expect(h.addEntryIn).not.toHaveBeenCalled();
  });

  it('ручной ввод с датой рождения проходит', async () => {
    h.addEntryIn.mockResolvedValue({ entry, created: true });
    h.queryOne.mockResolvedValueOnce(null);
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({ manual: { full_name: 'Иванов Иван', birth_date: '1990-01-01' }, reason: 'нарушение' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(h.addEntryIn).toHaveBeenCalled();
  });

  it('клиентская weak-цель вне серверного резолва игнорируется', async () => {
    h.queryOne.mockResolvedValueOnce({
      id: 42, full_name: 'Иванов', birth_date: null,
      pension_number: '12345678900', email: null, profile_id: null,
    });
    h.queryOne.mockResolvedValueOnce(null);
    h.resolveSigurTargets.mockResolvedValue({
      strong: [{ kind: 'employee', employee_id: 42, pass_id: null, sigur_employee_id: 777, match_reason: 'employee_id', label: 'И', org_name: null, pass_number: null }],
      weak: [],
    });
    h.addEntryIn.mockResolvedValue({ entry, created: true });
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({
        person: { kind: 'employee', ref_id: '42' },
        reason: 'нарушение',
        confirmed_weak_sigur_ids: [999999],
      }),
      res as never,
    );

    const targets = h.insertTargetsIn.mock.calls[0][2] as Array<{ sigur_employee_id: number }>;
    expect(targets.map(t => t.sigur_employee_id)).toEqual([777]);
  });

  it('переход в отключённое состояние рвёт живые сокеты', async () => {
    h.queryOne.mockResolvedValueOnce({
      id: 42, full_name: 'Иванов', birth_date: null,
      pension_number: '12345678900', email: 'ivan@x.ru', profile_id: 'p1',
    });
    h.queryOne.mockResolvedValueOnce({ id: 'p1' });
    h.addEntryIn.mockResolvedValue({ entry, created: true });
    h.applyAccountLock.mockResolvedValue([{ userProfileId: 'p1', was: false, now: true }]);
    const res = makeRes();

    await adminBlacklistController.addEntry(
      req({ person: { kind: 'employee', ref_id: '42' }, reason: 'нарушение' }),
      res as never,
    );

    expect(h.disconnectUserSockets).toHaveBeenCalledWith('p1');
    expect(h.kickBlacklistSigur).toHaveBeenCalled();
  });
});

describe('снятие', () => {
  it('без причины — 400', async () => {
    const res = makeRes();
    await adminBlacklistController.removeEntry(
      req({ reason: '' }, { entryId: '11111111-1111-1111-1111-111111111111' }),
      res as never,
    );
    expect(res.statusCode).toBe(400);
  });

  it('повторное снятие возвращает changed=false, а не ошибку', async () => {
    h.removeEntryIn.mockResolvedValue({ changed: false, entry });
    const res = makeRes();

    await adminBlacklistController.removeEntry(
      req({ reason: 'ошибочно внесён' }, { entryId: '11111111-1111-1111-1111-111111111111' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect((res.body as { changed: boolean }).changed).toBe(false);
    expect(h.logFromRequestWithClient).not.toHaveBeenCalled();
  });

  it('снятие пересчитывает состояние учётки', async () => {
    h.removeEntryIn.mockResolvedValue({ changed: true, entry });
    h.resolveAffectedProfiles.mockResolvedValue(['p1']);
    h.applyAccountLock.mockResolvedValue([{ userProfileId: 'p1', was: true, now: false }]);
    const res = makeRes();

    await adminBlacklistController.removeEntry(
      req({ reason: 'ошибочно внесён' }, { entryId: '11111111-1111-1111-1111-111111111111' }),
      res as never,
    );

    expect(res.statusCode).toBe(200);
    expect(h.applyAccountLock).toHaveBeenCalled();
    expect(h.logFromRequestWithClient).toHaveBeenCalled();
  });
});

describe('поиск персон', () => {
  it('не отдаёт сырые СНИЛС, паспорт и почту — только признаки наличия', async () => {
    h.query.mockResolvedValueOnce([{
      kind: 'employee', ref_id: '42', full_name: 'Иванов', birth_date: '1990-01-01',
      has_snils: true, has_email: true, has_passport: false,
      pass_number: null, org_name: null, extra: 'active',
    }]);
    const res = makeRes();
    const request = req({});
    (request as { query: Record<string, string> }).query = { q: 'Иванов' };

    await adminBlacklistController.searchPersons(request, res as never);

    const sql = String(h.query.mock.calls[0][0]);
    expect(sql).toContain('IS NOT NULL AS has_snils');
    // Значения не отдаём — только boolean-признаки: нет алиасов со значениями.
    expect(sql).not.toContain('AS snils');
    expect(sql).not.toContain('AS email');
    expect(sql).not.toContain('e.pension_number AS');
    expect(sql).not.toContain('p.passport_series_number,');
    // LIMIT в каждой ветке: иначе сотрудники вытеснят держателей пропусков.
    expect(sql.match(/LIMIT 20/g)).toHaveLength(2);
  });

  it('короткий запрос не идёт в БД', async () => {
    const res = makeRes();
    const request = req({});
    (request as { query: Record<string, string> }).query = { q: 'И' };

    await adminBlacklistController.searchPersons(request, res as never);

    expect(h.query).not.toHaveBeenCalled();
    expect((res.body as { data: unknown[] }).data).toEqual([]);
  });
});
