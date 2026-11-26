import { describe, expect, it } from 'vitest';
import { buildStaffCategorySources, staffCategoryCaseSql } from './staff-category.service.js';

// Корни компаний — как в employees-export.service.ts (раздел определяется по id корня).
const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';

const dept = (id: string, name: string, parent_id: string | null, kind: string | null = null) => ({ id, name, parent_id, kind });

const DEPARTMENTS = [
  dept('root', 'Объект', null, 'object'),
  dept(SU10_ROOT_ID, '(СУ-10) ООО СУ-10', 'root'),
  dept('su-pto', 'ПТО', SU10_ROOT_ID),
  dept('su-brigades', 'Бригады', SU10_ROOT_ID),
  dept('br-ortikov', 'бр.Ортиков Шавкат А.', 'su-brigades'),
  dept(SM_ROOT_ID, '(СМ) Служба Механизации', 'root'),
  dept('sm-oat', 'ОАТ', SM_ROOT_ID),
  dept('contractors', 'Подрядные организации', 'root'),
  dept('ctr-alfa', 'ООО Альфа', 'contractors'),
];

const POSITIONS = [
  { id: 'p-eng', name: 'инженер' },
  { id: 'p-prorab', name: 'Производитель работ (прораб) (в строительстве)' },
  { id: 'p-painter', name: 'Маляр' },
  { id: 'p-commandant', name: 'Комендант объекта' },
  { id: 'p-driver', name: 'Водитель' },
  { id: 'p-none', name: null },
];

describe('buildStaffCategorySources', () => {
  it('бригады, СМ вне бригад и ИТР-должности по списку «Расчётов»', () => {
    const sources = buildStaffCategorySources(DEPARTMENTS, POSITIONS);
    expect(sources.brigadeDepartmentIds.sort()).toEqual(['br-ortikov', 'su-brigades'].sort());
    expect(sources.smDepartmentIds.sort()).toEqual([SM_ROOT_ID, 'sm-oat'].sort());
    expect(sources.itrPositionIds.sort()).toEqual(['p-eng', 'p-prorab']);
  });
});

describe('staffCategoryCaseSql', () => {
  it('порядок: бригада → Рабочие, ИТР-должность → ИТР, СМ → Рабочие, иначе Остальные', () => {
    const params: unknown[] = [false];
    const sql = staffCategoryCaseSql('employees', 'dep.department_id', params, {
      brigadeDepartmentIds: ['b'], smDepartmentIds: ['s'], itrPositionIds: ['p'],
    });
    const brigade = sql.indexOf("THEN 'worker'");
    const itr = sql.indexOf("THEN 'itr'");
    const sm = sql.lastIndexOf("THEN 'worker'");
    expect(brigade).toBeGreaterThan(-1);
    expect(brigade).toBeLessThan(itr);
    expect(itr).toBeLessThan(sm);
    expect(sql).toContain("dep.department_id = ANY($2::uuid[]) THEN 'worker'");
    expect(sql).toContain("employees.position_id = ANY($3::uuid[]) THEN 'itr'");
    expect(sql).toContain("dep.department_id = ANY($4::uuid[]) THEN 'worker'");
    expect(sql).toContain("ELSE 'other'");
    expect(params).toEqual([false, ['b'], ['p'], ['s']]);
  });
});
