import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import type { IResolvedExportMode } from '../timesheet-export-mode.service.js';
import { categoryByTimesheet, createLiniaResolver, isTimesheetWorker } from './payroll-staff-category.js';

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
  { id: 'line', parent_id: 'site', name: 'ЛИНИЯ', kind: 'department' },
  { id: 'line-general', parent_id: 'site', name: ' ЛИНИЯ-Общестрой ', kind: 'department' },
  { id: 'line-child', parent_id: 'line-general', name: 'Участок 1', kind: 'department' },
  { id: 'warehouse', parent_id: 'site', name: 'Склад-снабжения', kind: 'department' },
  { id: SM_ROOT_ID, parent_id: 'root', name: '(СМ) Служба Механизации', kind: 'department' },
  { id: 'sm-auto', parent_id: SM_ROOT_ID, name: 'Отдел автотехники', kind: 'department' },
];

describe('createLiniaResolver', () => {
  const isLinia = createLiniaResolver(DEPARTMENTS);

  it('«ЛИНИЯ» и «ЛИНИЯ-Общестрой» с подотделами — да', () => {
    expect(isLinia('line')).toBe(true);
    expect(isLinia('line-general')).toBe(true);
    expect(isLinia('line-child')).toBe(true);
  });

  it('бригады, остальные отделы СУ-10 и СМ, без отдела и неизвестный — нет', () => {
    for (const id of ['br-1', 'tender', 'warehouse', 'sm-auto', 'missing', null]) {
      expect(isLinia(id)).toBe(false);
    }
  });

  it('цикл parent_id не вешает подъём по предкам', () => {
    const looped = createLiniaResolver([
      { id: 'a', parent_id: 'b', name: 'А', kind: 'department' },
      { id: 'b', parent_id: 'a', name: 'Б', kind: 'department' },
    ]);
    expect(looped('a')).toBe(false);
  });
});

describe('categoryByTimesheet', () => {
  it('объект «Офис» — офис, даже у рабочего из ЛИНИИ', () => {
    expect(categoryByTimesheet({ officeObject: true, timesheetWorker: true, linia: true })).toBe('office');
  });

  it('рабочий табеля — рабочие, в том числе в ЛИНИИ', () => {
    expect(categoryByTimesheet({ officeObject: false, timesheetWorker: true, linia: true })).toBe('worker');
    expect(categoryByTimesheet({ officeObject: false, timesheetWorker: true, linia: false })).toBe('worker');
  });

  it('не рабочий: ЛИНИЯ — ИТР, остальные — офис (машинист СМ на стройке тоже)', () => {
    expect(categoryByTimesheet({ officeObject: false, timesheetWorker: false, linia: true })).toBe('itr');
    expect(categoryByTimesheet({ officeObject: false, timesheetWorker: false, linia: false })).toBe('office');
  });
});

describe('isTimesheetWorker', () => {
  const explicit = (mode: IResolvedExportMode['mode'], extra: Partial<IResolvedExportMode> = {}): IResolvedExportMode => ({
    mode, pinnedObjectId: mode === 'object' ? 'obj-1' : null, source: 'employee_explicit', ...extra,
  });

  it('эпоха авторасчёта, личный режим: рабочий — только skud/auto, правило рабочих не спрашивается', () => {
    expect(isTimesheetWorker({ resolved: explicit('skud', { setBy: 'auto' }), autoEra: true, workerRule: false })).toBe(true);
    // skud от админа (set_by NULL) — не правило рабочих.
    expect(isTimesheetWorker({ resolved: explicit('skud'), autoEra: true, workerRule: true })).toBe(false);
    // Объект по часам ночью — табель ведёт одним объектом.
    expect(isTimesheetWorker({ resolved: explicit('object', { setBy: 'auto' }), autoEra: true, workerRule: true })).toBe(false);
    // Закреплённый в окне — set_by NULL, не skud/auto.
    expect(isTimesheetWorker({ resolved: explicit('object', { windowPin: true }), autoEra: true, workerRule: true })).toBe(false);
  });

  it('до эпохи (июль, август) — правило рабочих по отделу месяца, кроме закреплённых в окне', () => {
    expect(isTimesheetWorker({ resolved: explicit('object'), autoEra: false, workerRule: true })).toBe(true);
    expect(isTimesheetWorker({ resolved: explicit('skud', { setBy: 'auto' }), autoEra: false, workerRule: false })).toBe(false);
    expect(isTimesheetWorker({ resolved: explicit('object', { windowPin: true }), autoEra: false, workerRule: true })).toBe(false);
  });

  it('без личного режима (новый сотрудник до первой ночи) — правило рабочих', () => {
    const legacy: IResolvedExportMode = { mode: 'skud', pinnedObjectId: null, source: 'legacy_default' };
    expect(isTimesheetWorker({ resolved: legacy, autoEra: true, workerRule: true })).toBe(true);
    expect(isTimesheetWorker({ resolved: legacy, autoEra: true, workerRule: false })).toBe(false);
    expect(isTimesheetWorker({ resolved: undefined, autoEra: true, workerRule: true })).toBe(true);
  });
});
