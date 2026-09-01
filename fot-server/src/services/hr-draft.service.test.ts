/**
 * Черновик мастера в упрощённой схеме: сотрудника создаёт существующий
 * POST /api/employees, черновик только помнит employee_id и прикрепляет сканы.
 * Проверяем: идемпотентность attach, сохранение состояния при сбое (чтобы повтор
 * прикреплял, а не создавал заново) и запрет привязки к другому сотруднику.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.HR_FIELD_ENCRYPTION_KEYS ||= `v1:${'a'.repeat(64)}`;
  process.env.HR_FIELD_ENCRYPTION_ACTIVE_KEY_VERSION ||= 'v1';
  process.env.HR_FIELD_HASH_PEPPER ||= 'pepper-pepper-pepper-pepper-pepper-32';
});

const state = vi.hoisted(() => ({
  drafts: new Map<string, Record<string, unknown>>(),
  employees: new Set<number>(),
  attachCalls: 0,
  attachedDocsPerDraft: new Map<string, number>(),
  profilesCreated: [] as number[],
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  failAttach: false,
}));

const fakeClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return [];
  }),
  queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM employee_hr_drafts WHERE id = $1')) return state.drafts.get(String(params[0])) ?? null;
    if (s.includes('SELECT id FROM employees WHERE id = $1')) {
      const id = Number(params[0]);
      return state.employees.has(id) ? { id } : null;
    }
    return null;
  }),
  execute: vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.startsWith('UPDATE employee_hr_drafts')) {
      const row = state.drafts.get(String(params[0]));
      if (row) {
        if (s.includes("state = CASE WHEN state = 'attached'")) {
          row.employee_id = params[1];
          if (row.state !== 'attached') row.state = 'employee_created_pending_attach';
        } else if (s.includes("state = 'employee_created_pending_attach', attach_error = $3")) {
          row.employee_id = params[1];
          row.state = 'employee_created_pending_attach';
          row.attach_error = params[2];
        }
      }
      return 1;
    }
    return 1;
  }),
  withTransaction: vi.fn(async (fn: (c: typeof fakeClient) => Promise<unknown>) => {
    if (state.failAttach) throw new Error('БД недоступна');
    return fn(fakeClient);
  }),
}));

vi.mock('./hr-profile.service.js', () => ({
  createProfile: vi.fn(async (employeeId: number) => { state.profilesCreated.push(employeeId); }),
  applyProfilePatch: vi.fn(async () => ({ changedFields: ['inn'], zupReset: false })),
  listCitizenships: vi.fn(async () => []),
  loadProfileRow: vi.fn(async () => null),
  recordHistory: vi.fn(async () => undefined),
  rowToPlainFields: vi.fn(() => ({})),
}));
vi.mock('./hr-documents.service.js', () => ({
  attachDraftDocumentsToEmployee: vi.fn(async (_c: unknown, draftId: string) => {
    state.attachCalls += 1;
    // Идемпотентность: документы «перевешиваются» один раз, повтор ничего не добавляет.
    if (!state.attachedDocsPerDraft.has(draftId)) state.attachedDocsPerDraft.set(draftId, 2);
    return [];
  }),
  listDraftHrDocumentRows: vi.fn(async () => []),
  listEmployeeHrDocumentRows: vi.fn(async () => []),
  loadHrDocument: vi.fn(async () => null),
  readRecognitionResult: vi.fn(() => null),
  toPublic: vi.fn(),
}));
vi.mock('./hr-ocr/apply-employee.js', () => ({ applyOcrToEmployee: vi.fn() }));

import { attachDraftToEmployee, listMyOpenDrafts, markEmployeeCreated, HrDraftError } from './hr-draft.service.js';
import { encryptJson } from './hr-crypto.service.js';

const makeDraft = (id: string): void => {
  const { enc } = encryptJson({ full_name: 'Иванов Иван', profile: { inn: '770123456789' } });
  state.drafts.set(id, {
    id, created_by: 'u1', state: 'draft', payload_enc: enc,
    employee_id: null, attach_error: null,
    expires_at: new Date(Date.now() + 3600e3).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
};

beforeEach(() => {
  state.drafts.clear();
  state.employees.clear();
  state.employees.add(5001);
  state.employees.add(6002);
  state.attachCalls = 0;
  state.attachedDocsPerDraft.clear();
  state.profilesCreated = [];
  state.queries = [];
  state.failAttach = false;
});

describe('markEmployeeCreated', () => {
  it('фиксирует employee_id и состояние до прикрепления', async () => {
    makeDraft('d1');
    await markEmployeeCreated('d1', 5001, { userId: 'u1' });
    expect(state.drafts.get('d1')).toMatchObject({ employee_id: 5001, state: 'employee_created_pending_attach' });
  });

  it('чужой черновик → 403', async () => {
    makeDraft('d2');
    await expect(markEmployeeCreated('d2', 5001, { userId: 'other' })).rejects.toMatchObject({ status: 403 });
  });

  it('привязка к другому сотруднику запрещена', async () => {
    makeDraft('d3');
    await markEmployeeCreated('d3', 5001, { userId: 'u1' });
    await expect(markEmployeeCreated('d3', 6002, { userId: 'u1' })).rejects.toMatchObject({ status: 409, code: 'already_linked' });
  });
});

describe('attachDraftToEmployee', () => {
  it('прикрепляет профиль и документы, помечает черновик attached', async () => {
    makeDraft('d4');
    const res = await attachDraftToEmployee('d4', 5001, { userId: 'u1' });
    expect(res.autoFilled).toContain('inn');
    expect(state.profilesCreated).toEqual([5001]);
    expect(state.attachedDocsPerDraft.get('d4')).toBe(2);
  });

  it('идемпотентен: повтор не дублирует документы и не плодит профиль сверх upsert', async () => {
    makeDraft('d5');
    await attachDraftToEmployee('d5', 5001, { userId: 'u1' });
    await attachDraftToEmployee('d5', 5001, { userId: 'u1' });
    expect(state.attachCalls).toBe(2);
    expect(state.attachedDocsPerDraft.get('d5')).toBe(2); // документы перевешены один раз
  });

  it('сбой прикрепления сохраняет employee_id и причину — повтор не создаёт сотрудника заново', async () => {
    makeDraft('d6');
    state.failAttach = true;
    await expect(attachDraftToEmployee('d6', 5001, { userId: 'u1' })).rejects.toThrow('БД недоступна');
    expect(state.drafts.get('d6')).toMatchObject({
      employee_id: 5001,
      state: 'employee_created_pending_attach',
    });
    expect(String(state.drafts.get('d6')?.attach_error)).toContain('БД недоступна');

    state.failAttach = false;
    const res = await attachDraftToEmployee('d6', 5001, { userId: 'u1' });
    expect(res.autoFilled).toContain('inn');
  });

  it('attach на другого сотрудника при уже привязанном → 409', async () => {
    makeDraft('d7');
    await markEmployeeCreated('d7', 5001, { userId: 'u1' });
    await expect(attachDraftToEmployee('d7', 6002, { userId: 'u1' })).rejects.toBeInstanceOf(HrDraftError);
  });

  it('несуществующий сотрудник → 404', async () => {
    makeDraft('d8');
    await expect(attachDraftToEmployee('d8', 9999, { userId: 'u1' })).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * Фундамент восстановления в мастере: при открытии он спрашивает свои незавершённые
 * анкеты и по состоянию решает, продолжать прикрепление или начинать заново.
 * Проверяем сам запрос, а не мок: важно, что выборка ограничена автором и ровно
 * двумя открытыми состояниями — иначе мастер предложит «продолжить» уже закрытую
 * анкету либо не увидит созданного сотрудника и заведёт дубль.
 */
describe('listMyOpenDrafts', () => {
  it('фильтрует по автору и только по открытым состояниям', async () => {
    await listMyOpenDrafts('u1');

    expect(state.queries).toHaveLength(1);
    const { sql, params } = state.queries[0];
    expect(sql).toContain('FROM employee_hr_drafts');
    expect(sql).toContain('created_by = $1');
    expect(params).toEqual(['u1']);

    const states = [...sql.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect(states.sort()).toEqual(['draft', 'employee_created_pending_attach']);
  });
});
