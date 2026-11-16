import { describe, expect, it } from 'vitest';

import type { OrgDepartmentNode } from '../types/organization';
import { buildBranchTree } from './branchTree';

const OBJ = { id: 'obj', name: 'Объект' };
const SU10 = { id: 'su10', name: '(СУ-10) ООО СУ-10' };
const SM = { id: 'sm', name: '(СМ) Служба Механизации' };
const STROY = { id: 'stroy', name: 'Департамент строительства' };

/** Дерево в виде «подпись[серый]: дети» — удобно сравнивать. */
const shape = (nodes: ReadonlyArray<OrgDepartmentNode>): unknown[] => nodes.map(node => (
  node.children.length > 0
    ? { [`${node.name}${node.in_scope ? '' : ' [серый]'}`]: shape(node.children) }
    : `${node.name}${node.in_scope ? '' : ' [серый]'}`
));

describe('buildBranchTree', () => {
  it('предки — серые заголовки, отделы — пункты с числом, бригада внутри отдела, общий предок — один узел', () => {
    const tree = buildBranchTree(
      [
        { id: 'mech', name: 'Отдел главного механика', count: 1 },
        { id: 'line', name: 'ЛИНИЯ', count: 8 },
        { id: 'brig', name: 'бр.Менгбоев Г.И.', count: 18 },
      ],
      [
        { id: 'mech', name: 'Отдел главного механика', path: [OBJ, SM] },
        { id: 'line', name: 'ЛИНИЯ', path: [OBJ, SU10, STROY] },
        { id: 'brig', name: 'бр.Менгбоев Г.И.', path: [OBJ, SU10, STROY] },
      ],
    );

    expect(shape(tree)).toEqual([{
      'Объект [серый]': [
        { '(СМ) Служба Механизации [серый]': ['Отдел главного механика (1)'] },
        { '(СУ-10) ООО СУ-10 [серый]': [{ 'Департамент строительства [серый]': ['ЛИНИЯ (8)', 'бр.Менгбоев Г.И. (18)'] }] },
      ],
    }]);
  });

  it('отдел, который и сам пункт, и родитель другого пункта — выбирается, с числом', () => {
    const tree = buildBranchTree(
      [
        { id: 'sm', name: SM.name, count: 1 },
        { id: 'mech', name: 'Отдел главного механика', count: 1 },
      ],
      [
        { id: 'sm', name: SM.name, path: [OBJ] },
        { id: 'mech', name: 'Отдел главного механика', path: [OBJ, SM] },
      ],
    );
    expect(shape(tree)).toEqual([{ 'Объект [серый]': [{ '(СМ) Служба Механизации (1)': ['Отдел главного механика (1)'] }] }]);

    // Тот же случай в обратном порядке: сначала пункт-ребёнок создал предка серым.
    const reversed = buildBranchTree(
      [
        { id: 'mech', name: 'Отдел главного механика', count: 1 },
        { id: 'sm', name: SM.name, count: 2 },
      ],
      [
        { id: 'mech', name: 'Отдел главного механика', path: [OBJ, SM] },
        { id: 'sm', name: SM.name, path: [OBJ] },
      ],
    );
    expect(shape(reversed)).toEqual([{ 'Объект [серый]': [{ '(СМ) Служба Механизации (2)': ['Отдел главного механика (1)'] }] }]);
  });

  it('без предков (прежний сервер) — плоский список пунктов', () => {
    const tree = buildBranchTree(
      [{ id: 'line', name: 'ЛИНИЯ', count: 8 }, { id: 'sklad', name: 'Склад', count: 0 }],
      [{ id: 'line', name: 'ЛИНИЯ' }, { id: 'sklad', name: 'Склад' }],
    );
    expect(shape(tree)).toEqual(['ЛИНИЯ (8)', 'Склад (0)']);
    expect(tree.every(node => node.in_scope === true && node.parent_id === null)).toBe(true);
  });

  it('пустой список — пустое дерево', () => {
    expect(buildBranchTree([], [])).toEqual([]);
  });
});
