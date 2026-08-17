import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Прогон syncEmployeesLogic на моках БД и Sigur. Проверяем поведение вокруг
 * увольнений (инцидент 10–13.08.2026): синк не возвращает уволенных в строй,
 * не двигает их отдел/должность и не опережает запланированные увольнения.
 */

const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  isConfigured: vi.fn(),
  getEmployeesCached: vi.fn(),
  getSigurSettings: vi.fn(),
  getKnownArchive: vi.fn(),
  ensureLocalArchive: vi.fn(),
  changeDepartment: vi.fn(),
  changePosition: vi.fn(),
  batchMove: vi.fn(),
  auditLog: vi.fn(),
  upsertAccess: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));
vi.mock('./sigur.service.js', () => ({
  sigurService: { isConfigured: h.isConfigured, getEmployeesCached: h.getEmployeesCached },
}));
vi.mock('./settings.service.js', () => ({
  settingsService: { getSigurConnectionSettings: h.getSigurSettings },
}));
vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: h.getKnownArchive,
  ensureLocalArchiveDepartment: h.ensureLocalArchive,
}));
vi.mock('./employee-changes.service.js', () => ({
  employeeChangesService: { changeDepartment: h.changeDepartment, changePosition: h.changePosition },
}));
vi.mock('./sigur-live-employees-crud.service.js', () => ({ batchMoveSigurEmployees: h.batchMove }));
vi.mock('./audit.service.js', () => ({ auditService: { log: h.auditLog } }));
vi.mock('./employee-department-access.service.js', () => ({
  upsertTechnicalDepartmentAccess: h.upsertAccess,
}));
vi.mock('./employee-cache.service.js', () => ({ employeeCache: { invalidate: vi.fn() } }));
vi.mock('./presence-polling-cache.service.js', () => ({
  invalidatePresencePollingEmployeeCache: vi.fn(),
}));
vi.mock('./timekeeper-scope.service.js', () => ({ invalidateTimekeeperScopeCache: vi.fn() }));
vi.mock('./sigur-sync-shared.js', async () => {
  const actual = await vi.importActual<typeof import('./sigur-sync-shared.js')>('./sigur-sync-shared.js');
  return {
    ...actual,
    getWhitelistedDepartmentIdsCached: vi.fn(async () => null),
    getPositionsRaw: vi.fn(async () => []),
    logSampleAndWarn: vi.fn(),
  };
});

import { syncEmployeesLogic } from './sigur-sync-employees.service.js';

const ARCHIVE_LOCAL = 'local-archive-uuid';
const ARCHIVE_SIGUR = 142094;
const BRIGADE_LOCAL = 'local-brigade-uuid';
const BRIGADE_SIGUR = 142383;

interface IDbEmployee {
  id: number;
  sigur_employee_id: number;
  employment_status: string;
  department_locked?: boolean;
  name_locked?: boolean;
  org_department_id: string | null;
  position_id: string | null;
  tab_number: string | null;
  full_name: string | null;
  last_name?: string | null;
  first_name?: string | null;
  middle_name?: string | null;
  dismissal_date: string | null;
  is_archived?: boolean;
}

const dbEmployee = (over: Partial<IDbEmployee> = {}): IDbEmployee => ({
  id: 128,
  sigur_employee_id: 91831,
  employment_status: 'active',
  department_locked: false,
  name_locked: false,
  is_archived: false,
  org_department_id: BRIGADE_LOCAL,
  position_id: 'position-1',
  tab_number: '05510',
  full_name: 'Аллакулов Улугбек Туракулович',
  last_name: 'Аллакулов',
  first_name: 'Улугбек',
  middle_name: 'Туракулович',
  dismissal_date: null,
  ...over,
});

/** Роутер моков `query` по характерным фрагментам SQL. */
const setupQueries = (opts: {
  employees: IDbEmployee[];
  freshStatus?: string;
  freshDeptId?: string | null;
}): void => {
  let employeesPage = 0;
  h.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM employees') && sql.includes('sigur_employee_id IS NOT NULL')
      && sql.includes('LIMIT')) {
      return employeesPage++ === 0 ? opts.employees : [];
    }
    if (sql.includes('sigur_employee_id IS NULL')) return [];
    if (sql.includes('FROM org_departments') && sql.includes('sigur_department_id IS NOT NULL')) {
      return [
        { id: ARCHIVE_LOCAL, sigur_department_id: ARCHIVE_SIGUR, name: 'Уволенные', is_active: true },
        { id: BRIGADE_LOCAL, sigur_department_id: BRIGADE_SIGUR, name: 'бр.Аллакулов У.Т.', is_active: true },
      ];
    }
    if (sql.includes('parent_id') && sql.includes('org_departments')) {
      return [{ id: ARCHIVE_LOCAL, parent_id: null }, { id: BRIGADE_LOCAL, parent_id: null }];
    }
    if (sql.includes('FROM positions')) {
      return [{ id: 'position-1', sigur_position_id: 501, name: 'Маляр' }];
    }
    if (sql.includes('FROM employee_assignments')) return [];
    if (sql.includes("employment_status = 'fired'") && sql.includes('sigur_employee_id')) {
      return opts.employees
        .filter(e => e.employment_status === 'fired')
        .map(e => ({ id: e.id, sigur_employee_id: e.sigur_employee_id }));
    }
    return [];
  });

  h.queryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('dismissal_apply_started_at')) {
      return {
        org_department_id: opts.freshDeptId ?? ARCHIVE_LOCAL,
        employment_status: opts.freshStatus ?? 'fired',
        dismissal_date: '2026-08-12',
        dismissal_apply_started_at: null,
      };
    }
    return null;
  });
};

/** Собирает SQL и параметры всех запросов, выполненных внутри withTransaction. */
const collectTransactionQueries = (
  rowCountByFragment: Record<string, number> = {},
  rowsByFragment: Record<string, unknown[]> = {},
) => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      const fragment = Object.keys(rowCountByFragment).find(f => sql.includes(f));
      const rowsFragment = Object.keys(rowsByFragment).find(f => sql.includes(f));
      const rows = rowsFragment ? rowsByFragment[rowsFragment] : [];
      return { rows, rowCount: fragment ? rowCountByFragment[fragment] : 1 };
    },
  }));
  return calls;
};

describe('syncEmployeesLogic — увольнения', () => {
  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
    h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.ensureLocalArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.changeDepartment.mockResolvedValue('applied');
    h.changePosition.mockResolvedValue(undefined);
    h.batchMove.mockResolvedValue({ moved: 1, requested: 1, failedIds: [] });
    h.execute.mockResolvedValue(1);
    collectTransactionQueries();
  });

  it('уволенный, которого Sigur отдаёт в бригаде: без реактивации, с фиксацией расхождения', async () => {
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 91831, name: 'Аллакулов Улугбек Туракулович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.fired_mismatch_detected).toBe(1);
    // Расхождение устранено переносом в архивную папку Sigur тем же прогоном.
    expect(result.fired_mismatch_unresolved).toBe(0);
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.changePosition).not.toHaveBeenCalled();
    // Ни один UPDATE не выставляет сотруднику active.
    const statusUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('employment_status'));
    expect(statusUpdates).toHaveLength(0);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SIGUR_SYNC_FIRED_MISMATCH' }));
  });

  it('пустая архивная настройка: реактивации по-прежнему нет, расхождение остаётся нерешённым', async () => {
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: null });
    setupQueries({ employees: [dbEmployee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-12' })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 91831, name: 'Аллакулов Улугбек Туракулович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.fired_mismatch_detected).toBe(1);
    expect(result.fired_mismatch_unresolved).toBe(1);
    expect(h.changeDepartment).not.toHaveBeenCalled();
    expect(h.batchMove).not.toHaveBeenCalled();
  });

  it('уволенный с прежним отделом, но новой должностью в Sigur: должность не меняется', async () => {
    setupQueries({
      employees: [dbEmployee({
        employment_status: 'fired',
        org_department_id: ARCHIVE_LOCAL,
        position_id: 'position-old',
        dismissal_date: '2026-08-12',
      })],
      freshStatus: 'fired',
      freshDeptId: ARCHIVE_LOCAL,
    });
    // Sigur отдаёт того же архивного отдела, но с другой должностью.
    h.getEmployeesCached.mockResolvedValue([
      { id: 91831, name: 'Аллакулов Улугбек Туракулович', departmentId: ARCHIVE_SIGUR, positionId: 501, position: 'Маляр', tabId: '05510' },
    ]);

    await syncEmployeesLogic();

    expect(h.changePosition).not.toHaveBeenCalled();
    expect(h.changeDepartment).not.toHaveBeenCalled();
  });

  it('auto-fire не трогает сотрудника с уже назначенным увольнением', async () => {
    setupQueries({
      employees: [
        dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: '2026-08-20' }),
        dbEmployee({ id: 922, sigur_employee_id: 125204, dismissal_date: '2026-08-12' }),
      ],
    });
    // Обоих нет в выгрузке Sigur, но у обоих назначено увольнение.
    h.getEmployeesCached.mockResolvedValue([
      { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(h.withTransaction).not.toHaveBeenCalled();
  });

  it('auto-fire увольняет МСК-датой, с исключением из табеля со следующего дня', async () => {
    const txCalls = collectTransactionQueries();
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(1);
    const fireCall = txCalls.find(c => c.sql.includes("employment_status = 'fired'"));
    expect(fireCall).toBeDefined();
    // Гард: применяем только к активному без назначенного увольнения и без claim.
    expect(fireCall!.sql).toContain("employment_status = 'active'");
    expect(fireCall!.sql).toContain('dismissal_date IS NULL');
    expect(fireCall!.sql).toContain('dismissal_apply_started_at IS NULL');

    const [dismissalDate, exclusionDate] = fireCall!.params as string[];
    const msk = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
    expect(dismissalDate).toBe(msk);
    const nextDay = new Date(`${msk}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    expect(exclusionDate).toBe(nextDay.toISOString().slice(0, 10));

    // Доступы гасятся в той же транзакции.
    expect(txCalls.some(c => c.sql.includes('employee_department_access'))).toBe(true);
  });

  it('auto-fire: провал вставки события увольнения откатывает сотрудника целиком', async () => {
    setupQueries({ employees: [dbEmployee({ id: 921, sigur_employee_id: 125203, dismissal_date: null })] });
    h.getEmployeesCached.mockResolvedValue([
      { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' },
    ]);
    // Транзакция падает на INSERT события — наружу это должно выйти ошибкой,
    // а сотрудник не должен попасть в auto_fired.
    h.withTransaction.mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: async (sql: string) => {
        if (sql.includes('employee_dismissal_events')) throw new Error('insert failed');
        return { rows: [], rowCount: 1 };
      },
    }));

    const result = await syncEmployeesLogic();

    expect(result.auto_fired).toBe(0);
    expect(result.errors.some(e => e.includes('auto-fire 921'))).toBe(true);
  });
});

/**
 * Смена карточки Sigur у одного человека (инцидент 14.08.2026): старая карточка
 * уходит в архивную папку, новая появляется в рабочем отделе. Без гарда синк
 * оформлял это как «увольнение + приём нового» и порождал дубль в табеле.
 */
describe('syncEmployeesLogic — смена карточки Sigur (rebind)', () => {
  const OLD_SIGUR = 143276;
  const NEW_SIGUR = 125698;
  const NAME = 'Шарипов Исмоилджон Нуруллоевич';

  const employee = (over: Partial<IDbEmployee> = {}): IDbEmployee => dbEmployee({
    id: 2568,
    sigur_employee_id: OLD_SIGUR,
    employment_status: 'active',
    org_department_id: BRIGADE_LOCAL,
    tab_number: '05919',
    full_name: NAME,
    last_name: 'Шарипов',
    first_name: 'Исмоилджон',
    middle_name: 'Нуруллоевич',
    dismissal_date: null,
    ...over,
  });

  const card = (sigurId: number, deptId: number, tabId: string | null = null) => ({
    id: sigurId, name: NAME, departmentId: deptId, positionId: 501, position: 'Маляр', tabId,
  });

  /** Строка сотрудника, которую отдаёт SELECT … FOR UPDATE внутри rebind-транзакции. */
  const freshRow = (over: Record<string, unknown> = {}) => ({
    'FOR UPDATE': [{
      sigur_employee_id: OLD_SIGUR,
      employment_status: 'active',
      dismissal_date: null,
      dismissal_apply_started_at: null,
      org_department_id: BRIGADE_LOCAL,
      position_id: 'position-1',
      department_locked: false,
      ...over,
    }],
  });

  beforeEach(() => {
    Object.values(h).forEach(fn => fn.mockReset());
    h.isConfigured.mockResolvedValue(true);
    h.getSigurSettings.mockResolvedValue({ archiveDepartmentId: ARCHIVE_SIGUR });
    h.getKnownArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.ensureLocalArchive.mockResolvedValue({ id: ARCHIVE_LOCAL, name: 'Уволенные', source: 'sigur' });
    h.changeDepartment.mockResolvedValue('applied');
    h.changePosition.mockResolvedValue(undefined);
    h.batchMove.mockResolvedValue({ moved: 0, requested: 0, failedIds: [] });
    h.execute.mockResolvedValue(1);
    collectTransactionQueries({}, freshRow());
  });

  const insertCalls = () => h.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO employees'));

  it('переносит привязку на новую карточку, без вставки и без увольнения', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(1);
    expect(result.imported).toBe(0);
    expect(insertCalls()).toHaveLength(0);

    const rebindUpdate = txCalls.find(c => c.sql.includes('SET sigur_employee_id'));
    expect(rebindUpdate).toBeDefined();
    expect(rebindUpdate!.params[0]).toBe(NEW_SIGUR);
    expect(rebindUpdate!.params[1]).toBe(BRIGADE_LOCAL);
    // Увольнения в этот тик нет — ни в транзакции, ни прямым update.
    expect(txCalls.some(c => c.sql.includes("employment_status = 'fired'"))).toBe(false);
    expect(h.execute.mock.calls.filter(([sql]) => String(sql).includes('employment_status'))).toHaveLength(0);
    // Технический доступ пишется той же транзакцией.
    expect(txCalls.some(c => c.sql.includes('employee_department_access'))).toBe(true);
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'SIGUR_SYNC_CARD_REBIND' }));
  });

  it('обратный порядок карточек в выгрузке даёт тот же результат', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(NEW_SIGUR, BRIGADE_SIGUR),
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(1);
    expect(insertCalls()).toHaveLength(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(true);
  });

  it('повторный тик после rebind: изменений нет', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR)]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.imported).toBe(0);
    expect(insertCalls()).toHaveLength(0);
  });

  it('две новые карточки с тем же ФИО: вставки нет, обе в unmatched', async () => {
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
      card(NEW_SIGUR + 1, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId).sort()).toEqual([NEW_SIGUR, NEW_SIGUR + 1].sort());
  });

  it('две архивные карточки с тем же ФИО: новая уходит в unmatched', async () => {
    setupQueries({ employees: [employee(), employee({ id: 2569, sigur_employee_id: OLD_SIGUR + 1 })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(OLD_SIGUR + 1, ARCHIVE_SIGUR),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('кандидат уже уволен: автоматической реактивации нет, новая карточка в unmatched', async () => {
    setupQueries({
      employees: [employee({ employment_status: 'fired', org_department_id: ARCHIVE_LOCAL, dismissal_date: '2026-08-14' })],
    });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
    expect(h.execute.mock.calls.filter(([sql]) => String(sql).includes("employment_status = 'active'"))).toHaveLength(0);
  });

  it('кандидат с назначенным увольнением: rebind не делаем', async () => {
    setupQueries({ employees: [employee({ dismissal_date: '2026-08-20' })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('department_locked и другой отдел: в unmatched, сотрудник не остаётся в «Уволенных»', async () => {
    setupQueries({ employees: [employee({ department_locked: true, org_department_id: 'other-dept-uuid' })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('состояние разошлось (увольнение применилось параллельно): изменений нет, карточка в unmatched', async () => {
    collectTransactionQueries({}, freshRow({ employment_status: 'fired', dismissal_date: '2026-08-14' }));
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('ошибка транзакции rebind: пара в unmatched, прогон продолжается', async () => {
    h.withTransaction.mockImplementation(async () => { throw new Error('deadlock detected'); });
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(result.errors.some(e => e.includes('card rebind 2568'))).toBe(true);
    expect(insertCalls()).toHaveLength(0);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('архивный локальный профиль не перепривязывается и не порождает второй профиль', async () => {
    const txCalls = collectTransactionQueries({}, freshRow());
    setupQueries({ employees: [employee({ is_archived: true })] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(false);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('профиль стал архивным между планом и применением: rebind не выполняется', async () => {
    const txCalls = collectTransactionQueries({}, freshRow({ is_archived: true }));
    setupQueries({ employees: [employee()] });
    h.getEmployeesCached.mockResolvedValue([
      card(OLD_SIGUR, ARCHIVE_SIGUR, '05919'),
      card(NEW_SIGUR, BRIGADE_SIGUR),
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(txCalls.some(c => c.sql.includes('SET sigur_employee_id'))).toBe(false);
    expect(result.unmatched.map(u => u.sigurId)).toEqual([NEW_SIGUR]);
  });

  it('portal-only привязка: пустой tabId не затирает табельный номер', async () => {
    setupQueries({ employees: [] });
    h.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM employees') && sql.includes('sigur_employee_id IS NOT NULL') && sql.includes('LIMIT')) return [];
      if (sql.includes('sigur_employee_id IS NULL')) {
        return [{
          id: 2568, full_name: NAME, last_name: 'Шарипов', first_name: 'Исмоилджон', middle_name: 'Нуруллоевич',
          org_department_id: BRIGADE_LOCAL, position_id: 'position-1', tab_number: '05919',
          department_locked: false, name_locked: false,
        }];
      }
      if (sql.includes('FROM org_departments') && sql.includes('sigur_department_id IS NOT NULL')) {
        return [
          { id: ARCHIVE_LOCAL, sigur_department_id: ARCHIVE_SIGUR, name: 'Уволенные', is_active: true },
          { id: BRIGADE_LOCAL, sigur_department_id: BRIGADE_SIGUR, name: 'бр.Прозорова А.В.', is_active: true },
        ];
      }
      if (sql.includes('parent_id') && sql.includes('org_departments')) {
        return [{ id: ARCHIVE_LOCAL, parent_id: null }, { id: BRIGADE_LOCAL, parent_id: null }];
      }
      if (sql.includes('FROM positions')) return [{ id: 'position-1', sigur_position_id: 501, name: 'Маляр' }];
      return [];
    });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR, null)]);

    await syncEmployeesLogic();

    const tabUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('tab_number'));
    expect(tabUpdates).toHaveLength(0);
    // Привязка к существующей портальной записи всё равно произошла.
    expect(h.execute.mock.calls.some(([sql]) => String(sql).includes('sigur_employee_id'))).toBe(true);
  });

  it('пустой tabId из Sigur не затирает табельный номер', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([card(NEW_SIGUR, BRIGADE_SIGUR, null)]);

    await syncEmployeesLogic();

    const tabUpdates = h.execute.mock.calls.filter(([sql]) => String(sql).includes('tab_number'));
    expect(tabUpdates).toHaveLength(0);
  });

  it('обычный новый сотрудник без пары: вставка как раньше', async () => {
    setupQueries({ employees: [employee({ sigur_employee_id: NEW_SIGUR })] });
    h.getEmployeesCached.mockResolvedValue([
      card(NEW_SIGUR, BRIGADE_SIGUR),
      { id: 777, name: 'Иванов Иван Иванович', departmentId: BRIGADE_SIGUR, positionId: 501, position: 'Маляр', tabId: '1' },
    ]);

    const result = await syncEmployeesLogic();

    expect(result.rebinded).toBe(0);
    expect(insertCalls()).toHaveLength(1);
  });
});
