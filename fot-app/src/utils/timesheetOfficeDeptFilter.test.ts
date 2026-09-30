import { describe, it, expect } from 'vitest';
import { selectableTimesheetOfficeDepartmentIds } from './timesheetOfficeDeptFilter';

const sections = {
  su10: ['su10-root', 'su10-it'],
  sm: ['sm-root', 'sm-garage'],
  brigades: ['brigade-1'],
  contractors: ['contractor-1'],
};

describe('selectableTimesheetOfficeDepartmentIds', () => {
  it('«Уволенные» и «test» (раздел «Прочие») в выбор не попадают, даже если сервер их разрешил', () => {
    const ids = selectableTimesheetOfficeDepartmentIds(
      ['su10-it', 'sm-garage', 'brigade-1', 'dismissed-root', 'test-root'],
      sections,
    );
    expect(ids).toEqual(new Set(['su10-it', 'sm-garage', 'brigade-1']));
  });

  it('только разрешённые сервером: вне скоупа и подрядные — нет', () => {
    expect(selectableTimesheetOfficeDepartmentIds(['su10-it'], sections)).toEqual(new Set(['su10-it']));
    expect(selectableTimesheetOfficeDepartmentIds(['contractor-1'], sections)).toEqual(new Set());
  });

  it('ветки компаний ещё не загружены — undefined, а не всё подряд', () => {
    expect(selectableTimesheetOfficeDepartmentIds(['su10-it', 'test-root'], undefined)).toBeUndefined();
  });
});
