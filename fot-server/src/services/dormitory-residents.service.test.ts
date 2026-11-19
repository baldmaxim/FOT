import { beforeEach, describe, expect, it, vi } from 'vitest';

// Сведения о жильцах «Проживания» (миграция 371): паспорт наружу — только последние 4 знака; «Начальник участка» —
// правило «Участка» «Управления кадрами», иначе руководители отдела. «Компенсация аренды»: дни из расчёта ФОТ.

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../config/postgres.js', () => ({ query: db.query }));

vi.mock('./hr-crypto.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./hr-crypto.service.js')>()),
  decryptFieldSafe: (enc: string | null) => (enc ? enc.replace('enc:', '') : null),
}));

const site = vi.hoisted(() => ({ loadStaffSiteIndex: vi.fn(), staffSiteLabel: vi.fn() }));
vi.mock('./staff-site.service.js', () => site);
const managers = vi.hoisted(() => ({ listDepartmentManagers: vi.fn() }));
vi.mock('./department-managers.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./department-managers.service.js')>()),
  listDepartmentManagers: managers.listDepartmentManagers,
}));

import { compensationFromCalc } from './dormitory-compensation.service.js';
import { loadMaskedPassports, loadSupervisorLabels } from './dormitory-residents.service.js';

beforeEach(() => vi.clearAllMocks());

describe('паспорт', () => {
  it('наружу — только последние 4 знака; полного номера в ответе нет', async () => {
    db.query.mockResolvedValue([
      { employee_id: 1, passport_number_enc: 'enc:FA3762158' },
      { employee_id: 2, passport_number_enc: 'enc:4622863148' },
    ]);
    const result = await loadMaskedPassports([1, 2, 2]);
    expect(result).toEqual(new Map([[1, '•••••2158'], [2, '••••••3148']]));
    for (const value of result.values()) {
      expect(value).not.toMatch(/FA3762158|4622863148/);
    }
    expect(db.query.mock.calls[0][1]).toEqual([[1, 2]]);
  });

  it('пустой список — без запроса', async () => {
    expect(await loadMaskedPassports([])).toEqual(new Map());
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('начальник участка', () => {
  it('«Участок» «Управления кадрами», иначе руководители отдела по алфавиту; никого — нет в ответе', async () => {
    site.loadStaffSiteIndex.mockResolvedValue({});
    site.staffSiteLabel.mockImplementation((_index: unknown, employeeId: number) => (employeeId === 1 ? 'Остапюк Д. И.' : null));
    managers.listDepartmentManagers.mockResolvedValue(new Map([['auto', [11, 10]]]));
    db.query.mockResolvedValue([
      { id: 10, full_name: 'Северин Дмитрий Глебович' },
      { id: 11, full_name: 'Аверин Пётр Ильич' },
    ]);
    const result = await loadSupervisorLabels([
      { employee_id: 1, org_department_id: 'brigade' },
      { employee_id: 2, org_department_id: 'auto' },
      { employee_id: 3, org_department_id: null },
      { employee_id: 4, org_department_id: 'empty' },
    ]);
    expect(managers.listDepartmentManagers).toHaveBeenCalledWith(['auto', 'empty']);
    expect(result).toEqual(new Map([[1, 'Остапюк Д. И.'], [2, 'Аверин П. И., Северин Д. Г.']]));
  });
});

describe('«Компенсация аренды» — дни и сумма из расчёта', () => {
  const calc = (housing: Record<string, unknown> | null, state = 'closed') => ({
    state, rate_allowances: housing ? [{ code: 'housing', ...housing }] : [{ code: 'travel', amount: '2730.00' }],
  }) as never;

  it('выходные урезаны потолком — показываем выходные месяца, как 1С (Абдурахманов С., октябрь: 7 + 27 → 19 530)', () => {
    expect(compensationFromCalc(calc({ amount: '19530.00', housing_days: 31, housing_weekend_days: 4, housing_month_weekends: 7 })))
      .toEqual({ month_amount: '19530.00', worked_days: 27, weekend_days: 7 });
  });

  it('без потолка (Ашуров: 20 + 7 → 17 010), без выходных, не работал, не посчитан', () => {
    expect(compensationFromCalc(calc({ amount: '17010.00', housing_days: 27, housing_weekend_days: 7 })))
      .toEqual({ month_amount: '17010.00', worked_days: 20, weekend_days: 7 });
    expect(compensationFromCalc(calc({ amount: '3780.00', housing_days: 6 })))
      .toEqual({ month_amount: '3780.00', worked_days: 6, weekend_days: 0 });
    expect(compensationFromCalc(calc(null))).toEqual({ month_amount: '0.00', worked_days: 0, weekend_days: 0 });
    expect(compensationFromCalc(calc({ amount: '1.00' }, 'not_closed')))
      .toEqual({ month_amount: null, worked_days: null, weekend_days: null });
    expect(compensationFromCalc(undefined)).toEqual({ month_amount: null, worked_days: null, weekend_days: null });
  });
});
