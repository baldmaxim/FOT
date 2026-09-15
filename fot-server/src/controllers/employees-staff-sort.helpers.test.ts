import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  loadActiveSnapshotRun: vi.fn(),
  getAllDepartmentsTree: vi.fn(),
}));
vi.mock('../services/employee-main-object-snapshot.service.js', () => ({ loadActiveSnapshotRun: h.loadActiveSnapshotRun }));
vi.mock('../services/skud-shared.service.js', () => ({ getAllDepartmentsTree: h.getAllDepartmentsTree }));

const {
  buildSortCursorSql,
  buildSortOrderSql,
  buildStaffSortKeySql,
  parseStaffSort,
  parseStaffSortCursor,
  StaffSortUnavailableError,
  STAFF_SORT_KEYS,
} = await import('./employees-staff-sort.helpers.js');

/** Каждый $1..$N встречается в SQL, и выше N плейсхолдеров нет. */
const expectPlaceholdersMatch = (sql: string, params: unknown[]) => {
  const used = new Set([...sql.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));
  expect(Math.max(0, ...used)).toBe(params.length);
  for (let i = 1; i <= params.length; i += 1) expect(used.has(i)).toBe(true);
};

beforeEach(() => {
  h.loadActiveSnapshotRun.mockReset().mockResolvedValue({ id: 77, period: { start: '2026-08-15', end: '2026-09-13' }, finishedAt: null });
  h.getAllDepartmentsTree.mockReset().mockResolvedValue([
    { id: 'root', parent_id: null, name: 'СУ-10' },
    { id: 'maternity', parent_id: 'root', name: ' Декрет ' },
    { id: 'maternity-child', parent_id: 'maternity', name: 'Группа' },
    { id: 'office', parent_id: 'root', name: 'Офис' },
  ]);
});

describe('parseStaffSort', () => {
  it('без sort и dir — без сортировки (старый клиент)', () => {
    expect(parseStaffSort({})).toEqual({ ok: true, sort: null });
  });

  it('известный ключ; dir по умолчанию asc', () => {
    for (const key of STAFF_SORT_KEYS) {
      expect(parseStaffSort({ sort: key })).toEqual({ ok: true, sort: { key, dir: 'asc' } });
      expect(parseStaffSort({ sort: key, dir: 'desc' })).toEqual({ ok: true, sort: { key, dir: 'desc' } });
    }
  });

  it('неизвестный ключ, dir без sort, неверный dir, массив — ошибка', () => {
    expect(parseStaffSort({ sort: 'cost_item' })).toEqual({ ok: false });
    expect(parseStaffSort({ dir: 'asc' })).toEqual({ ok: false });
    expect(parseStaffSort({ sort: 'name', dir: 'DESC' })).toEqual({ ok: false });
    expect(parseStaffSort({ sort: ['name'] })).toEqual({ ok: false });
  });
});

describe('parseStaffSortCursor', () => {
  it('без курсора — первая порция', () => {
    expect(parseStaffSortCursor({})).toEqual({ ok: true, after: null });
  });

  it('непустой ключ, пустая строка и NULL-ключ', () => {
    expect(parseStaffSortCursor({ after_key: 'Бухгалтерия', after_null: '0', after_id: '15' }))
      .toEqual({ ok: true, after: { key: 'Бухгалтерия', id: 15 } });
    expect(parseStaffSortCursor({ after_key: '', after_null: '0', after_id: '1' }))
      .toEqual({ ok: true, after: { key: '', id: 1 } });
    expect(parseStaffSortCursor({ after_null: '1', after_id: '9' })).toEqual({ ok: true, after: { key: null, id: 9 } });
  });

  it('after_name с сортировкой, неполный курсор, неверный id — ошибка', () => {
    const bad = [
      { after_name: 'А', after_id: '1' },
      { after_key: 'А', after_id: '1' },
      { after_null: '0', after_id: '1' },
      { after_null: '1', after_key: 'А', after_id: '1' },
      { after_key: 'А', after_null: '0' },
      { after_key: 'А', after_null: '0', after_id: '0' },
      { after_key: 'А', after_null: '0', after_id: '-3' },
      { after_key: 'А', after_null: 'x', after_id: '3' },
      { after_key: ['А'], after_null: '0', after_id: '3' },
    ];
    for (const params of bad) expect(parseStaffSortCursor(params)).toEqual({ ok: false });
  });
});

describe('buildStaffSortKeySql', () => {
  it('каждый ключ — корректные плейсхолдеры при непустом наборе параметров', async () => {
    for (const key of STAFF_SORT_KEYS) {
      const params: unknown[] = [true, 'x'];
      const sql = await buildStaffSortKeySql(key, params);
      const probe = `WHERE is_archived = $1 AND full_name = $2 AND ${sql} IS NOT NULL`;
      expectPlaceholdersMatch(probe, params);
    }
  });

  it('график — «сегодня» по Москве на запрос, первое активное назначение, иначе график по умолчанию', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-30T21:30:00Z')); // в Москве уже 1 октября
      const params: unknown[] = [];
      const sql = await buildStaffSortKeySql('schedule', params);
      expect(params).toEqual(['2026-10-01']);
      expect(sql).toContain('ORDER BY a.effective_from DESC, a.id DESC');
      expect(sql).toContain('LEFT JOIN work_schedules ws');
      expect(sql).toContain('w.is_default');
    } finally {
      vi.useRealTimers();
    }
  });

  it('признак — id отделов «Декрет» с потомками', async () => {
    const params: unknown[] = [];
    await buildStaffSortKeySql('sign', params);
    expect((params[0] as string[]).sort()).toEqual(['maternity', 'maternity-child']);
  });

  it('объект — активное поколение снимка; без снимка — недоступно', async () => {
    const params: unknown[] = [];
    const sql = await buildStaffSortKeySql('main_object', params);
    expect(params).toEqual([77]);
    expect(sql).toContain('employee_main_object_snapshot');
    h.loadActiveSnapshotRun.mockResolvedValue(null);
    await expect(buildStaffSortKeySql('main_object', [])).rejects.toBeInstanceOf(StaffSortUnavailableError);
  });
});

describe('курсор и порядок', () => {
  it('NULL в конце при любом направлении, id — в направлении ключа', () => {
    expect(buildSortOrderSql('s', 'asc')).toBe('ORDER BY (s.sort_key IS NULL) ASC, s.sort_key ASC, s.id ASC');
    expect(buildSortOrderSql('s', 'desc')).toBe('ORDER BY (s.sort_key IS NULL) ASC, s.sort_key DESC, s.id DESC');
  });

  it('непустой курсор: больше ключа, равный ключ с большим id, либо пустые', () => {
    const params: unknown[] = ['p1'];
    const sql = buildSortCursorSql('s', 'desc', { key: 'Б', id: 5 }, params);
    expect(params).toEqual(['p1', 5, 'Б']);
    expect(sql).toContain('s.sort_key < $3::text');
    expect(sql).toContain('s.id < $2::int');
    expect(sql).toContain('OR s.sort_key IS NULL');
  });

  it('NULL-курсор: только пустые с id дальше', () => {
    const params: unknown[] = [];
    expect(buildSortCursorSql('s', 'asc', { key: null, id: 8 }, params)).toBe('(s.sort_key IS NULL AND s.id > $1::int)');
    expect(params).toEqual([8]);
  });
});
