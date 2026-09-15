import { describe, expect, it } from 'vitest';
import { affectsActiveSort } from './staffRowUpdate';

describe('affectsActiveSort', () => {
  it('правка столбца, по которому отсортировано, — перечитать список', () => {
    expect(affectsActiveSort(['comment'], 'comment')).toBe(true);
    expect(affectsActiveSort(['position'], 'position')).toBe(true);
    expect(affectsActiveSort(['schedule'], 'schedule')).toBe(true);
    expect(affectsActiveSort(['department'], 'department')).toBe(true);
  });

  it('смена отдела меняет «Признак» (перенос в «Декрет»)', () => {
    expect(affectsActiveSort(['department'], 'sign')).toBe(true);
  });

  it('правка другого столбца — строка правится на месте', () => {
    expect(affectsActiveSort(['comment'], 'name')).toBe(false);
    expect(affectsActiveSort(['position'], 'department')).toBe(false);
    expect(affectsActiveSort(['schedule'], 'hire_date')).toBe(false);
    expect(affectsActiveSort([], 'comment')).toBe(false);
  });
});
