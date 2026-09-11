import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Воркер блокировок (миграция 273). Ключевые свойства:
 *  - берёт только цели активных записей — снятого человека не блокирует;
 *  - подхватывает running с истёкшим lease (процесс мог упасть после claim);
 *  - пишет результат только своим lease (цель могли перезахватить);
 *  - реконсилер возвращает блокировку, если профиль разблокировали в обход.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  updateSigurEmployee: vi.fn(),
  getSigurEmployeeProfile: vi.fn(),
  isConfigured: vi.fn(),
  getBackgroundConnectionType: vi.fn(),
  isDryRun: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({ query: h.query, execute: h.execute }));
vi.mock('../config/contractor.js', () => ({ isContractorSigurDryRun: h.isDryRun }));
vi.mock('./sigur.service.js', () => ({
  sigurService: {
    isConfigured: h.isConfigured,
    getBackgroundConnectionType: h.getBackgroundConnectionType,
  },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({ updateSigurEmployee: h.updateSigurEmployee }));
vi.mock('./sigur-live-admin.service.js', () => ({ getSigurEmployeeProfile: h.getSigurEmployeeProfile }));
vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));

const { runBlacklistSigurCycleOnce } = await import('./blacklist-sigur.scheduler.js');

/** Детерминированный прогон одного цикла, без таймеров шедулера. */
const runKick = async (): Promise<void> => {
  await runBlacklistSigurCycleOnce();
};

beforeEach(() => {
  // resetAllMocks, а не clearAllMocks: неиспользованные mockResolvedValueOnce
  // иначе протекают в следующий тест и сдвигают порядок ответов.
  vi.resetAllMocks();
  h.isDryRun.mockReturnValue(false);
  h.isConfigured.mockResolvedValue(true);
  h.getBackgroundConnectionType.mockResolvedValue('external');
  h.query.mockResolvedValue([]);
  h.execute.mockResolvedValue(1);
});

describe('claim', () => {
  it('фильтрует снятые записи и подхватывает истёкший lease', async () => {
    await runKick();

    const claimSql = String(h.query.mock.calls[0]?.[0] ?? '');
    expect(claimSql).toContain('b.removed_at IS NULL');
    expect(claimSql).toContain('SKIP LOCKED');
    // Восстановление после падения процесса: иначе цель навсегда осталась бы running.
    expect(claimSql).toContain("t.state = 'running' AND t.lease_expires_at < now()");
  });
});

describe('исполнение цели', () => {
  it('блокирует профиль и закрывает цель своим lease', async () => {
    h.query.mockResolvedValueOnce([{ id: 't1', sigur_employee_id: 777, attempts: 0 }]);
    h.query.mockResolvedValueOnce([]); // реконсилер: нечего проверять
    h.updateSigurEmployee.mockResolvedValue({});

    await runKick();

    expect(h.updateSigurEmployee).toHaveBeenCalledWith(777, { blocked: true }, 'external');
    const finish = h.execute.mock.calls.find(c => String(c[0]).includes("SET state = $3"));
    expect(finish).toBeTruthy();
    // Результат пишется только своим lease.
    expect(String(finish?.[0])).toContain('lease_owner = $2');
  });

  it('dry-run не дёргает Sigur', async () => {
    h.isDryRun.mockReturnValue(true);
    h.query.mockResolvedValueOnce([{ id: 't1', sigur_employee_id: 777, attempts: 0 }]);
    h.query.mockResolvedValueOnce([]);

    await runKick();

    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
  });

  it('ошибка Sigur возвращает цель в очередь, а после лимита помечает failed', async () => {
    h.query.mockResolvedValueOnce([{ id: 't1', sigur_employee_id: 777, attempts: 4 }]);
    h.query.mockResolvedValueOnce([]);
    h.updateSigurEmployee.mockRejectedValue(new Error('Sigur timeout'));

    await runKick();

    const retry = h.execute.mock.calls.find(c => String(c[0]).includes('attempts = attempts + 1'));
    expect(retry).toBeTruthy();
    expect(retry?.[1]).toContain('failed');
  });

  it('недоступный Sigur не роняет цикл — цель ждёт следующего тика', async () => {
    h.isConfigured.mockResolvedValue(false);
    h.query.mockResolvedValueOnce([{ id: 't1', sigur_employee_id: 777, attempts: 0 }]);
    h.query.mockResolvedValueOnce([]);

    await runKick();

    expect(h.updateSigurEmployee).not.toHaveBeenCalled();
    const retry = h.execute.mock.calls.find(c => String(c[0]).includes('attempts = attempts + 1'));
    expect(retry).toBeTruthy();
  });
});

describe('реконсилер', () => {
  it('возвращает блокировку, если профиль разблокировали в обход', async () => {
    h.query.mockResolvedValueOnce([]); // claim: нет целей
    h.query.mockResolvedValueOnce([{ id: 't9', sigur_employee_id: 900 }]);
    h.getSigurEmployeeProfile.mockResolvedValue({ profile: { blocked: false } });

    await runKick();

    const requeue = h.execute.mock.calls.find(c => String(c[0]).includes("state = 'pending'"));
    expect(requeue).toBeTruthy();
  });

  it('если профиль всё ещё заблокирован — только отмечает проверку', async () => {
    h.query.mockResolvedValueOnce([]);
    h.query.mockResolvedValueOnce([{ id: 't9', sigur_employee_id: 900 }]);
    h.getSigurEmployeeProfile.mockResolvedValue({ profile: { blocked: true } });

    await runKick();

    const requeue = h.execute.mock.calls.find(c => String(c[0]).includes("state = 'pending'"));
    expect(requeue).toBeFalsy();
    const verified = h.execute.mock.calls.find(c => String(c[0]).includes('SET verified_at = now()'));
    expect(verified).toBeTruthy();
  });

  it('сверяет только цели активных записей', async () => {
    h.query.mockResolvedValueOnce([]);
    await runKick();
    const verifySql = String(h.query.mock.calls[1]?.[0] ?? '');
    expect(verifySql).toContain('b.removed_at IS NULL');
  });
});
