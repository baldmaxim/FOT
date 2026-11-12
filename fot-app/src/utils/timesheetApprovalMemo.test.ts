import { describe, expect, it } from 'vitest';

import { canDeleteApprovalMemo, isApprovalMemoEditable } from './timesheetApprovalMemo';

const UNLOCKED_AT = '2026-11-12T08:24:28.592Z';

describe('isApprovalMemoEditable', () => {
  it('подачи нет, черновик, отклонён, на доработке — можно', () => {
    expect(isApprovalMemoEditable(null)).toBe(true);
    for (const status of ['draft', 'rejected', 'returned'] as const) {
      expect(isApprovalMemoEditable({ status, unlocked_at: null })).toBe(true);
    }
  });

  it('подан или согласован — только когда табель открыт', () => {
    for (const status of ['submitted', 'approved'] as const) {
      expect(isApprovalMemoEditable({ status, unlocked_at: null })).toBe(false);
      expect(isApprovalMemoEditable({ status, unlocked_at: UNLOCKED_AT })).toBe(true);
    }
  });
});

describe('canDeleteApprovalMemo', () => {
  const opened = { status: 'approved' as const, unlocked_at: UNLOCKED_AT };

  it('открытый табель: только служебка с deletable === true', () => {
    expect(canDeleteApprovalMemo(opened, { kind: 'weekend_memo', deletable: true })).toBe(true);
    expect(canDeleteApprovalMemo(opened, { kind: 'weekend_memo', deletable: false })).toBe(false);
    // Старый бэкенд поля не шлёт — корзины у служебок до открытия нет.
    expect(canDeleteApprovalMemo(opened, { kind: 'weekend_memo' })).toBe(false);
  });

  it('черновик: как раньше, без поля — можно', () => {
    const draft = { status: 'draft' as const, unlocked_at: null };
    expect(canDeleteApprovalMemo(draft, { kind: 'weekend_memo' })).toBe(true);
    expect(canDeleteApprovalMemo(draft, { kind: 'weekend_memo', deletable: false })).toBe(false);
  });

  it('согласованный без открытия и файлы корректировок — никогда', () => {
    expect(canDeleteApprovalMemo({ status: 'approved', unlocked_at: null }, { kind: 'weekend_memo', deletable: true })).toBe(false);
    expect(canDeleteApprovalMemo(opened, { kind: 'correction', deletable: true })).toBe(false);
  });
});
