import { describe, expect, it } from 'vitest';
import { isWrittenByApproval } from './useCorrectionSourceRequest';

describe('isWrittenByApproval', () => {
  const reviewedAt = '2026-08-17T14:08:17.964Z';

  it('запись корректировки в момент согласования — да', () => {
    expect(isWrittenByApproval('2026-08-17T14:08:18.017Z', reviewedAt)).toBe(true);
  });

  it('допуск — минута: позже это уже правка в табеле', () => {
    expect(isWrittenByApproval('2026-08-17T14:08:45.000Z', reviewedAt)).toBe(true);
    expect(isWrittenByApproval('2026-08-17T14:09:30.000Z', reviewedAt)).toBe(false);
  });

  it('нет времени корректировки — нет', () => {
    expect(isWrittenByApproval(null, reviewedAt)).toBe(false);
    expect(isWrittenByApproval(undefined, reviewedAt)).toBe(false);
  });
});
