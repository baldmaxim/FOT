import { describe, expect, it } from 'vitest';

import { payrollDepartmentGroupIds } from './payroll-department-groups.js';

// Структура как на проде: технический корень «Объект» → СУ-10 и СМ (фиксированные id), бригады внутри компаний.
const TECH = 'tech';
const SU10 = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const SM = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';
const DEPARTMENTS = [
  { id: TECH, parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10, parent_id: TECH, name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'build', parent_id: SU10, name: 'Департамент строительства', kind: 'department' },
  { id: 'linia', parent_id: 'build', name: 'ЛИНИЯ', kind: 'department' },
  { id: 'linia-site', parent_id: 'linia', name: 'Участок 1', kind: 'department' },
  { id: 'obshchestroy', parent_id: 'build', name: ' линия-общестрой ', kind: 'department' },
  { id: 'brigades', parent_id: 'build', name: 'Бригады', kind: 'department' },
  { id: 'brigade-1', parent_id: 'brigades', name: 'бр.Иванов', kind: 'brigade' },
  { id: 'guarantee', parent_id: SU10, name: 'Гарантийный отдел', kind: 'department' },
  { id: 'finance', parent_id: SU10, name: 'Финансовый департамент', kind: 'department' },
  { id: SM, parent_id: TECH, name: '(СМ) Служба Механизации', kind: 'department' },
  { id: 'sm-gpm', parent_id: SM, name: 'ГПМ', kind: 'department' },
  { id: 'sm-brigade', parent_id: SM, name: 'бр.Механики', kind: 'brigade' },
  { id: 'contractors', parent_id: TECH, name: 'Подрядные организации', kind: 'department' },
  { id: 'contractor-co', parent_id: 'contractors', name: 'ООО Подрядчик', kind: 'department' },
];

describe('payrollDepartmentGroupIds', () => {
  const groups = payrollDepartmentGroupIds(DEPARTMENTS);

  it('ИТР — ЛИНИЯ и ЛИНИЯ-Общестрой с подотделами', () => {
    expect(groups.itr.sort()).toEqual(['linia', 'linia-site', 'obshchestroy']);
  });

  it('Рабочие — все бригады, СУ-10 и СМ', () => {
    expect(groups.worker.sort()).toEqual(['brigade-1', 'brigades', 'sm-brigade']);
  });

  it('Офис — остальные отделы СУ-10; СМ, подрядчики и корень — ни в одной группе', () => {
    expect(groups.office.sort()).toEqual([SU10, 'build', 'finance', 'guarantee'].sort());
    const all = new Set([...groups.itr, ...groups.office, ...groups.worker]);
    for (const id of [SM, 'sm-gpm', 'contractors', 'contractor-co', TECH]) expect(all.has(id)).toBe(false);
  });

  it('группы не пересекаются', () => {
    const ids = [...groups.itr, ...groups.office, ...groups.worker];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
