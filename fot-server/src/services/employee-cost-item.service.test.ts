import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
vi.mock('../config/postgres.js', () => ({ query: queryMock }));

const resolveModesMock = vi.hoisted(() => vi.fn());
vi.mock('./timesheet-export-mode.service.js', async () => {
  const actual = await vi.importActual<typeof import('./timesheet-export-mode.service.js')>('./timesheet-export-mode.service.js');
  return { ...actual, resolveExportModes: resolveModesMock };
});

const { buildCostItemLabel, loadCostItems } = await import('./employee-cost-item.service.js');

beforeEach(() => {
  queryMock.mockReset().mockResolvedValue([]);
  resolveModesMock.mockReset().mockResolvedValue(new Map());
});

describe('buildCostItemLabel', () => {
  it('текущая деятельность', () => {
    expect(buildCostItemLabel({ mode: 'current_activity', pinnedObjectName: 'ЖК Wave', skudObjectNames: ['ЖК Alia'] }))
      .toBe('Текущая деятельность');
  });

  it('объект — название закреплённого объекта; объекта нет — «Объект»', () => {
    expect(buildCostItemLabel({ mode: 'object', pinnedObjectName: 'ЖК Wave', skudObjectNames: ['ЖК Alia'] })).toBe('ЖК Wave');
    expect(buildCostItemLabel({ mode: 'object', pinnedObjectName: null, skudObjectNames: [] })).toBe('Объект');
    expect(buildCostItemLabel({ mode: 'object', pinnedObjectName: '  ', skudObjectNames: [] })).toBe('Объект');
  });

  it('СКУД — объекты в скобках в переданном порядке; объектов нет — просто «СКУД»', () => {
    expect(buildCostItemLabel({ mode: 'skud', pinnedObjectName: null, skudObjectNames: ['ЖК Wave', 'ЖК Alia'] }))
      .toBe('СКУД (ЖК Wave, ЖК Alia)');
    expect(buildCostItemLabel({ mode: 'skud', pinnedObjectName: null, skudObjectNames: [] })).toBe('СКУД');
  });
});

describe('loadCostItems', () => {
  it('строка для каждого id: без часов, без режима в карте (фолбэк skud), объект — по имени из skud_objects', async () => {
    resolveModesMock.mockResolvedValue(new Map([
      [1, { mode: 'current_activity', pinnedObjectId: null, source: 'department_explicit' }],
      [2, { mode: 'object', pinnedObjectId: 'obj-1', source: 'employee_explicit' }],
      [3, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }],
      [5, { mode: 'object', pinnedObjectId: 'obj-missing', source: 'employee_explicit' }],
    ]));
    queryMock.mockResolvedValue([{ id: 'obj-1', name: 'ЖК Ситибэй' }]);

    const result = await loadCostItems([1, 2, 3, 4, 5, 3], new Map([[3, ['ЖК Wave', 'ЖК Alia']], [4, ['ЖК Дом 56']]]));

    expect([...result]).toEqual([
      [1, 'Текущая деятельность'],
      [2, 'ЖК Ситибэй'],
      [3, 'СКУД (ЖК Wave, ЖК Alia)'],
      [4, 'СКУД (ЖК Дом 56)'],
      [5, 'Объект'],
    ]);
    expect(resolveModesMock).toHaveBeenCalledWith([1, 2, 3, 4, 5]);
    const [, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect((params[0] as string[]).sort()).toEqual(['obj-1', 'obj-missing']);
  });

  it('нет закреплённых объектов — skud_objects не читается', async () => {
    resolveModesMock.mockResolvedValue(new Map([[1, { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' }]]));
    expect([...await loadCostItems([1], new Map())]).toEqual([[1, 'СКУД']]);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('пустой список — без запросов', async () => {
    expect((await loadCostItems([], new Map())).size).toBe(0);
    expect(resolveModesMock).not.toHaveBeenCalled();
  });
});
