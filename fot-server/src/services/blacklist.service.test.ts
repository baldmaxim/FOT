import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Чёрный список (миграция 273): нормализация ключей, сила совпадения,
 * идемпотентность добавления и снятия, состояние учётной записи.
 *
 * Здесь проверяется логика на моках БД. Гарантии, которые даёт сама СУБД
 * (функция norm_person_name, частичные unique-индексы, CHECK, SKIP LOCKED),
 * на моках непроверяемы — под них отдельный integration-набор.
 */
const h = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('../config/postgres.js', () => ({
  query: h.query,
  queryOne: h.queryOne,
  execute: h.execute,
  withTransaction: h.withTransaction,
}));

const {
  normalizeSnilsForMatch,
  normalizeEmailForMatch,
  normalizePassportForMatch,
  normalizeNameForMatch,
  findActive,
  assertNotBlacklisted,
  BlacklistBlockedError,
  addEntryIn,
  removeEntryIn,
  insertTargetsIn,
  applyAccountLock,
  resolveAffectedProfiles,
} = await import('./blacklist.service.js');

const entry = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  full_name: 'Иванов Иван Иванович',
  birth_date: null,
  snils: null,
  email: null,
  passport_series_number: null,
  employee_id: null,
  user_profile_id: null,
  reason: 'нарушение',
  created_by_name: 'Гладкая Наталья Васильевна',
  created_at: '2026-09-10T00:00:00.000Z',
  match_reason: 'employee_id',
  ...over,
});

const fakeClient = () => ({ query: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('нормализация ключей', () => {
  it('СНИЛС принимает маску и отбрасывает неполные', () => {
    expect(normalizeSnilsForMatch('123-456-789 00')).toBe('12345678900');
    expect(normalizeSnilsForMatch('1234567890')).toBeNull();
  });

  it('СНИЛС из 12 цифр не превращается в чужой 11-значный', () => {
    // normalizeDigits(v, 11) обрезал бы через slice — здесь такой ввод отвергается.
    expect(normalizeSnilsForMatch('123456789001')).toBeNull();
  });

  it('email сравнивается без регистра и пробелов', () => {
    expect(normalizeEmailForMatch(' Ivan@X.RU ')).toBe('ivan@x.ru');
    expect(normalizeEmailForMatch('')).toBeNull();
  });

  it('паспорт теряет разделители и регистр', () => {
    expect(normalizePassportForMatch('45 08 № 123456')).toBe('4508123456');
  });

  it('ФИО: ё и е совпадают, лишние пробелы сжимаются', () => {
    expect(normalizeNameForMatch('Королёв  Пётр')).toBe(normalizeNameForMatch('королев петр'));
  });

  it('ФИО сохраняет пунктуацию — как в каноне БД', () => {
    // Расхождение с norm_person_name означало бы, что гейт не находит человека.
    expect(normalizeNameForMatch('Иванов, Иван')).toBe('иванов, иван');
  });
});

describe('findActive: сила совпадения', () => {
  it('совпадение по СНИЛС — strong', async () => {
    h.query.mockResolvedValueOnce([entry({ match_reason: 'snils' })]);
    const res = await findActive({ snils: '123-456-789 00' });
    expect(res.strong).toHaveLength(1);
    expect(res.weak).toHaveLength(0);
  });

  it('совпадение только по ФИО — weak, запрета не даёт', async () => {
    h.query.mockResolvedValueOnce([entry({ match_reason: 'name' })]);
    const res = await findActive({ fullName: 'Иванов Иван Иванович' });
    expect(res.strong).toHaveLength(0);
    expect(res.weak).toHaveLength(1);
  });

  it('без ключей в БД не ходит', async () => {
    const res = await findActive({});
    expect(h.query).not.toHaveBeenCalled();
    expect(res.strong).toHaveLength(0);
  });

  it('assertNotBlacklisted в strict бросает на strong', async () => {
    h.query.mockResolvedValueOnce([entry({ match_reason: 'passport' })]);
    await expect(assertNotBlacklisted({ passport: '4508123456' })).rejects.toBeInstanceOf(BlacklistBlockedError);
  });

  it('assertNotBlacklisted в strict пропускает weak', async () => {
    h.query.mockResolvedValueOnce([entry({ match_reason: 'name' })]);
    await expect(assertNotBlacklisted({ fullName: 'Иванов Иван' })).resolves.toBeTruthy();
  });

  it('в warn не бросает даже на strong', async () => {
    h.query.mockResolvedValueOnce([entry({ match_reason: 'snils' })]);
    const res = await assertNotBlacklisted({ snils: '12345678900' }, { mode: 'warn' });
    expect(res.strong).toHaveLength(1);
  });
});

describe('идемпотентность добавления', () => {
  const input = {
    fullName: 'Иванов Иван Иванович',
    reason: 'нарушение',
    employeeId: 42,
    source: 'person_pick' as const,
    createdBy: '22222222-2222-2222-2222-222222222222',
    createdByName: 'Админ',
  };

  it('активная запись уже есть → created=false и INSERT не выполняется', async () => {
    const client = fakeClient();
    // advisory-лок, затем поиск существующей записи
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [entry({ employee_id: 42 })] });

    const res = await addEntryIn(client as never, input);

    expect(res.created).toBe(false);
    const insertCalls = client.query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO public.person_blacklist'));
    expect(insertCalls).toHaveLength(0);
  });

  it('берёт advisory-лок до записи', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [] });
    client.query.mockResolvedValueOnce({ rows: [entry()] });

    await addEntryIn(client as never, input);

    expect(String(client.query.mock.calls[0][0])).toContain('pg_advisory_xact_lock');
  });

  it('гонка вне лока (23505) отдаёт существующую запись, а не падает', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [] });          // lock
    client.query.mockResolvedValueOnce({ rows: [] });          // поиск: пусто
    client.query.mockRejectedValueOnce({ code: '23505' });     // INSERT: конфликт
    client.query.mockResolvedValueOnce({ rows: [entry()] });   // повторный поиск

    const res = await addEntryIn(client as never, input);
    expect(res.created).toBe(false);
  });

  it('цели пишутся с ON CONFLICT DO NOTHING', async () => {
    const client = fakeClient();
    client.query.mockResolvedValue({ rowCount: 1 });
    await insertTargetsIn(client as never, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [{
      kind: 'employee', employee_id: 42, pass_id: null, sigur_employee_id: 777,
      match_reason: 'employee_id', label: 'Иванов', org_name: null, pass_number: null,
    }]);
    expect(String(client.query.mock.calls[0][0])).toContain('ON CONFLICT (blacklist_id, sigur_employee_id) DO NOTHING');
  });
});

describe('снятие', () => {
  it('повторное снятие ничего не меняет: changed=false', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [] });                  // UPDATE не задел строк
    client.query.mockResolvedValueOnce({ rows: [entry({ removed_at: 'x' })] });

    const res = await removeEntryIn(client as never, 'id-1', { id: 'u1', name: 'Админ' }, 'ошибка');
    expect(res.changed).toBe(false);
  });

  it('снятие отменяет незапущенные цели, чтобы воркер не заблокировал позже', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [entry()] });   // UPDATE записи
    client.query.mockResolvedValueOnce({ rowCount: 2 });       // отмена pending

    const res = await removeEntryIn(client as never, 'id-1', { id: 'u1', name: 'Админ' }, 'ошибка');

    expect(res.changed).toBe(true);
    const sql = String(client.query.mock.calls[1][0]);
    expect(sql).toContain("state = 'skipped'");
    expect(sql).toContain("state = 'pending'");
  });
});

describe('состояние учётной записи', () => {
  it('is_disabled вычисляется через EXISTS, а не выставляется вручную', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'p1', was: false, now: true }] });
    client.query.mockResolvedValueOnce({ rowCount: 1 });

    const transitions = await applyAccountLock(client as never, ['p1']);

    expect(String(client.query.mock.calls[0][0])).toContain('EXISTS');
    expect(transitions).toEqual([{ userProfileId: 'p1', was: false, now: true }]);
  });

  it('token_version растёт только при реальном переходе состояния', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'p1', was: true, now: true }] });

    await applyAccountLock(client as never, ['p1']);

    const bumped = client.query.mock.calls.some(c => String(c[0]).includes('token_version + 1'));
    expect(bumped).toBe(false);
  });

  it('переход true→false тоже рвёт сессию', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'p1', was: true, now: false }] });
    client.query.mockResolvedValueOnce({ rowCount: 1 });

    await applyAccountLock(client as never, ['p1']);

    const bumped = client.query.mock.calls.some(c => String(c[0]).includes('token_version + 1'));
    expect(bumped).toBe(true);
  });

  it('пустой список профилей не трогает БД', async () => {
    const client = fakeClient();
    const res = await applyAccountLock(client as never, []);
    expect(res).toEqual([]);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('находит все затронутые учётки: и по email, и по карточке', async () => {
    const client = fakeClient();
    client.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }, { id: 'p2' }] });

    const ids = await resolveAffectedProfiles(client as never, {
      emailLower: 'ivan@x.ru',
      employeeId: 42,
      userProfileId: null,
    });

    expect(ids).toEqual(['p1', 'p2']);
  });
});
