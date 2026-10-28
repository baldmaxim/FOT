import { describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';

import { invalidateDeductionQueries } from './deductionQueries';

describe('invalidateDeductionQueries', () => {
  it('правка удержания перечитывает и «Расчёты» (столбцы ФОТ под payroll-terms)', async () => {
    const invalidateQueries = vi.fn(async () => undefined);
    await invalidateDeductionQueries({ invalidateQueries } as unknown as QueryClient);
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['payroll-terms'] });
  });
});
