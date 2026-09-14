import { describe, expect, it } from 'vitest';
import {
  buildSignDepartmentIndex,
  isInMaternityDepartment,
  resolveEmployeeSign,
  type ISignDepartment,
} from './employee-sign.js';

const dept = (id: string, name: string, parent_id: string | null = null): ISignDepartment => ({ id, name, parent_id });

const INDEX = buildSignDepartmentIndex([
  dept('root', 'Объект'),
  dept('su10', '(СУ-10) ООО СУ-10', 'root'),
  dept('decret', '  ДЕКРЕТ ', 'su10'),
  dept('decret-child', 'Группа 1', 'decret'),
  dept('vent', 'Отдел вентиляции', 'su10'),
  dept('loop-a', 'Цикл А', 'loop-b'),
  dept('loop-b', 'Цикл Б', 'loop-a'),
]);

describe('resolveEmployeeSign', () => {
  it('уволенный — «Уволен», даже из «Декрета»', () => {
    expect(resolveEmployeeSign({ employmentStatus: 'fired', departmentId: 'decret', deptById: INDEX })).toBe('Уволен');
  });

  it('«Декрет» распознаётся на самом отделе и на предке, без учёта регистра и пробелов', () => {
    expect(resolveEmployeeSign({ employmentStatus: 'active', departmentId: 'decret', deptById: INDEX })).toBe('Декрет');
    expect(resolveEmployeeSign({ employmentStatus: 'active', departmentId: 'decret-child', deptById: INDEX })).toBe('Декрет');
  });

  it('обычный отдел, неизвестный отдел и отсутствие отдела — «Работает»', () => {
    expect(resolveEmployeeSign({ employmentStatus: 'active', departmentId: 'vent', deptById: INDEX })).toBe('Работает');
    expect(resolveEmployeeSign({ employmentStatus: 'active', departmentId: 'missing', deptById: INDEX })).toBe('Работает');
    expect(resolveEmployeeSign({ employmentStatus: 'active', departmentId: null, deptById: INDEX })).toBe('Работает');
  });

  it('цикл parent_id не вешает подъём', () => {
    expect(isInMaternityDepartment('loop-a', INDEX)).toBe(false);
  });
});
