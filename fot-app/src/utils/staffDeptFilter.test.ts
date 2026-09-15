import { describe, it, expect } from 'vitest';
import { isHeaderDeptAllowed, resolveHeaderDeptFilter } from './staffDeptFilter';

const SECTION_IDS = {
  su10: ['su10-root', 'su10-pto'],
  sm: ['sm-root'],
  brigades: ['brig-1'],
  contractors: ['contr-root', 'contr-1'],
};

describe('resolveHeaderDeptFilter', () => {
  it('«Все компании» — объединение четырёх разделов, без «Прочих»', () => {
    const filter = resolveHeaderDeptFilter({ section: 'all', sectionIds: SECTION_IDS, restrictToManaged: false });

    expect(filter.kind).toBe('ids');
    if (filter.kind !== 'ids') return;
    expect([...filter.ids].sort()).toEqual(['brig-1', 'contr-1', 'contr-root', 'sm-root', 'su10-pto', 'su10-root']);
    expect(filter.ids.has('fired-archive')).toBe(false);
  });

  it('конкретный раздел — только его отделы', () => {
    const filter = resolveHeaderDeptFilter({ section: 'sm', sectionIds: SECTION_IDS, restrictToManaged: false });

    expect(filter).toEqual({ kind: 'ids', ids: new Set(['sm-root']) });
  });

  it('руководитель при «Все компании» — без фильтра компаний и без ожидания запроса', () => {
    expect(resolveHeaderDeptFilter({ section: 'all', sectionIds: undefined, restrictToManaged: true })).toEqual({ kind: 'none' });
    expect(resolveHeaderDeptFilter({ section: 'all', sectionIds: SECTION_IDS, restrictToManaged: true })).toEqual({ kind: 'none' });
  });

  it('руководитель с выбранным разделом — фильтр раздела применяется', () => {
    const filter = resolveHeaderDeptFilter({ section: 'su10', sectionIds: SECTION_IDS, restrictToManaged: true });

    expect(filter).toEqual({ kind: 'ids', ids: new Set(['su10-root', 'su10-pto']) });
  });

  it('id разделов не загружены — ожидание, а не полный список со служебными корнями', () => {
    expect(resolveHeaderDeptFilter({ section: 'all', sectionIds: undefined, restrictToManaged: false })).toEqual({ kind: 'pending' });
    expect(resolveHeaderDeptFilter({ section: 'su10', sectionIds: undefined, restrictToManaged: false })).toEqual({ kind: 'pending' });
  });
});

describe('isHeaderDeptAllowed', () => {
  const allCompanies = resolveHeaderDeptFilter({ section: 'all', sectionIds: SECTION_IDS, restrictToManaged: false });

  it('скрытый служебный отдел из URL — не допускается (сбрасывается)', () => {
    expect(isHeaderDeptAllowed('fired-archive', allCompanies)).toBe(false);
  });

  it('отдел компании допускается, пустой выбор всегда допустим', () => {
    expect(isHeaderDeptAllowed('contr-1', allCompanies)).toBe(true);
    expect(isHeaderDeptAllowed('', allCompanies)).toBe(true);
  });

  it('пока id разделов грузятся — решение откладывается', () => {
    expect(isHeaderDeptAllowed('fired-archive', { kind: 'pending' })).toBeUndefined();
  });

  it('без фильтра (руководитель) — любой отдел скоупа допустим', () => {
    expect(isHeaderDeptAllowed('fired-archive', { kind: 'none' })).toBe(true);
  });
});
