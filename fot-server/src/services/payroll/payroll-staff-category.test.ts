import { describe, expect, it } from 'vitest';

import { createStaffCategoryResolver } from './payroll-staff-category.js';

const SU10_ROOT_ID = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const SM_ROOT_ID = '6c4a3726-4ba9-4550-9978-c5ff50e4f77b';

/** Как на проде: СУ-10 → Департамент строительства → Строительный участок → Бригады / ЛИНИЯ / ЛИНИЯ-Общестрой. */
const DEPARTMENTS = [
  { id: 'root', parent_id: null, name: 'Объект', kind: 'object' },
  { id: SU10_ROOT_ID, parent_id: 'root', name: '(СУ-10) ООО СУ-10', kind: 'department' },
  { id: 'tender', parent_id: SU10_ROOT_ID, name: 'Тендерный отдел', kind: 'department' },
  { id: 'build', parent_id: SU10_ROOT_ID, name: 'Департамент строительства', kind: 'department' },
  { id: 'site', parent_id: 'build', name: 'Строительный участок', kind: 'department' },
  { id: 'brigades', parent_id: 'site', name: 'Бригады', kind: 'department' },
  { id: 'br-1', parent_id: 'brigades', name: 'бр.Тожидинов Ш.Р.У.', kind: 'brigade' },
  { id: 'electro', parent_id: 'brigades', name: 'Участок электромонтажных работ', kind: 'department' },
  { id: 'line', parent_id: 'site', name: 'ЛИНИЯ', kind: 'department' },
  { id: 'line-general', parent_id: 'site', name: ' ЛИНИЯ-Общестрой ', kind: 'department' },
  { id: 'line-child', parent_id: 'line-general', name: 'Участок 1', kind: 'department' },
  { id: 'warehouse', parent_id: 'site', name: 'Склад-снабжения', kind: 'department' },
  { id: SM_ROOT_ID, parent_id: 'root', name: '(СМ) Служба Механизации', kind: 'department' },
  { id: 'sm-auto', parent_id: SM_ROOT_ID, name: 'Отдел автотехники', kind: 'department' },
  { id: 'sm-br', parent_id: SM_ROOT_ID, name: 'бр.Механизаторы', kind: 'brigade' },
];

describe('createStaffCategoryResolver', () => {
  const categoryOf = createStaffCategoryResolver(DEPARTMENTS);

  it('бригады СУ-10 — рабочие, в том числе отдел без «бр.» в папке «Бригады»', () => {
    expect(categoryOf('br-1')).toBe('worker');
    expect(categoryOf('electro')).toBe('worker');
  });

  it('«ЛИНИЯ» и «ЛИНИЯ-Общестрой» с подотделами — ИТР', () => {
    expect(categoryOf('line')).toBe('itr');
    expect(categoryOf('line-general')).toBe('itr');
    expect(categoryOf('line-child')).toBe('itr');
  });

  it('остальные отделы СУ-10 и вся Служба механизации, включая её бригады, — офис', () => {
    expect(categoryOf('tender')).toBe('office');
    expect(categoryOf('warehouse')).toBe('office');
    expect(categoryOf('sm-auto')).toBe('office');
    expect(categoryOf('sm-br')).toBe('office');
  });

  it('без отдела или с неизвестным отделом — офис', () => {
    expect(categoryOf(null)).toBe('office');
    expect(categoryOf('missing')).toBe('office');
  });

  it('цикл parent_id не вешает подъём по предкам', () => {
    const looped = createStaffCategoryResolver([
      { id: 'a', parent_id: 'b', name: 'А', kind: 'department' },
      { id: 'b', parent_id: 'a', name: 'Б', kind: 'department' },
    ]);
    expect(looped('a')).toBe('office');
  });
});
