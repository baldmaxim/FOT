import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { PAYROLL_SUMMARY_KEYS } from '../services/payrollSummaryService';
import { BRIGADE_OUTPUTS_QUERY_KEY, invalidateBrigadeOutputs } from './brigadeSalaryCache';
import { calcColumnsQueryKey } from './payrollCalcPages';

// После смены КТУ 1,0 → 1,4 (и «Доли», выработки) нигде не должен остаться прежний расчёт: ключи — настоящие ключи экранов.
describe('invalidateBrigadeOutputs — что перечитать после правки КТУ, «Доли» и выработки', () => {
  const SCREEN_KEYS = {
    'Зарплата по объектам': ['timesheet-salary', 'b1', '2026-10'],
    'стрелка «Бригад»': ['timesheet-salary', 'brigade-objects', 'b1', '2026-10'],
    'сводка «Объекты»': ['timesheet-salary', 'objects-summary', '2026-10'],
    'список «Бригады»': [BRIGADE_OUTPUTS_QUERY_KEY, '2026-10'],
    '«Расчёты»': [...calcColumnsQueryKey({ ids: [913], months: ['2026-10'] } as Parameters<typeof calcColumnsQueryKey>[0])],
    '«Свод»': [...PAYROLL_SUMMARY_KEYS.data('2026-10')],
  };

  it('все экраны с долями бригад — устаревшие; чужие ключи не трогаются', async () => {
    const client = new QueryClient();
    for (const key of Object.values(SCREEN_KEYS)) client.setQueryData(key, { cached: true });
    client.setQueryData(['payroll-summary', 'months'], ['2026-10']);
    client.setQueryData(['my-payslip', 'month', '2026-10'], { cached: true });

    await invalidateBrigadeOutputs(client);

    for (const [screen, key] of Object.entries(SCREEN_KEYS)) {
      expect(client.getQueryState(key)?.isInvalidated, screen).toBe(true);
    }
    expect(client.getQueryState(['payroll-summary', 'months'])?.isInvalidated).toBe(false);
    expect(client.getQueryState(['my-payslip', 'month', '2026-10'])?.isInvalidated).toBe(false);
  });
});
