import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  expandTimekeeperAccessibleDepartmentIds,
  isTimekeeper,
  LI_OBSHESTROY_DEPARTMENT_ID,
  listTimekeeperAccessibleDepartmentIds,
  listTimekeeperDepartmentSeeds,
  listTimekeeperDirectEmployeeIds,
  loadTimekeeperScopeSnapshot,
  resolveTimekeeperDepartmentSeeds,
  resolveTimekeeperDirectEmployeeIds,
  resolveTimekeeperEditableLiIds,
  resolveTimekeeperLiObshestroyPresenceIds,
  resolveTimekeeperObjectIds,
  resetTimekeeperScopeCache,
  invalidateTimekeeperScopeCache,
  timekeeperScopeCacheStats,
  TIMEKEEPER_PRESENCE_WINDOW_DAYS,
} from './timekeeper-scope.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

function buildReq(roleCode = 'timekeeper', id = 'tk-1'): AuthenticatedRequest {
  return {
    user: {
      id,
      email: 't@e.com',
      system_role_id: 'role-tk',
      role_code: roleCode,
      is_admin: false,
      employee_variant: null,
      show_actual_hours: true,
      employee_id: null,
      department_id: null,
      is_approved: true,
      two_factor_enabled: false,
      two_factor_verified: true,
    },
  } as unknown as AuthenticatedRequest;
}

/** Строки объединённого statement'а: kind = 'seed' | 'direct'. */
function scopeRows(seeds: string[], direct: Array<string | null>) {
  return [
    ...seeds.map(val => ({ kind: 'seed', val })),
    ...direct.map(val => ({ kind: 'direct', val })),
  ];
}

beforeEach(() => {
  pgQuery.mockReset();
  // Кэш скоупа модульный: без сброса тесты стали бы зависеть от порядка.
  resetTimekeeperScopeCache();
  vi.useRealTimers();
});

describe('isTimekeeper', () => {
  it('true только для role_code timekeeper', () => {
    expect(isTimekeeper(buildReq('timekeeper'))).toBe(true);
    expect(isTimekeeper(buildReq('manager_obj'))).toBe(false);
    expect(isTimekeeper(buildReq('admin'))).toBe(false);
  });
});

describe('loadTimekeeperScopeSnapshot', () => {
  it('оба множества — из ОДНОГО обращения к БД', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A', 'br-B'], ['5', '7']));
    const snapshot = await loadTimekeeperScopeSnapshot('tk-1');
    expect(snapshot.departmentSeeds).toEqual(['br-A', 'br-B']);
    expect(snapshot.directEmployeeIds).toEqual([5, 7]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('дедуплицирует обе стороны и приводит id сотрудников к числам', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A', 'br-B', 'br-A'], ['10', '20', '10']));
    const snapshot = await loadTimekeeperScopeSnapshot('tk-1');
    expect(snapshot.departmentSeeds).toEqual(['br-A', 'br-B']);
    expect(snapshot.directEmployeeIds).toEqual([10, 20]);
  });

  it('параметры: пользователь и ЛИНИЯ-Общестрой', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [, params] = pgQuery.mock.calls[0];
    expect(params).toEqual(['tk-1', LI_OBSHESTROY_DEPARTMENT_ID]);
  });

  it('события сканируются один раз: MATERIALIZED и единственное вхождение skud_events', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    expect(sql).toContain('points AS MATERIALIZED');
    expect(sql).toContain('event_emp AS MATERIALIZED');
    expect(sql).toContain('present AS MATERIALIZED');
    // Скан событий ровно один — иначе вернулись к исходной проблеме.
    expect(sql.match(/FROM skud_events/g)?.length).toBe(1);
  });

  it('три источника сотрудников сохранены, окно присутствия не изменено', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    expect(sql).toContain('employee_skud_object_access'); // ручная привязка
    expect(sql).toContain('employee_object_assignment'); // явное назначение
    expect(sql).toContain('skud_object_access_points'); // проходы
    expect(sql).toContain(`INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days'`);
  });

  it('seeds считаются от present (без явных назначений), direct — с ними', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    // present = проходы ∪ ручная привязка; assigned_emp подмешивается только в direct
    expect(sql).toContain('SELECT employee_id FROM event_emp');
    expect(sql).toContain('SELECT employee_id FROM manual_emp');
    expect(sql).toContain('SELECT employee_id FROM assigned_emp');
    expect(sql).toContain('JOIN employee_department_access eda');
    expect(sql).toContain('ON eda.employee_id = p.employee_id');
  });

  it('BTRIM сохранён с обеих сторон', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    expect(sql).toContain('BTRIM(sap.access_point_name)');
    expect(sql).toContain('BTRIM(se.access_point)');
  });

  it('гард «папки не выбраны → seeds пусто» сохранён и не задевает direct', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    expect(sql).toContain('timekeeper_folder_access');
    expect(sql).toContain("COALESCE(array_agg(department_id), '{}'::uuid[])");
    expect(sql).toContain('get_descendant_department_ids');
    // folder_desc ограничивает только seeds
    expect(sql).toContain('eda.department_id IN (SELECT id FROM folder_desc)');
    // ...и не встречается в ветке direct
    expect(sql).not.toContain('direct AS (\n       SELECT employee_id FROM folder_desc');
  });

  it('предикат допустимых отделов перенесён дословно: у brigade НЕТ проверки is_active', async () => {
    pgQuery.mockResolvedValueOnce([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    const [sql] = pgQuery.mock.calls[0];
    expect(sql).toContain("d.kind = 'brigade'");
    expect(sql).toContain("d.kind = 'department'");
    expect(sql).toContain('d.is_active = true');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('c.parent_id = d.id');
    expect(sql).toContain('d.id <> $2::uuid'); // ЛИНИЯ-Общестрой исключена
    // is_active стоит ТОЛЬКО в ветке department: между 'brigade' и 'department'
    // не должно быть проверки активности, иначе состав видимых бригад изменится.
    const brigadeIdx = sql.indexOf("d.kind = 'brigade'");
    const departmentIdx = sql.indexOf("d.kind = 'department'");
    expect(sql.slice(brigadeIdx, departmentIdx)).not.toContain('is_active');
  });

  it('NULL employee_id даёт 0 — как в прежней реализации (эквивалентность, не улучшение)', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows([], ['5', null]));
    const snapshot = await loadTimekeeperScopeSnapshot('tk-1');
    expect(snapshot.directEmployeeIds).toEqual([5, 0]);
  });
});

describe('listTimekeeperDepartmentSeeds / listTimekeeperDirectEmployeeIds (обёртки)', () => {
  it('seeds берутся из снапшота', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    expect(await listTimekeeperDepartmentSeeds('tk-1')).toEqual(['br-A']);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('direct берутся из снапшота', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['10', '20']));
    expect(await listTimekeeperDirectEmployeeIds('tk-1')).toEqual([10, 20]);
  });

  it('только direct-строки → seeds пусто', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows([], ['5']));
    expect(await listTimekeeperDepartmentSeeds('tk-1')).toEqual([]);
  });

  // Раньше здесь проверялось ОТСУТСТВИЕ межзапросного кэша. 13.08, когда табельщицы
  // перестали работать, кэш был согласован осознанно: запрос стоил 12.7 с и давал 41%
  // нагрузки БД. Теперь фиксируем обратное — вызовы обслуживаются из кэша.
  it('последовательные вызовы обслуживаются кэшем, а не идут в БД', async () => {
    pgQuery.mockResolvedValue(scopeRows(['br-A'], ['5']));
    await listTimekeeperDepartmentSeeds('tk-1');
    await listTimekeeperDepartmentSeeds('tk-1');
    await listTimekeeperDirectEmployeeIds('tk-1');
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});

describe('expandTimekeeperAccessibleDepartmentIds', () => {
  it('пустые seeds → пусто, БЕЗ ЛИНИЯ-Общестрой и без запроса', async () => {
    const ids = await expandTimekeeperAccessibleDepartmentIds([]);
    expect(ids).toEqual([]);
    expect(ids).not.toContain(LI_OBSHESTROY_DEPARTMENT_ID);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  it('seeds + поддерево + ЛИНИЯ-Общестрой, без дублей', async () => {
    pgQuery.mockResolvedValueOnce([{ id: 'br-A' }, { id: 'child-1' }]);
    const ids = await expandTimekeeperAccessibleDepartmentIds(['br-A']);
    expect(ids).toEqual(['br-A', 'child-1', LI_OBSHESTROY_DEPARTMENT_ID]);
  });

  it('listTimekeeperAccessibleDepartmentIds = снапшот + расширение', async () => {
    pgQuery
      .mockResolvedValueOnce(scopeRows(['br-A'], ['5'])) // снапшот
      .mockResolvedValueOnce([{ id: 'br-A' }, { id: 'child-1' }]); // поддерево
    const ids = await listTimekeeperAccessibleDepartmentIds('tk-1');
    expect(ids).toEqual(['br-A', 'child-1', LI_OBSHESTROY_DEPARTMENT_ID]);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });
});

describe('resolveTimekeeperObjectIds', () => {
  it('уникальные skud_object_id', async () => {
    pgQuery.mockResolvedValue([{ skud_object_id: 'o1' }, { skud_object_id: 'o1' }, { skud_object_id: 'o2' }]);
    expect(await resolveTimekeeperObjectIds('tk-1')).toEqual(['o1', 'o2']);
  });
});

describe('req-снимок: оба resolve-метода делят одно обращение к БД', () => {
  it('seeds: второй вызов не дёргает БД', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    const req = buildReq();
    expect(await resolveTimekeeperDepartmentSeeds(req)).toEqual(['br-A']);
    expect(await resolveTimekeeperDepartmentSeeds(req)).toEqual(['br-A']);
    expect(req.user.__timekeeper_dept_seeds).toEqual(['br-A']);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('direct: возвращает Set и кэширует', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5', '7']));
    const req = buildReq();
    const set = await resolveTimekeeperDirectEmployeeIds(req);
    expect([...set]).toEqual([5, 7]);
    await resolveTimekeeperDirectEmployeeIds(req);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('seeds + direct в одном запросе = ОДИН поход в БД, а не два', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    const req = buildReq();
    const seeds = await resolveTimekeeperDepartmentSeeds(req);
    const direct = await resolveTimekeeperDirectEmployeeIds(req);
    expect(seeds).toEqual(['br-A']);
    expect([...direct]).toEqual([5]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(req.user.__timekeeper_scope_snapshot).toEqual({
      departmentSeeds: ['br-A'],
      directEmployeeIds: [5],
    });
  });

  it('обратный порядок вызовов даёт тот же один запрос', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    const req = buildReq();
    await resolveTimekeeperDirectEmployeeIds(req);
    await resolveTimekeeperDepartmentSeeds(req);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('разные req одного пользователя делят модульный кэш', async () => {
    pgQuery.mockResolvedValue(scopeRows(['br-A'], ['5']));
    await resolveTimekeeperDepartmentSeeds(buildReq());
    await resolveTimekeeperDepartmentSeeds(buildReq());
    // req-кэш у каждого свой, но снимок берётся из общего кэша скоупа.
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('разные пользователи не делят снимок', async () => {
    pgQuery.mockResolvedValue(scopeRows(['br-A'], ['5']));
    await resolveTimekeeperDepartmentSeeds(buildReq('timekeeper', 'tk-1'));
    await resolveTimekeeperDepartmentSeeds(buildReq('timekeeper', 'tk-2'));
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });
});

describe('resolveTimekeeperLiObshestroyPresenceIds', () => {
  it('одним запросом: ЛИНИЯ-Общестрой, присутствие за ПЕРИОД (не 90 дней)', async () => {
    pgQuery.mockResolvedValueOnce([{ id: 7 }, { id: 9 }]);
    const req = buildReq();
    const set = await resolveTimekeeperLiObshestroyPresenceIds(req, '2026-06-16', '2026-06-30');
    expect([...set]).toEqual([7, 9]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = pgQuery.mock.calls[0];
    expect(sql).toContain('org_department_id');
    expect(sql).toContain('employee_object_assignment');
    expect(sql).toContain('employee_skud_object_access');
    expect(sql).toContain('skud_events');
    // Охват присутствия — по периоду, а не по 90-дневному окну.
    expect(sql).toContain('se.event_date >= $3::date');
    expect(sql).toContain('se.event_date <= $4::date');
    expect(sql).not.toContain(`INTERVAL '${TIMEKEEPER_PRESENCE_WINDOW_DAYS} days'`);
    expect(params[0]).toBe('tk-1');
    expect(params[1]).toBe('0b24809e-5f04-45e1-bbe2-8a82990d6bdd');
    expect(params[2]).toBe('2026-06-16');
    expect(params[3]).toBe('2026-06-30');
  });

  it('пусто, если запрос ничего не вернул', async () => {
    pgQuery.mockResolvedValueOnce([]);
    const set = await resolveTimekeeperLiObshestroyPresenceIds(buildReq(), '2026-06-01', '2026-06-15');
    expect([...set]).toEqual([]);
  });
});

describe('resolveTimekeeperEditableLiIds (гейт правки, 90д ∩ ЛИНИЯ-Общестрой, кэш)', () => {
  it('direct-сотрудники ∩ ЛИНИЯ-Общестрой; кэширует на req', async () => {
    pgQuery
      .mockResolvedValueOnce(scopeRows([], ['5', '7', '9'])) // снапшот: direct
      .mockResolvedValueOnce([{ id: 7 }]); // только 7 в ЛИНИЯ-Общестрой
    const req = buildReq();
    const set = await resolveTimekeeperEditableLiIds(req);
    expect([...set]).toEqual([7]);
    const [sql, params] = pgQuery.mock.calls[1];
    expect(sql).toContain('org_department_id');
    expect(params[0]).toEqual([5, 7, 9]);
    expect(params[1]).toBe('0b24809e-5f04-45e1-bbe2-8a82990d6bdd');
    // Второй вызов — из кэша, без новых запросов.
    await resolveTimekeeperEditableLiIds(req);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });

  it('пусто без direct-сотрудников (второй запрос не идёт)', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], [])); // снапшот: direct пусто
    const set = await resolveTimekeeperEditableLiIds(buildReq());
    expect([...set]).toEqual([]);
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });
});

describe('кэш скоупа: SOFT 45 с / HARD 60 с от старта SQL', () => {
  it('повторный вызов в пределах SOFT не идёт в БД', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    await loadTimekeeperScopeSnapshot('tk-1');
    await loadTimekeeperScopeSnapshot('tk-1');
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(timekeeperScopeCacheStats).toMatchObject({ miss: 1, hit: 1 });
  });

  it('ПУСТОЙ результат кэшируется наравне с непустым', async () => {
    pgQuery.mockResolvedValueOnce([]);
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual([]);
    await loadTimekeeperScopeSnapshot('tk-1');
    expect(pgQuery).toHaveBeenCalledTimes(1);
  });

  it('возраст считается от СТАРТА SQL, а не от завершения', async () => {
    vi.useFakeTimers();
    // Запрос длится 12.7 с — как на проде.
    pgQuery.mockImplementationOnce(async () => {
      await vi.advanceTimersByTimeAsync(12_700);
      return scopeRows(['br-A'], ['5']);
    });
    const first = loadTimekeeperScopeSnapshot('tk-1');
    await vi.advanceTimersByTimeAsync(12_700);
    await first;

    // Ещё 33 с: от старта прошло 45.7 с — SOFT истёк.
    await vi.advanceTimersByTimeAsync(33_000);
    pgQuery.mockResolvedValueOnce(scopeRows(['br-B'], ['7']));
    await loadTimekeeperScopeSnapshot('tk-1');
    // Отсчёт от завершения дал бы «ещё свежо», и обновления не случилось бы.
    expect(timekeeperScopeCacheStats.staleHit).toBe(1);
  });

  it('после SOFT отдаёт устаревшее НЕМЕДЛЕННО и обновляет в фоне', async () => {
    vi.useFakeTimers();
    pgQuery.mockResolvedValueOnce(scopeRows(['old'], ['1']));
    await loadTimekeeperScopeSnapshot('tk-1');

    await vi.advanceTimersByTimeAsync(50_000); // SOFT прошёл, HARD нет
    pgQuery.mockResolvedValueOnce(scopeRows(['new'], ['2']));
    const stale = await loadTimekeeperScopeSnapshot('tk-1');
    expect(stale.departmentSeeds).toEqual(['old']); // ждать не заставили
    expect(timekeeperScopeCacheStats.backgroundRefresh).toBe(1);

    await vi.advanceTimersByTimeAsync(0);
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['new']);
  });

  it('после HARD ждёт свежий результат', async () => {
    vi.useFakeTimers();
    pgQuery.mockResolvedValueOnce(scopeRows(['old'], ['1']));
    await loadTimekeeperScopeSnapshot('tk-1');

    await vi.advanceTimersByTimeAsync(61_000);
    pgQuery.mockResolvedValueOnce(scopeRows(['new'], ['2']));
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['new']);
  });

  it('параллельные вызовы схлопываются в один запрос', async () => {
    let release: (value: unknown) => void = () => undefined;
    pgQuery.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const a = loadTimekeeperScopeSnapshot('tk-1');
    const b = loadTimekeeperScopeSnapshot('tk-1');
    release(scopeRows(['br-A'], ['5']));
    expect((await a).departmentSeeds).toEqual(['br-A']);
    expect((await b).departmentSeeds).toEqual(['br-A']);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(timekeeperScopeCacheStats.coalesced).toBe(1);
  });

  it('ошибка не залипает: следующий вызов снова идёт в БД', async () => {
    pgQuery.mockRejectedValueOnce(new Error('boom'));
    await expect(loadTimekeeperScopeSnapshot('tk-1')).rejects.toThrow('boom');
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['br-A']);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });

  it('снимок заморожен, а обёртки отдают копию', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['br-A'], ['5']));
    const snapshot = await loadTimekeeperScopeSnapshot('tk-1');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.departmentSeeds)).toBe(true);

    const seeds = await listTimekeeperDepartmentSeeds('tk-1');
    seeds.push('чужое');
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['br-A']);
  });
});

describe('инвалидация кэша скоупа', () => {
  it('точечный сброс по userId не трогает чужой кэш', async () => {
    pgQuery.mockResolvedValueOnce(scopeRows(['a'], ['1']));
    await loadTimekeeperScopeSnapshot('tk-1');
    pgQuery.mockResolvedValueOnce(scopeRows(['b'], ['2']));
    await loadTimekeeperScopeSnapshot('tk-2');
    expect(pgQuery).toHaveBeenCalledTimes(2);

    invalidateTimekeeperScopeCache('tk-1');
    pgQuery.mockResolvedValueOnce(scopeRows(['a2'], ['1']));
    await loadTimekeeperScopeSnapshot('tk-1'); // ушёл в БД
    await loadTimekeeperScopeSnapshot('tk-2'); // остался в кэше
    expect(pgQuery).toHaveBeenCalledTimes(3);
  });

  it('полный сброс очищает всех', async () => {
    pgQuery.mockResolvedValue(scopeRows(['a'], ['1']));
    await loadTimekeeperScopeSnapshot('tk-1');
    await loadTimekeeperScopeSnapshot('tk-2');
    invalidateTimekeeperScopeCache();
    await loadTimekeeperScopeSnapshot('tk-1');
    await loadTimekeeperScopeSnapshot('tk-2');
    expect(pgQuery).toHaveBeenCalledTimes(4);
  });

  it('ГОНКА: инвалидация во время полёта не даёт записать устаревший результат', async () => {
    let release: (value: unknown) => void = () => undefined;
    pgQuery.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const inflight = loadTimekeeperScopeSnapshot('tk-1');

    invalidateTimekeeperScopeCache('tk-1'); // доступ отозвали, пока запрос летел
    release(scopeRows(['устаревшее'], ['1']));
    await inflight;

    pgQuery.mockResolvedValueOnce(scopeRows(['актуальное'], ['2']));
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['актуальное']);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });

  it('ГОНКА: завершение старого полёта не удаляет запись нового', async () => {
    let releaseOld: (value: unknown) => void = () => undefined;
    let releaseNew: (value: unknown) => void = () => undefined;
    pgQuery
      .mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve; }));

    const oldFlight = loadTimekeeperScopeSnapshot('tk-1');
    invalidateTimekeeperScopeCache('tk-1');
    const newFlight = loadTimekeeperScopeSnapshot('tk-1'); // стартовал второй полёт

    releaseOld(scopeRows(['старое'], ['1']));
    await oldFlight;
    releaseNew(scopeRows(['новое'], ['2']));
    await newFlight;

    // Новый результат сохранён — третий запрос не нужен.
    expect((await loadTimekeeperScopeSnapshot('tk-1')).departmentSeeds).toEqual(['новое']);
    expect(pgQuery).toHaveBeenCalledTimes(2);
  });
});
