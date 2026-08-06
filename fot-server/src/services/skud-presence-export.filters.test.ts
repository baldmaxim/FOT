import { describe, expect, it } from 'vitest';
import {
  assertExportSize,
  buildFilterOptions,
  countExportRows,
  filterPresenceExport,
  MAX_EXPORT_ROWS,
  type IPresenceExportDay,
} from './skud-presence-export.service.js';

/**
 * Порядок конвейера: фильтры → NO_DATA → лимит строк. Лимит обязан считаться
 * ПОСЛЕ фильтров, иначе совет «сузьте фильтры» невыполним.
 */

const dataset = (): IPresenceExportDay[] => [
  {
    date: '2026-08-03',
    objects: [
      {
        object_key: 'obj-1',
        object_name: 'ЖК Alia',
        total: 3,
        groups: [
          {
            key: 'local:dept-a',
            name: 'бр.Тоштемиров',
            company_name: 'СУ-10',
            employees: [
              { entry_time: '07:00:00', full_name: 'Первый' },
              { entry_time: '07:10:00', full_name: 'Второй' },
            ],
          },
          {
            key: 'local:dept-b',
            name: 'Электрики',
            company_name: 'ЛИНИЯ',
            employees: [{ entry_time: '08:00:00', full_name: 'Третий' }],
          },
        ],
      },
      {
        object_key: 'obj-2',
        object_name: 'ЖК Инжой',
        total: 1,
        groups: [
          {
            key: 'local:dept-a',
            name: 'бр.Тоштемиров',
            company_name: 'СУ-10',
            employees: [{ entry_time: '09:00:00', full_name: 'Четвёртый' }],
          },
        ],
      },
    ],
  },
];

describe('filterPresenceExport', () => {
  it('пустые наборы = все', () => {
    const days = dataset();
    expect(filterPresenceExport(days, {})).toBe(days);
    expect(filterPresenceExport(days, { objectKeys: new Set(), groupKeys: new Set() })).toBe(days);
  });

  it('фильтрует по объектам и пересчитывает total', () => {
    const result = filterPresenceExport(dataset(), { objectKeys: new Set(['obj-2']) });
    expect(result[0].objects).toHaveLength(1);
    expect(result[0].objects[0].object_key).toBe('obj-2');
    expect(result[0].objects[0].total).toBe(1);
  });

  it('фильтрует по отделам и выкидывает опустевшие объекты и дни', () => {
    const result = filterPresenceExport(dataset(), { groupKeys: new Set(['local:dept-b']) });
    expect(result).toHaveLength(1);
    expect(result[0].objects).toHaveLength(1);
    expect(result[0].objects[0].object_key).toBe('obj-1');
    expect(result[0].objects[0].total).toBe(1);

    const empty = filterPresenceExport(dataset(), { groupKeys: new Set(['local:unknown']) });
    expect(empty).toEqual([]);
  });

  it('не мутирует исходный (кэшированный) датасет', () => {
    const days = dataset();
    const snapshot = JSON.parse(JSON.stringify(days));
    filterPresenceExport(days, { objectKeys: new Set(['obj-1']), groupKeys: new Set(['local:dept-a']) });
    expect(days).toEqual(snapshot);
  });
});

describe('assertExportSize', () => {
  const hugeDay = (total: number): IPresenceExportDay[] => [
    { date: '2026-08-03', objects: [{ object_key: 'obj-1', object_name: 'ЖК Alia', total, groups: [] }] },
  ];

  it('пропускает ровно лимит и режет лимит+1', () => {
    expect(() => assertExportSize(hugeDay(MAX_EXPORT_ROWS))).not.toThrow();
    expect(() => assertExportSize(hugeDay(MAX_EXPORT_ROWS + 1))).toThrowError(
      expect.objectContaining({ code: 'EXPORT_TOO_LARGE' }),
    );
  });

  it('лимит считается после фильтров: узкий фильтр спасает большой датасет', () => {
    const days: IPresenceExportDay[] = [{
      date: '2026-08-03',
      objects: [
        { object_key: 'obj-1', object_name: 'ЖК Alia', total: MAX_EXPORT_ROWS, groups: [] },
        {
          object_key: 'obj-2',
          object_name: 'ЖК Инжой',
          total: 1,
          groups: [{
            key: 'local:dept-a',
            name: 'бр.Тоштемиров',
            company_name: 'СУ-10',
            employees: [{ entry_time: '07:00:00', full_name: 'Первый' }],
          }],
        },
      ],
    }];

    expect(() => assertExportSize(days)).toThrowError(
      expect.objectContaining({ code: 'EXPORT_TOO_LARGE' }),
    );
    const narrowed = filterPresenceExport(days, { objectKeys: new Set(['obj-2']) });
    expect(() => assertExportSize(narrowed)).not.toThrow();
    expect(countExportRows(narrowed)).toBe(1);
  });
});

describe('buildFilterOptions', () => {
  it('собирает уникальные объекты и отделы из датасета', () => {
    const options = buildFilterOptions(dataset());
    // Порядок — Intl.Collator('ru'): кириллица раньше латиницы внутри строки.
    expect(options.objects).toEqual([
      { key: 'obj-2', name: 'ЖК Инжой' },
      { key: 'obj-1', name: 'ЖК Alia' },
    ]);
    expect(options.groups).toEqual([
      { key: 'local:dept-b', name: 'Электрики', company_name: 'ЛИНИЯ' },
      { key: 'local:dept-a', name: 'бр.Тоштемиров', company_name: 'СУ-10' },
    ]);
  });

  it('на пустом датасете отдаёт пустые списки, а не падает', () => {
    expect(buildFilterOptions([])).toEqual({ objects: [], groups: [] });
  });
});
