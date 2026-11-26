import { describe, expect, it } from 'vitest';
import { computeAutoInactiveDepartments, staffInactiveSql, workingConditionSql } from './employee-inactive.service.js';
import { statusConditionSql } from '../controllers/employees-staff-filter.helpers.js';

const row = (id: string, name: string | null, parent_id: string | null = null) => ({ id, name, parent_id, sigur_department_id: null });

describe('computeAutoInactiveDepartments', () => {
  it('ветки «Декрет» и «Архив» с потомками и названием ветки; похожие имена не считаются', () => {
    const auto = computeAutoInactiveDepartments([
      row('root', 'Объект'),
      row('su10', '(СУ-10) ООО СУ-10', 'root'),
      row('decret', 'Декрет', 'su10'),
      row('decret-sub', 'Подгруппа', 'decret'),
      row('archive', 'АРХИВ ', 'su10'),
      row('vent', 'Отдел вентиляции', 'su10'),
      row('archive-like', 'Архивный отдел', 'su10'),
      row('fired', 'Уволенные', 'root'),
    ]);
    expect(auto.ids.sort()).toEqual(['archive', 'decret', 'decret-sub']);
    expect(auto.nameById.get('decret-sub')).toBe('Декрет');
    expect(auto.nameById.get('archive')).toBe('Архив');
    expect(auto.nameById.has('vent')).toBe(false);
  });
});

describe('SQL неактивности', () => {
  it('никогда не NULL: отдел NULL и пустой список дают false через COALESCE', () => {
    const params: unknown[] = ['x'];
    expect(staffInactiveSql('e', params, ['d1'])).toBe(
      '(e.staff_inactive_at IS NOT NULL OR COALESCE(e.org_department_id = ANY($2::uuid[]), false))',
    );
    expect(params).toEqual(['x', ['d1']]);
  });

  it('«Активные» — не уволен и не неактивен; без алиаса — колонки employees', () => {
    const params: unknown[] = [];
    expect(workingConditionSql('', params, [])).toBe(
      "(employment_status <> 'fired' AND NOT (staff_inactive_at IS NOT NULL OR COALESCE(org_department_id = ANY($1::uuid[]), false)))",
    );
    expect(params).toEqual([[]]);
  });
});

describe('statusConditionSql (миграция 381)', () => {
  it('working — «Активные» без неактивных; параметр — отделы «Декрет»/«Архив»', () => {
    const params: unknown[] = [false];
    expect(statusConditionSql('working', params, ['d1'])).toContain('NOT (staff_inactive_at IS NOT NULL');
    expect(params).toEqual([false, ['d1']]);
  });

  it('all — без условия; active — прежнее «не уволен» без параметров (окна выбора сотрудника)', () => {
    const params: unknown[] = [];
    expect(statusConditionSql('all', params, ['d1'])).toBeNull();
    expect(statusConditionSql('active', params, ['d1'])).toBe("employment_status <> 'fired'");
    expect(statusConditionSql(undefined, params, ['d1'])).toBe("employment_status <> 'fired'");
    expect(statusConditionSql('fired', params, ['d1'])).toBe("employment_status = 'fired'");
    expect(statusConditionSql('excluded', params, ['d1'])).toBe("excluded_from_timesheet = true AND employment_status <> 'fired'");
    expect(params).toEqual([]);
  });
});
