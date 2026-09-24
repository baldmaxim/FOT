import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/node';

const m = vi.hoisted(() => ({
  withTransaction: vi.fn(),
  isDryRun: vi.fn(),
  logWithClient: vi.fn(),
  findActive: vi.fn(),
  findActiveBySigurEmployeeId: vi.fn(),
  empCacheInvalidate: vi.fn(),
  bgConn: vi.fn(),
  getEmployeeById: vi.fn(),
  updateEmployee: vi.fn(),
  invalidateEmployeeCache: vi.fn(),
  invalidateDirectory: vi.fn(),
  syncProfileName: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ withTransaction: m.withTransaction }));
vi.mock('../config/contractor.js', () => ({ isContractorSigurDryRun: m.isDryRun }));
vi.mock('./audit.service.js', () => ({
  auditService: { logWithClient: m.logWithClient },
  AUDIT_ACTIONS: { CONTRACTOR_PASS_HOLDER_RENAMED: 'CONTRACTOR_PASS_HOLDER_RENAMED' },
}));
vi.mock('./blacklist.service.js', () => ({
  findActive: m.findActive,
  findActiveBySigurEmployeeId: m.findActiveBySigurEmployeeId,
  blockMessage: (entries: Array<{ full_name: string }>, canSee: boolean) =>
    (canSee ? `В чёрном списке: ${entries[0].full_name}` : 'Действие запрещено. Обратитесь к администратору.'),
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: m.empCacheInvalidate } }));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    getBackgroundConnectionType: m.bgConn,
    getEmployeeById: m.getEmployeeById,
    updateEmployee: m.updateEmployee,
    invalidateEmployeeCache: m.invalidateEmployeeCache,
  },
}));
vi.mock('./sigur-live-admin.service.js', () => ({ invalidateSigurDirectoryCaches: m.invalidateDirectory }));
vi.mock('./sigur-sync-shared.js', () => ({
  normalizeEmployee: (raw: Record<string, unknown>) => ({ name: String(raw.name ?? '').trim() }),
}));
vi.mock('./user-profile-name.service.js', () => ({ syncProfileNameFromEmployee: m.syncProfileName }));

import {
  renamePassHolder,
  renameHolderBodySchema,
  RenameHolderError,
  type IRenameHolderInput,
} from './contractor-pass-rename.service.js';

const PASS = '11111111-1111-1111-1111-111111111111';
const ORG = '22222222-2222-2222-2222-222222222222';
const REVISION = '2026-09-16T12:11:08.495Z';
const OLD = 'Насыров Герхард Хасанович';
const NEW = 'Насиров Шерзад Хасанович';

const basePass = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PASS,
  pass_number: '2806',
  status: 'applied',
  approval_status: 'approved',
  org_department_id: ORG,
  // bigint из pg приходит строкой
  sigur_employee_id: '147081',
  holder_name: OLD,
  passport_series_number: 'FA1234567',
  birth_date: '1990-01-01',
  updated_at: new Date(REVISION),
  ...over,
});

interface IWire {
  pass?: Record<string, unknown> | null;
  holder?: Record<string, unknown> | null;
  employees?: Array<Record<string, unknown>>;
  commitFails?: boolean;
  auditFails?: boolean;
}

let clientQuery: ReturnType<typeof vi.fn>;
let fakeClient: { query: ReturnType<typeof vi.fn> };

const wire = ({
  pass = basePass(),
  holder = { id: 'h-1', holder_name: OLD },
  employees = [{ id: 9794, full_name: OLD, name_locked: false }],
  commitFails = false,
  auditFails = false,
}: IWire = {}): void => {
  clientQuery = vi.fn(async (sql: string) => {
    const s = String(sql);
    if (s.includes('FROM contractor_passes p')) return { rows: pass ? [pass] : [] };
    if (s.includes('FROM contractor_pass_holders')) return { rows: holder ? [holder] : [] };
    if (s.includes('FROM employees')) return { rows: employees };
    return { rows: [], rowCount: 1 };
  });
  fakeClient = { query: clientQuery };
  m.withTransaction.mockImplementation(async (fn: (c: typeof fakeClient) => Promise<unknown>) => {
    const result = await fn(fakeClient);
    if (commitFails) throw new Error('COMMIT failed');
    return result;
  });
  if (auditFails) m.logWithClient.mockRejectedValue(new Error('audit insert failed'));
};

const input = (over: Partial<IRenameHolderInput> = {}): IRenameHolderInput => ({
  passId: PASS,
  newName: NEW,
  expectedUpdatedAt: REVISION,
  userId: 'user-security',
  canSeeBlacklistReason: true,
  ...over,
});

const sqlCalls = (fragment: string) => clientQuery.mock.calls.filter(c => String(c[0]).includes(fragment));
// Записи — только операторы UPDATE, а не «FOR UPDATE» в SELECT.
const writeCalls = () => clientQuery.mock.calls.filter(c => /^\s*UPDATE\b/.test(String(c[0])));

const expectRenameError = async (promise: Promise<unknown>, http: number, text?: string): Promise<void> => {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(RenameHolderError);
  expect((error as RenameHolderError).http).toBe(http);
  if (text) expect((error as RenameHolderError).message).toContain(text);
};

beforeEach(() => {
  Object.values(m).forEach(fn => fn.mockReset());
  vi.mocked(Sentry.captureException).mockClear();
  m.isDryRun.mockReturnValue(false);
  m.bgConn.mockResolvedValue('external');
  m.getEmployeeById.mockResolvedValue({ id: 147081, name: OLD });
  m.updateEmployee.mockResolvedValue({});
  m.findActive.mockResolvedValue({ strong: [], weak: [] });
  m.findActiveBySigurEmployeeId.mockResolvedValue(null);
  m.logWithClient.mockResolvedValue(undefined);
  m.syncProfileName.mockResolvedValue(1);
});

describe('renamePassHolder — одобренный пропуск', () => {
  it('пишет пропуск, строку владельца, кадры, ростер, затем Sigur и аудит в транзакции', async () => {
    wire();
    const result = await renamePassHolder(input());

    expect(result).toEqual({ changed: true, holder_name: NEW, employee_updated: true, sigur_updated: true });

    const passUpdate = sqlCalls('UPDATE contractor_passes')[0];
    expect(passUpdate[1]).toEqual([NEW, PASS]);
    const holderUpdate = sqlCalls('UPDATE contractor_pass_holders')[0];
    expect(holderUpdate[1]).toEqual([NEW, 'h-1']);
    expect(String(holderUpdate[0])).not.toContain('changed_by');
    const employeeUpdate = sqlCalls('UPDATE employees')[0];
    expect(employeeUpdate[1]).toEqual([NEW, 'Насиров', 'Шерзад', 'Хасанович', 9794]);
    expect(m.syncProfileName).toHaveBeenCalledWith(fakeClient, 9794);
    const rosterUpdate = sqlCalls('UPDATE contractor_roster')[0];
    expect(String(rosterUpdate[0])).toContain("state = 'active'");
    expect(rosterUpdate[1]).toEqual([NEW, ORG, 147081]);

    expect(m.getEmployeeById).toHaveBeenCalledWith(147081, 'external');
    expect(m.updateEmployee).toHaveBeenCalledTimes(1);
    expect(m.updateEmployee).toHaveBeenCalledWith(147081, { name: NEW }, 'external');

    // Sigur — после всех записей в БД, аудит — тем же клиентом после Sigur.
    const employeeUpdateOrder = clientQuery.mock.invocationCallOrder[
      clientQuery.mock.calls.findIndex(c => String(c[0]).includes('UPDATE employees'))
    ];
    expect(employeeUpdateOrder).toBeLessThan(m.updateEmployee.mock.invocationCallOrder[0]);
    expect(m.updateEmployee.mock.invocationCallOrder[0]).toBeLessThan(m.logWithClient.mock.invocationCallOrder[0]);
    expect(m.logWithClient).toHaveBeenCalledWith(fakeClient, expect.objectContaining({
      action: 'CONTRACTOR_PASS_HOLDER_RENAMED',
      entity_type: 'contractor_pass',
      entity_id: PASS,
      details: expect.objectContaining({
        old_name: OLD, new_name: NEW, sigur_previous_name: OLD, sigur_updated: true, employee_id: 9794,
      }),
    }));

    expect(m.empCacheInvalidate).toHaveBeenCalledWith(9794);
    expect(m.invalidateEmployeeCache).toHaveBeenCalled();
    expect(m.invalidateDirectory).toHaveBeenCalled();
  });

  it('кадры и Sigur уже верные (случай 2806): правит только пропуск, PUT в Sigur не нужен', async () => {
    wire({ employees: [{ id: 9794, full_name: NEW, name_locked: false }] });
    m.getEmployeeById.mockResolvedValue({ id: 147081, name: NEW });

    const result = await renamePassHolder(input());

    expect(result).toEqual({ changed: true, holder_name: NEW, employee_updated: false, sigur_updated: false });
    expect(sqlCalls('UPDATE contractor_passes')).toHaveLength(1);
    expect(sqlCalls('UPDATE employees')).toHaveLength(0);
    expect(m.updateEmployee).not.toHaveBeenCalled();
    expect(m.invalidateDirectory).not.toHaveBeenCalled();
  });

  it('всё уже совпадает → changed:false, без записей и аудита', async () => {
    wire({
      pass: basePass({ holder_name: NEW }),
      holder: { id: 'h-1', holder_name: NEW },
      employees: [{ id: 9794, full_name: NEW, name_locked: false }],
    });
    const result = await renamePassHolder(input());
    expect(result.changed).toBe(false);
    expect(writeCalls()).toHaveLength(0);
    expect(m.logWithClient).not.toHaveBeenCalled();
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('dry-run Sigur: кадры правятся, Sigur не вызывается', async () => {
    m.isDryRun.mockReturnValue(true);
    wire();
    const result = await renamePassHolder(input());
    expect(result).toMatchObject({ employee_updated: true, sigur_updated: false });
    expect(m.getEmployeeById).not.toHaveBeenCalled();
    expect(m.updateEmployee).not.toHaveBeenCalled();
  });
});

describe('renamePassHolder — неодобренный пропуск', () => {
  it.each(['pending', 'not_submitted', 'rejected'])('approval_status=%s: только пропуск, без кадров и Sigur', async approval => {
    wire({ pass: basePass({ approval_status: approval, status: 'submitted' }) });
    const result = await renamePassHolder(input());

    expect(result).toEqual({ changed: true, holder_name: NEW, employee_updated: false, sigur_updated: false });
    expect(sqlCalls('FROM employees')).toHaveLength(0);
    expect(sqlCalls('UPDATE employees')).toHaveLength(0);
    expect(sqlCalls('UPDATE contractor_roster')).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
    expect(m.updateEmployee).not.toHaveBeenCalled();
    expect(m.logWithClient).toHaveBeenCalledTimes(1);
  });
});

describe('renamePassHolder — отказы до любых изменений', () => {
  it('пропуск не найден → 404', async () => {
    wire({ pass: null });
    await expectRenameError(renamePassHolder(input()), 404);
  });

  it.each(['revoked', 'in_pool'])('status=%s → 409', async status => {
    wire({ pass: basePass({ status }) });
    await expectRenameError(renamePassHolder(input()), 409);
    expect(writeCalls()).toHaveLength(0);
  });

  it('пустой слот (держателя нет) → 409, без записей', async () => {
    wire({ pass: basePass({ holder_name: null, approval_status: 'not_submitted', status: 'assigned' }), holder: null });
    await expectRenameError(renamePassHolder(input()), 409, 'нет держателя');
    expect(writeCalls()).toHaveLength(0);
  });

  it('устаревшая ревизия → 409', async () => {
    wire();
    await expectRenameError(renamePassHolder(input({ expectedUpdatedAt: '2026-09-16T12:11:09.000Z' })), 409, 'изменён');
    expect(writeCalls()).toHaveLength(0);
  });

  it('битая ревизия → 400', async () => {
    wire();
    await expectRenameError(renamePassHolder(input({ expectedUpdatedAt: 'not-a-date' })), 400);
  });

  it('одобренный без sigur_employee_id → 409, Sigur не вызывается', async () => {
    wire({ pass: basePass({ sigur_employee_id: null }) });
    await expectRenameError(renamePassHolder(input()), 409, 'нет профиля Sigur');
    expect(writeCalls()).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('одобренный без карточки в кадрах → 409', async () => {
    wire({ employees: [] });
    await expectRenameError(renamePassHolder(input()), 409, 'не найден');
    expect(writeCalls()).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('две карточки на профиль Sigur → 409', async () => {
    wire({
      employees: [
        { id: 1, full_name: OLD, name_locked: false },
        { id: 2, full_name: OLD, name_locked: false },
      ],
    });
    await expectRenameError(renamePassHolder(input()), 409, 'несколькими');
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('name_locked и имя в кадрах другое → 409 до Sigur', async () => {
    wire({ employees: [{ id: 9794, full_name: OLD, name_locked: true }] });
    await expectRenameError(renamePassHolder(input()), 409, 'name_locked');
    expect(writeCalls()).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('профиль Sigur — цель чёрного списка → 409 до Sigur, проверка тем же клиентом под локом', async () => {
    wire();
    m.findActiveBySigurEmployeeId.mockResolvedValue({ full_name: 'Кто-то', reason: 'x', created_by_name: 'y' });
    await expectRenameError(renamePassHolder(input()), 409, 'чёрном списке');
    expect(m.findActiveBySigurEmployeeId).toHaveBeenCalledWith(147081, fakeClient);
    expect(sqlCalls('pg_advisory_xact_lock')[0][1]).toEqual(['blacklist:sigur:147081']);
    expect(writeCalls()).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('новое ФИО совпало с чёрным списком (strong) → 409 до Sigur; документы из заблокированной строки', async () => {
    wire();
    m.findActive.mockResolvedValue({ strong: [{ full_name: NEW, reason: 'x', created_by_name: 'y' }], weak: [] });
    await expectRenameError(renamePassHolder(input({ canSeeBlacklistReason: false })), 409, 'Обратитесь к администратору');
    expect(m.findActive).toHaveBeenCalledWith(
      { fullName: NEW, birthDate: '1990-01-01', passport: 'FA1234567', employeeId: 9794 },
      fakeClient,
    );
    expect(writeCalls()).toHaveLength(0);
    expect(m.getEmployeeById).not.toHaveBeenCalled();
  });

  it('weak-совпадение (только ФИО) не мешает', async () => {
    wire();
    m.findActive.mockResolvedValue({ strong: [], weak: [{ full_name: NEW }] });
    const result = await renamePassHolder(input());
    expect(result.changed).toBe(true);
  });
});

describe('renamePassHolder — сбои Sigur и компенсация', () => {
  it('чтение профиля Sigur упало → 502, PUT не было, компенсации нет', async () => {
    wire();
    m.getEmployeeById.mockRejectedValue(new Error('Sigur timeout'));
    await expectRenameError(renamePassHolder(input()), 502, 'ФИО не изменено');
    expect(m.updateEmployee).not.toHaveBeenCalled();
    expect(m.empCacheInvalidate).not.toHaveBeenCalled();
  });

  it('профиль Sigur без имени → 502 без PUT', async () => {
    wire();
    m.getEmployeeById.mockResolvedValue({ id: 147081, name: '  ' });
    await expectRenameError(renamePassHolder(input()), 502);
    expect(m.updateEmployee).not.toHaveBeenCalled();
  });

  it('PUT в Sigur упал → компенсация прежним именем, 502 «ничего не изменено»', async () => {
    wire();
    m.updateEmployee.mockRejectedValueOnce(new Error('Sigur 500')).mockResolvedValueOnce({});
    await expectRenameError(renamePassHolder(input()), 502, 'ничего не изменено');
    expect(m.updateEmployee).toHaveBeenCalledTimes(2);
    expect(m.updateEmployee).toHaveBeenLastCalledWith(147081, { name: OLD }, 'external');
    expect(m.logWithClient).not.toHaveBeenCalled();
    expect(m.empCacheInvalidate).not.toHaveBeenCalled();
  });

  it('аудит упал после успешного PUT → компенсация', async () => {
    wire({ auditFails: true });
    await expectRenameError(renamePassHolder(input()), 502, 'ничего не изменено');
    expect(m.updateEmployee).toHaveBeenNthCalledWith(1, 147081, { name: NEW }, 'external');
    expect(m.updateEmployee).toHaveBeenNthCalledWith(2, 147081, { name: OLD }, 'external');
  });

  it('COMMIT упал после успешного PUT → компенсация, кэши не сбрасываются', async () => {
    wire({ commitFails: true });
    await expectRenameError(renamePassHolder(input()), 502, 'ничего не изменено');
    expect(m.updateEmployee).toHaveBeenLastCalledWith(147081, { name: OLD }, 'external');
    expect(m.empCacheInvalidate).not.toHaveBeenCalled();
    expect(m.invalidateDirectory).not.toHaveBeenCalled();
  });

  it('компенсация тоже упала → Sentry и 502 с просьбой проверить профиль вручную', async () => {
    wire({ commitFails: true });
    m.updateEmployee.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Sigur down'));
    await expectRenameError(renamePassHolder(input()), 502, 'Проверьте профиль Sigur №147081');
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: expect.objectContaining({ sigurEmployeeId: 147081, previousName: OLD, newName: NEW }),
      }),
    );
  });

  it('отказ до Sigur (409) не запускает компенсацию', async () => {
    wire({ employees: [] });
    await expectRenameError(renamePassHolder(input()), 409);
    expect(m.updateEmployee).not.toHaveBeenCalled();
  });
});

describe('renameHolderBodySchema', () => {
  it('схлопывает пробелы и принимает ISO-ревизию со смещением', () => {
    const parsed = renameHolderBodySchema.parse({
      full_name: '  Насиров   Шерзад  Хасанович ',
      expected_updated_at: '2026-09-16T15:11:08.495+03:00',
    });
    expect(parsed.full_name).toBe('Насиров Шерзад Хасанович');
  });

  it.each([
    [{ full_name: NEW }, 'нет ревизии'],
    [{ full_name: NEW, expected_updated_at: '' }, 'пустая ревизия'],
    [{ full_name: NEW, expected_updated_at: 'вчера' }, 'не дата'],
    [{ full_name: 'Насиров', expected_updated_at: REVISION }, 'одно слово'],
    [{ full_name: '   ', expected_updated_at: REVISION }, 'пустое ФИО'],
    [{ expected_updated_at: REVISION }, 'нет ФИО'],
  ])('%j → ошибка (%s)', body => {
    expect(renameHolderBodySchema.safeParse(body).success).toBe(false);
  });
});
