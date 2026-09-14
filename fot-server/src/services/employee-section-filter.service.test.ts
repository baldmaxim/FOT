import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../config/postgres.js', () => ({ query: queryMock }));

const scopeFilterMock = vi.hoisted(() => vi.fn());
vi.mock('./employee-scope-filter.service.js', () => ({ resolveEmployeeListScopeFilter: scopeFilterMock }));

const {
  buildSectionConditionSql,
  parseSectionParam,
  resolveSectionFilterContext,
} = await import('./employee-section-filter.service.js');

const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const DEPARTMENTS = [
  { id: 'root', parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10_ROOT_ID, parent_id: 'root', name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'su-vent', parent_id: SU10_ROOT_ID, name: 'Отдел вентиляции', kind: 'department' },
  { id: 'su-site', parent_id: SU10_ROOT_ID, name: 'Строительный участок', kind: 'department' },
  { id: 'brigades', parent_id: 'su-site', name: 'Бригады', kind: 'department' },
  { id: 'br-1', parent_id: 'brigades', name: 'бр.Иванов', kind: 'brigade' },
];

const req = {} as AuthenticatedRequest;

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue(DEPARTMENTS);
  scopeFilterMock.mockReset();
});

describe('parseSectionParam', () => {
  it('нет или all — без фильтра; известные — фильтр; иное — ошибка', () => {
    expect(parseSectionParam(undefined)).toEqual({ ok: true, section: null });
    expect(parseSectionParam('')).toEqual({ ok: true, section: null });
    expect(parseSectionParam('all')).toEqual({ ok: true, section: null });
    for (const key of ['sm', 'su10', 'brigades', 'contractors']) {
      expect(parseSectionParam(key)).toEqual({ ok: true, section: key });
    }
    expect(parseSectionParam('other')).toEqual({ ok: false });
    expect(parseSectionParam('SU10')).toEqual({ ok: false });
    expect(parseSectionParam(['su10'])).toEqual({ ok: false });
  });
});

describe('resolveSectionFilterContext', () => {
  it('глобальное чтение — скоуп all, фильтр скоупа не запрашивается', async () => {
    const context = await resolveSectionFilterContext(req, 'su10', true);
    expect(context.scope.mode).toBe('all');
    expect(scopeFilterMock).not.toHaveBeenCalled();
    expect(context.departmentIds.sort()).toEqual([SU10_ROOT_ID, 'su-site', 'su-vent'].sort());
  });

  it('без глобального чтения — скоуп как у списка', async () => {
    const scope = { mode: 'departments', departmentIds: ['su-vent'], directEmployeeIds: [42], selfEmployeeId: null };
    scopeFilterMock.mockResolvedValue(scope);
    const context = await resolveSectionFilterContext(req, 'brigades', false);
    expect(context.scope).toBe(scope);
    expect(context.departmentIds.sort()).toEqual(['br-1', 'brigades']);
  });
});

describe('buildSectionConditionSql', () => {
  it('отдел раздела И «попал через отдел скоупа»: прямой подчинённый вне отделов скоупа не проходит', () => {
    const params: unknown[] = ['p1'];
    const sql = buildSectionConditionSql(
      {
        departmentIds: [SU10_ROOT_ID, 'su-vent'],
        scope: { mode: 'departments', departmentIds: ['su-vent'], directEmployeeIds: [42], selfEmployeeId: null },
      },
      'employees',
      params,
    );
    expect(sql).toContain('= ANY($2::uuid[])');
    expect(sql).toContain('= ANY($3::uuid[]))');
    expect(sql).toContain('employee_dismissal_events');
    // Прямые подчинённые в условие раздела не добавляются — это их и исключает.
    expect(sql).not.toContain('int[]');
    expect(params).toEqual(['p1', [SU10_ROOT_ID, 'su-vent'], ['su-vent']]);
  });

  it('глобальный скоуп — только отдел раздела', () => {
    const params: unknown[] = [];
    const sql = buildSectionConditionSql(
      { departmentIds: ['d1'], scope: { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null } },
      'employees',
      params,
    );
    expect(sql.endsWith('= ANY($1::uuid[]) AND TRUE)')).toBe(true);
    expect(params).toEqual([['d1']]);
  });

  it('раздел без отделов — FALSE без параметров', () => {
    const params: unknown[] = [];
    expect(buildSectionConditionSql(
      { departmentIds: [], scope: { mode: 'all', departmentIds: [], directEmployeeIds: [], selfEmployeeId: null } },
      'employees',
      params,
    )).toBe('FALSE');
    expect(params).toEqual([]);
  });
});
