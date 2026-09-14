import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadAdjustmentsMock = vi.hoisted(() => vi.fn());
const buildObjectDataMock = vi.hoisted(() => vi.fn());

vi.mock('./attendance.service.js', () => ({
  loadAttendanceAdjustments: loadAdjustmentsMock,
}));

vi.mock('./timesheet-object.service.js', () => ({
  buildObjectAttendanceData: buildObjectDataMock,
}));

const {
  pickMainObject,
  pickMainObjectDetailed,
  loadMainObjectByEmployee,
  loadMainObjectDetailedByEmployee,
  EMPLOYEE_CHUNK_SIZE,
} = await import('./employees-export-objects.service.js');

const entry = (
  employee_id: number,
  object_id: string | null,
  object_name: string,
  display_hours_worked: number,
  object_key: string = object_id ?? '__unknown_object__',
) => ({ employee_id, object_id, object_name, object_key, display_hours_worked });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pickMainObject', () => {
  it('суммирует часы за несколько дней и выбирает максимум', () => {
    const result = pickMainObject([
      entry(1, 'o1', 'ЖК Север', 8),
      entry(1, 'o2', 'ЖК Юг', 10),
      entry(1, 'o1', 'ЖК Север', 8),
    ]);
    expect(result.get(1)).toBe('ЖК Север');
  });

  it('отрицательная правка входит в сумму до выбора', () => {
    const result = pickMainObject([
      entry(1, 'o1', 'ЖК Север', 12),
      entry(1, 'o1', 'ЖК Север', -5),
      entry(1, 'o2', 'ЖК Юг', 8),
    ]);
    expect(result.get(1)).toBe('ЖК Юг');
  });

  it('игнорирует «Не определён» и объекты без id, итоги ≤ 0 — пусто', () => {
    const result = pickMainObject([
      entry(1, null, 'Не определён', 40),
      entry(1, 'o1', 'ЖК Север', 4),
      entry(1, 'o1', 'ЖК Север', -4),
      entry(2, 'o2', 'ЖК Юг', 0),
    ]);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(false);
  });

  it('равенство часов — по названию, затем по object_id, независимо от порядка', () => {
    const forward = pickMainObject([entry(1, 'o2', 'Бета', 8), entry(1, 'o1', 'Альфа', 8)]);
    const backward = pickMainObject([entry(1, 'o1', 'Альфа', 8), entry(1, 'o2', 'Бета', 8)]);
    expect(forward.get(1)).toBe('Альфа');
    expect(backward.get(1)).toBe('Альфа');

    const sameName = pickMainObject([entry(1, 'o9', 'Склад', 5), entry(1, 'o3', 'Склад', 5)]);
    expect(sameName.get(1)).toBe('Склад');
  });

  it('гасит хвосты float при сравнении', () => {
    const result = pickMainObject([
      entry(1, 'o2', 'Бета', 0.1), entry(1, 'o2', 'Бета', 0.2),
      entry(1, 'o1', 'Альфа', 0.3),
    ]);
    expect(result.get(1)).toBe('Альфа');
  });

  it('считает сотрудников независимо', () => {
    const result = pickMainObject([entry(1, 'o1', 'ЖК Север', 8), entry(2, 'o2', 'ЖК Юг', 8)]);
    expect([...result.entries()]).toEqual([[1, 'ЖК Север'], [2, 'ЖК Юг']]);
  });

  it('нет данных — пустая карта', () => {
    expect(pickMainObject([]).size).toBe(0);
  });
});

describe('pickMainObjectDetailed', () => {
  it('отдаёт id объекта и сумму часов, округлённую до центичасов', () => {
    const result = pickMainObjectDetailed([
      entry(1, 'o1', 'ЖК Север', 8.333), entry(1, 'o1', 'ЖК Север', 4.334), entry(1, 'o2', 'ЖК Юг', -1),
    ]);
    expect(result.get(1)).toEqual({ objectId: 'o1', objectName: 'ЖК Север', hours: 12.67 });
  });

  it('совпадает с pickMainObject по выбору объекта', () => {
    const entries = [
      entry(1, 'o2', 'Бета', 8), entry(1, 'o1', 'Альфа', 8),
      entry(2, 'o3', 'Склад', 3), entry(2, 'o3', 'Склад', -5),
    ];
    const names = [...pickMainObjectDetailed(entries)].map(([id, main]) => [id, main.objectName]);
    expect(names).toEqual([...pickMainObject(entries)]);
  });
});

describe('loadMainObjectByEmployee', () => {
  it('детальная и краткая загрузка дают один результат', async () => {
    loadAdjustmentsMock.mockResolvedValue([]);
    buildObjectDataMock.mockResolvedValue({ objectEntries: [entry(5, 'o1', 'ЖК Север', 8)] });
    const period = { start: '2026-08-15', end: '2026-09-13' };

    const detailed = await loadMainObjectDetailedByEmployee([5], period);
    const names = await loadMainObjectByEmployee([5], period);

    expect(detailed.get(5)).toEqual({ objectId: 'o1', objectName: 'ЖК Север', hours: 8 });
    expect(names.get(5)).toBe('ЖК Север');
  });

  it('передаёт период в загрузку правок и расчёт объектов, todayStr = конец периода', async () => {
    loadAdjustmentsMock.mockResolvedValue([{ id: 1 }]);
    buildObjectDataMock.mockResolvedValue({ objectEntries: [entry(5, 'o1', 'ЖК Север', 8)] });

    const result = await loadMainObjectByEmployee([5], { start: '2026-08-16', end: '2026-09-14' });

    expect(loadAdjustmentsMock).toHaveBeenCalledWith([5], '2026-08-16', '2026-09-14');
    expect(buildObjectDataMock).toHaveBeenCalledWith({
      employeeIds: [5],
      startDate: '2026-08-16',
      endDate: '2026-09-14',
      todayStr: '2026-09-14',
      adjustments: [{ id: 1 }],
    });
    expect(result.get(5)).toBe('ЖК Север');
  });

  it('делит сотрудников на чанки и собирает общий результат', async () => {
    loadAdjustmentsMock.mockResolvedValue([]);
    buildObjectDataMock.mockImplementation(async ({ employeeIds }: { employeeIds: number[] }) => ({
      objectEntries: employeeIds.map(id => entry(id, 'o1', 'ЖК Север', 1)),
    }));
    const total = EMPLOYEE_CHUNK_SIZE * 2 + 500;
    const ids = Array.from({ length: total }, (_, index) => index + 1);

    const result = await loadMainObjectByEmployee(ids, { start: '2026-08-16', end: '2026-09-14' });

    expect(buildObjectDataMock).toHaveBeenCalledTimes(3);
    expect(buildObjectDataMock.mock.calls.map(([arg]) => arg.employeeIds.length))
      .toEqual([EMPLOYEE_CHUNK_SIZE, EMPLOYEE_CHUNK_SIZE, 500]);
    expect(result.size).toBe(total);
  });

  it('пустой список — без запросов', async () => {
    const result = await loadMainObjectByEmployee([], { start: '2026-08-16', end: '2026-09-14' });
    expect(result.size).toBe(0);
    expect(buildObjectDataMock).not.toHaveBeenCalled();
  });
});
