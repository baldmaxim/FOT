import { describe, expect, it } from 'vitest';

import type { IStaffDeductionKind } from '../services/staffDeductionService';
import {
  amountAfterKindChange,
  deductionDefaultAmount,
  kindRequiresPlaceDate,
  monthForDismissed,
  parseStaffDeduction,
  type IViolationDraft,
} from './staffDeductionForm';

/** Вид без признака «место и дата»: поля нарушения не нужны. */
const NO_PLACE: IViolationDraft = {
  requiresPlaceDate: false, objectId: null, place: '', date: '', legacyEmptyAllowed: false, todayIso: '2026-11-27',
};
const NO_VIOLATION = { violation_object_id: null, violation_place: null, violation_date: null };

const draft = { selected: true, kindId: 3, subkindId: null, month: '2026-10', amount: '5 000,5', violation: NO_PLACE };

describe('parseStaffDeduction', () => {
  it('сумма с пробелами и запятой → число, месяц и вид как есть; без подвида — null', () => {
    expect(parseStaffDeduction(draft)).toEqual({
      ok: true,
      payload: { kind_id: 3, subkind_id: null, month: '2026-10', amount: 5000.5, ...NO_VIOLATION },
    });
  });

  it('подвид уходит в запрос', () => {
    expect(parseStaffDeduction({ ...draft, subkindId: 9 })).toMatchObject({ ok: true, payload: { kind_id: 3, subkind_id: 9 } });
  });

  it('ошибка — по первому неверному полю', () => {
    expect(parseStaffDeduction({ ...draft, selected: false })).toMatchObject({ ok: false, field: 'employee' });
    expect(parseStaffDeduction({ ...draft, kindId: null })).toMatchObject({ ok: false, field: 'kind' });
    expect(parseStaffDeduction({ ...draft, month: '' })).toMatchObject({ ok: false, field: 'month' });
    expect(parseStaffDeduction({ ...draft, month: '2026-13' })).toMatchObject({ ok: false, field: 'month' });
    for (const amount of ['', '0', '-5', '10,555', 'abc']) {
      expect(parseStaffDeduction({ ...draft, amount }), amount).toMatchObject({ ok: false, field: 'amount' });
    }
  });
});

describe('parseStaffDeduction: место и дата нарушения (миграция 383)', () => {
  const OBJECT_ID = '0b8e6c1e-4f53-4f0b-9a3c-2a1f7b9d8e10';
  const tb = (over: Partial<IViolationDraft> = {}) => ({
    ...draft,
    violation: { ...NO_PLACE, requiresPlaceDate: true, objectId: OBJECT_ID, place: '', date: '2026-11-25', ...over },
  });

  it('объект и дата — в запрос; уточнение — сжатыми пробелами, пустое — null', () => {
    expect(parseStaffDeduction(tb({ place: '  корпус 2,   5 этаж ' }))).toMatchObject({
      ok: true,
      payload: { violation_object_id: OBJECT_ID, violation_place: 'корпус 2, 5 этаж', violation_date: '2026-11-25' },
    });
    expect(parseStaffDeduction(tb())).toMatchObject({ ok: true, payload: { violation_place: null } });
  });

  it('у вида без признака введённое не уходит', () => {
    const typed = { ...NO_PLACE, objectId: OBJECT_ID, place: 'корпус 2', date: '2026-11-25' };
    expect(parseStaffDeduction({ ...draft, violation: typed })).toMatchObject({ ok: true, payload: NO_VIOLATION });
  });

  it('нет объекта — «Выберите место», нет даты — «Укажите дату», дата позже сегодня — нельзя', () => {
    expect(parseStaffDeduction(tb({ objectId: null }))).toEqual({ ok: false, field: 'object', message: 'Выберите место нарушения' });
    expect(parseStaffDeduction(tb({ date: '' }))).toEqual({ ok: false, field: 'date', message: 'Укажите дату нарушения' });
    expect(parseStaffDeduction(tb({ date: '2026-11-27' }))).toMatchObject({ ok: true });
    expect(parseStaffDeduction(tb({ date: '2026-11-28' }))).toEqual({
      ok: false, field: 'date', message: 'Дата нарушения не может быть позже сегодняшней',
    });
    expect(parseStaffDeduction(tb({ place: 'я'.repeat(201) }))).toMatchObject({ ok: false, field: 'place' });
  });

  it('прежняя строка без места: пустая — сохраняется; начали заполнять — нужно всё', () => {
    const legacy = { objectId: null, place: '', date: '', legacyEmptyAllowed: true };
    expect(parseStaffDeduction(tb(legacy))).toMatchObject({ ok: true, payload: NO_VIOLATION });
    expect(parseStaffDeduction(tb({ ...legacy, date: '2026-09-10' }))).toMatchObject({ ok: false, field: 'object' });
    expect(parseStaffDeduction(tb({ ...legacy, place: 'корпус 2' }))).toMatchObject({ ok: false, field: 'object' });
  });

  it('признак вида: есть — true; нет или вида нет — false', () => {
    const kinds: IStaffDeductionKind[] = [
      { id: 7, name: 'Нарушение техники безопасности', default_amount: null, requires_place_date: true, subkinds: [] },
      { id: 3, name: 'Штрафы', default_amount: null, subkinds: [] },
    ];
    expect(kindRequiresPlaceDate(kinds, 7)).toBe(true);
    expect(kindRequiresPlaceDate(kinds, 3)).toBe(false);
    expect(kindRequiresPlaceDate(kinds, null)).toBe(false);
  });
});

describe('amountAfterKindChange', () => {
  it('пусто или сумма прежнего вида — подставляется сумма нового', () => {
    expect(amountAfterKindChange('', null, '5000.00')).toBe('5000');
    expect(amountAfterKindChange('5000', '5000.00', '1500.50')).toBe('1500,5');
    expect(amountAfterKindChange('1500,5', '1500.50', null)).toBe('');
  });

  it('введённую руками сумму смена вида не трогает', () => {
    expect(amountAfterKindChange('700', '5000.00', '1500.50')).toBe('700');
    expect(amountAfterKindChange('700', null, '1500.50')).toBe('700');
  });
});

describe('сумма по умолчанию: подвид ?? вид', () => {
  const KINDS: IStaffDeductionKind[] = [
    {
      id: 4,
      name: 'Спецодежда',
      default_amount: '500.00',
      subkinds: [
        { id: 9, kind_id: 4, name: 'Каска', default_amount: '800.00' },
        { id: 10, kind_id: 4, name: 'Перчатки', default_amount: null },
      ],
    },
    { id: 6, name: 'Штрафы', default_amount: null, subkinds: [] },
  ];

  it('у подвида своя — она; у подвида нет — сумма вида; вида нет — null', () => {
    expect(deductionDefaultAmount(KINDS, 4, null)).toBe('500.00');
    expect(deductionDefaultAmount(KINDS, 4, 9)).toBe('800.00');
    expect(deductionDefaultAmount(KINDS, 4, 10)).toBe('500.00');
    expect(deductionDefaultAmount(KINDS, 6, null)).toBeNull();
    expect(deductionDefaultAmount(KINDS, null, null)).toBeNull();
  });

  it('вид 500 → подвид 800 → «Без подвида» снова 500; ручные 700 смена не затирает', () => {
    const step = (current: string, from: [number | null, number | null], to: [number | null, number | null]) =>
      amountAfterKindChange(current, deductionDefaultAmount(KINDS, ...from), deductionDefaultAmount(KINDS, ...to));
    const kind = step('', [null, null], [4, null]);
    expect(kind).toBe('500');
    const helmet = step(kind, [4, null], [4, 9]);
    expect(helmet).toBe('800');
    expect(step(helmet, [4, 9], [4, null])).toBe('500');

    expect(step('700', [4, null], [4, 9])).toBe('700');
    expect(step('700', [4, 9], [4, null])).toBe('700');
    expect(step('700', [4, 9], [6, null])).toBe('700');
  });
});

describe('monthForDismissed', () => {
  it('уволен 23.10: ноябрь → октябрь, октябрь и раньше — как были; работающий — без изменений', () => {
    expect(monthForDismissed('2026-11', '2026-10-23')).toBe('2026-10');
    expect(monthForDismissed('2026-12', '2026-10-23')).toBe('2026-10');
    expect(monthForDismissed('2026-10', '2026-10-23')).toBe('2026-10');
    expect(monthForDismissed('2026-08', '2026-10-23')).toBe('2026-08');
    expect(monthForDismissed('2026-11', null)).toBe('2026-11');
    expect(monthForDismissed('2026-11', undefined)).toBe('2026-11');
  });

  it('граница года: уволен 31.12.2026 — январь 2027 → декабрь 2026', () => {
    expect(monthForDismissed('2027-01', '2026-12-31')).toBe('2026-12');
    expect(monthForDismissed('2026-12', '2027-01-05')).toBe('2026-12');
  });
});
