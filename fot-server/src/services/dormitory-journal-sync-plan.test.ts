import { describe, expect, it } from 'vitest';

import {
  applyJournalOperations,
  planDormitoryJournalSync,
  type IDormitoryJournal,
  type IJournalCard,
  type IJournalStay,
  type JournalSyncOperation,
} from './dormitory-journal-sync-plan.js';

// Журналы 1С 24.11.2026: с 01.11 — как в 1С (выезд — дата 1С), въезд-заглушка 01.09 → настоящий заезд,
// сентябрь–октябрь не трогаются, Мытищи — только выезды, повтор на итоге — пустой план.

const OPTIONS = { fileDate: '2026-11-24', from: '2026-11-01', realCheckInBefore: '2026-09-01' };
const A = 'Общ. Нагатинская 34';
const B = 'Общ. Мал.Почтовая 2\\2';
const M = 'Общ. База Мытищи';
const R = 'Общ. г.Химки, ул.Рабочая д.2а';

const card = (id: number, fullName: string, over: Partial<IJournalCard> = {}): IJournalCard => ({
  id, fullName, employmentStatus: 'active', hireDate: '2024-01-10', dismissalDate: null, ...over,
});
let nextStayId = 1000;
const stay = (employeeId: number, address: string, checkIn = '2026-09-01', checkOut: string | null = null, over: Partial<IJournalStay> = {}): IJournalStay => ({
  id: nextStayId++, employeeId, kind: 'dormitory', apartmentId: null, address, checkIn, checkOut, ...over,
});
const journal = (dormitory: string, over: Partial<IDormitoryJournal> = {}): IDormitoryJournal => ({
  dormitory, checkIns: [], checkOuts: [], residents: [], ...over,
});
const updateOf = (ops: readonly JournalSyncOperation[], stayId: number) => ops.find(op => op.kind === 'update' && op.stayId === stayId);
const addsOf = (ops: readonly JournalSyncOperation[], employeeId: number) => ops.filter(op => op.kind === 'add' && op.employeeId === employeeId);

describe('общежития по журналам 1С', () => {
  const cards = [
    card(1, 'Выезд Как Вединице'),
    card(2, 'Поздний Приём', { hireDate: '2026-04-21' }),
    card(3, 'Давний Житель'),
    card(4, 'Уехал Воктябре'),
    card(5, 'Ноябрьский Заезд'),
    card(6, 'Переехал Вноябре'),
    card(7, 'Вернулся Снова'),
    card(8, 'Нет Впортале'),
    card(9, 'Нет Вединице'),
    card(100, 'Переоформлен Один', { employmentStatus: 'fired', hireDate: '2026-05-17', dismissalDate: '2026-11-02' }),
    card(101, 'Переоформлен Один', { hireDate: '2026-10-15' }),
    card(110, 'Переоформлен Два', { employmentStatus: 'fired', hireDate: '2025-01-10', dismissalDate: '2026-11-10' }),
    card(111, 'Переоформлен Два', { hireDate: '2026-11-11' }),
    card(12, 'Мытищи Выезд'),
    card(13, 'Мытищи Раньше'),
    card(14, 'Рабочая Живёт'),
    card(15, 'Сентябрь Расходится'),
  ];
  const stays = {
    s1: stay(1, A, '2026-09-01', '2026-11-19'),
    s2: stay(2, A),
    s3: stay(3, A),
    s4: stay(4, A, '2026-09-01', '2026-11-19'),
    s5: stay(5, B, '2026-11-19'),
    s6a: stay(6, A, '2026-09-01', '2026-11-19'),
    s6b: stay(6, B, '2026-11-19'),
    s7: stay(7, A),
    s9: stay(9, A),
    s100: stay(100, A, '2026-09-01', '2026-11-03'),
    s110: stay(110, A, '2026-09-01', '2026-11-11'),
    s12: stay(12, M),
    s13: stay(13, M),
    s14: stay(14, R),
    s15: stay(15, A),
  };
  const journals = [
    journal(A, {
      checkIns: [
        { date: '2026-03-06', fullName: 'Выезд  как вединице' },
        { date: '2026-04-09', fullName: 'Поздний Приём' },
        { date: '2026-05-01', fullName: 'Уехал Воктябре' },
        { date: '2026-06-01', fullName: 'Переехал Вноябре' },
        { date: '2026-07-01', fullName: 'Вернулся Снова' },
        { date: '2026-11-11', fullName: 'Вернулся Снова' },
        { date: '2026-04-28', fullName: 'Переоформлен Один' },
        { date: '2026-03-01', fullName: 'Переоформлен Два' },
        { date: '2026-09-29', fullName: 'Сентябрь Расходится' },
      ],
      checkOuts: [
        { date: '2026-11-16', fullName: 'Выезд Как Вединице' },
        { date: '2026-10-31', fullName: 'Уехал Воктябре' },
        { date: '2026-11-03', fullName: 'Переехал Вноябре' },
        { date: '2026-11-05', fullName: 'Вернулся Снова' },
        { date: '2026-11-02', fullName: 'Переоформлен Один' },
      ],
      residents: ['Поздний Приём', 'Давний Житель', 'Вернулся Снова', 'Переоформлен Два', 'Сентябрь Расходится'],
    }),
    journal(B, {
      checkIns: [
        { date: '2026-11-02', fullName: 'Ноябрьский Заезд' },
        { date: '2026-11-03', fullName: 'Переехал Вноябре' },
        { date: '2026-11-05', fullName: 'Нет Впортале' },
      ],
      checkOuts: [{ date: '2026-11-10', fullName: 'Нет Впортале' }],
      residents: ['Ноябрьский Заезд', 'Переехал Вноябре'],
    }),
    journal(M, {
      checkIns: null,
      residents: null,
      checkOuts: [{ date: '2026-11-07', fullName: 'Мытищи Выезд' }, { date: '2026-08-02', fullName: 'Мытищи Раньше' }],
    }),
  ];
  const all = Object.values(stays);
  const plan = planDormitoryJournalSync(journals, cards, all, OPTIONS);

  it('выезд — дата 1С, въезд 01.09 → настоящий заезд (не раньше приёма карточки)', () => {
    expect(updateOf(plan.operations, stays.s1.id)).toMatchObject({ after: { checkIn: '2026-03-06', checkOut: '2026-11-16' } });
    expect(updateOf(plan.operations, stays.s2.id)).toMatchObject({ after: { checkIn: '2026-04-21', checkOut: null } });
    expect(updateOf(plan.operations, stays.s3.id)).toBeUndefined();
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'check_in_unknown', employeeId: 3 }));
  });

  it('уехал до ноября — выезд 01.11 (октябрь не трогаем); день 31.10 расходится — въезд не меняем', () => {
    expect(updateOf(plan.operations, stays.s4.id)).toMatchObject({ after: { checkIn: '2026-09-01', checkOut: '2026-11-01' } });
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'sep_oct_mismatch', employeeId: 4 }));
  });

  it('ноябрьские записи — даты 1С; переезд и возврат внутри ноября', () => {
    expect(updateOf(plan.operations, stays.s5.id)).toMatchObject({ after: { checkIn: '2026-11-02', checkOut: null } });
    expect(updateOf(plan.operations, stays.s6a.id)).toMatchObject({ after: { checkIn: '2026-06-01', checkOut: '2026-11-03' } });
    expect(updateOf(plan.operations, stays.s6b.id)).toMatchObject({ after: { checkIn: '2026-11-03', checkOut: null } });
    expect(updateOf(plan.operations, stays.s7.id)).toMatchObject({ after: { checkIn: '2026-07-01', checkOut: '2026-11-05' } });
    expect(addsOf(plan.operations, 7)).toEqual([expect.objectContaining({ address: A, checkIn: '2026-11-11', checkOut: null })]);
  });

  it('нет в портале — заселить; нет в 1С — закрыть 01.11', () => {
    expect(addsOf(plan.operations, 8)).toEqual([expect.objectContaining({ address: B, checkIn: '2026-11-05', checkOut: '2026-11-10' })]);
    const closed = updateOf(plan.operations, stays.s9.id);
    expect(closed).toMatchObject({ after: { checkIn: '2026-09-01', checkOut: '2026-11-01' } });
    expect(closed && closed.kind === 'update' ? closed.why.join() : '').toContain('нет');
  });

  it('переоформление: запись остаётся на своей карточке, дальше — новая карточка', () => {
    expect(updateOf(plan.operations, stays.s100.id)).toMatchObject({ after: { checkIn: '2026-05-17', checkOut: '2026-11-02' } });
    expect(addsOf(plan.operations, 101)).toEqual([]);
    expect(updateOf(plan.operations, stays.s110.id)).toMatchObject({ after: { checkIn: '2026-03-01', checkOut: '2026-11-11' } });
    expect(addsOf(plan.operations, 111)).toEqual([expect.objectContaining({ address: A, checkIn: '2026-11-11', checkOut: null })]);
  });

  it('Мытищи — только выезд внутри записи; без файлов — не трогаем; сентябрь не правим', () => {
    expect(updateOf(plan.operations, stays.s12.id)).toMatchObject({ after: { checkIn: '2026-09-01', checkOut: '2026-11-07' } });
    expect(updateOf(plan.operations, stays.s13.id)).toBeUndefined();
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'partial_out_skipped', employeeId: 13 }));
    expect(updateOf(plan.operations, stays.s14.id)).toBeUndefined();
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'untouched', employeeId: 14 }));
    expect(updateOf(plan.operations, stays.s15.id)).toBeUndefined();
    expect(plan.notes).toContainEqual(expect.objectContaining({ kind: 'sep_oct_mismatch', employeeId: 15 }));
  });

  it('до 01.11 меняется только въезд-заглушка; итог без пересечений; повтор — пустой план', () => {
    for (const op of plan.operations) {
      if (op.kind !== 'update') expect(op.checkIn >= OPTIONS.from).toBe(true);
    }
    const again = planDormitoryJournalSync(journals, cards, applyJournalOperations(all, plan.operations), OPTIONS);
    expect(again.operations).toEqual([]);
    expect(plan.residents.get(A)).toBe(5);
  });
});

describe('общежития по журналам 1С: стоп', () => {
  const cards = [card(1, 'Иванов Иван'), card(2, 'Петров Пётр')];

  it('житель списка без карточки', () => {
    const journals = [journal(A, { residents: ['Сидоров Сидор'] })];
    expect(() => planDormitoryJournalSync(journals, cards, [], OPTIONS)).toThrow(/карточки нет/);
  });

  it('заезд без выезда, но нет в «Проживают»', () => {
    const journals = [journal(A, { checkIns: [{ date: '2026-11-05', fullName: 'Иванов Иван' }], residents: [] })];
    expect(() => planDormitoryJournalSync(journals, cards, [], OPTIONS)).toThrow(/нет в «Проживают»/);
  });

  it('два общежития в один день после 01.11', () => {
    const journals = [
      journal(A, { checkIns: [{ date: '2026-11-02', fullName: 'Иванов Иван' }], residents: ['Иванов Иван'] }),
      journal(B, { checkIns: [{ date: '2026-11-05', fullName: 'Иванов Иван' }], residents: ['Иванов Иван'] }),
    ];
    expect(() => planDormitoryJournalSync(journals, cards, [], OPTIONS)).toThrow(/пересекаются/);
  });

  it('заселение поверх квартиры', () => {
    const journals = [journal(A, { checkIns: [{ date: '2026-11-05', fullName: 'Петров Пётр' }], residents: ['Петров Пётр'] })];
    const apartment = stay(2, 'Кв. Ленина 1', '2026-10-01', null, { kind: 'apartment' });
    expect(() => planDormitoryJournalSync(journals, cards, [apartment], OPTIONS)).toThrow(/пересекаются проживания/);
  });
});
