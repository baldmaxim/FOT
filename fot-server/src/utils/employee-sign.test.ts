import { describe, expect, it } from 'vitest';
import {
  buildSignDepartmentIndex,
  findAutoInactiveDepartmentName,
  resolveEmployeeSign,
  type ISignDepartment,
} from './employee-sign.js';

const dept = (id: string, name: string, parent_id: string | null = null): ISignDepartment => ({ id, name, parent_id });

const INDEX = buildSignDepartmentIndex([
  dept('root', 'Объект'),
  dept('su10', '(СУ-10) ООО СУ-10', 'root'),
  dept('decret', '  ДЕКРЕТ ', 'su10'),
  dept('decret-child', 'Группа 1', 'decret'),
  dept('archive', 'Архив', 'su10'),
  dept('vent', 'Отдел вентиляции', 'su10'),
  dept('archive-like', 'Архивный отдел', 'su10'),
  dept('loop-a', 'Цикл А', 'loop-b'),
  dept('loop-b', 'Цикл Б', 'loop-a'),
]);

const sign = (employmentStatus: string, departmentId: string | null, staffInactiveAt: string | null = null) =>
  resolveEmployeeSign({ employmentStatus, departmentId, deptById: INDEX, staffInactiveAt });

describe('resolveEmployeeSign (миграция 381)', () => {
  it('уволенный — «Уволен», даже из «Декрета» и с ручной меткой', () => {
    expect(sign('fired', 'decret')).toBe('Уволен');
    expect(sign('fired', 'vent', '2026-11-26T10:00:00.000Z')).toBe('Уволен');
  });

  it('«Декрет» и «Архив» — «Неактивен»: на самом отделе и на предке, без учёта регистра и пробелов', () => {
    expect(sign('active', 'decret')).toBe('Неактивен');
    expect(sign('active', 'decret-child')).toBe('Неактивен');
    expect(sign('active', 'archive')).toBe('Неактивен');
  });

  it('ручная метка — «Неактивен» в любом отделе', () => {
    expect(sign('active', 'vent', '2026-11-26T10:00:00.000Z')).toBe('Неактивен');
    expect(sign('active', null, '2026-11-26T10:00:00.000Z')).toBe('Неактивен');
  });

  it('обычный отдел, похожее имя, неизвестный отдел и отсутствие отдела — «Работает»', () => {
    expect(sign('active', 'vent')).toBe('Работает');
    expect(sign('active', 'archive-like')).toBe('Работает');
    expect(sign('active', 'missing')).toBe('Работает');
    expect(sign('active', null)).toBe('Работает');
  });
});

describe('findAutoInactiveDepartmentName', () => {
  it('название ветки — у ближайшего узла, и для вложенного отдела', () => {
    expect(findAutoInactiveDepartmentName('decret-child', INDEX)).toBe('Декрет');
    expect(findAutoInactiveDepartmentName('archive', INDEX)).toBe('Архив');
    expect(findAutoInactiveDepartmentName('vent', INDEX)).toBeNull();
    expect(findAutoInactiveDepartmentName(null, INDEX)).toBeNull();
  });

  it('цикл parent_id не вешает подъём', () => {
    expect(findAutoInactiveDepartmentName('loop-a', INDEX)).toBeNull();
  });
});
