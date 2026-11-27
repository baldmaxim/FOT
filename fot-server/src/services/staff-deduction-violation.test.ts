import { describe, expect, it } from 'vitest';

import { EMPTY_VIOLATION, resolveViolationFields } from './staff-deduction-violation.js';

// Место и дата нарушения (миграция 383): у вида с признаком обязательны объект и дата; прежние строки вида без них
// правятся как раньше; у прочих видов поля не хранятся.

const OBJECT_ID = '0b8e6c1e-4f53-4f0b-9a3c-2a1f7b9d8e10';
const FILLED = { violation_object_id: OBJECT_ID, violation_place: 'корпус 2', violation_date: '2026-11-25' };
const TB_KIND = 7;

describe('resolveViolationFields', () => {
  it('вид без признака — поля не хранятся, даже если присланы', () => {
    expect(resolveViolationFields(false, 5, FILLED)).toEqual(EMPTY_VIOLATION);
  });

  it('вид с признаком: объект и дата есть — записываются (уточнение необязательно)', () => {
    expect(resolveViolationFields(true, TB_KIND, FILLED)).toEqual(FILLED);
    const noNote = { ...FILLED, violation_place: null };
    expect(resolveViolationFields(true, TB_KIND, noNote)).toEqual(noNote);
  });

  it('добавление без объекта или без даты — place_required', () => {
    expect(resolveViolationFields(true, TB_KIND, EMPTY_VIOLATION)).toBe('place_required');
    expect(resolveViolationFields(true, TB_KIND, { ...FILLED, violation_object_id: null })).toBe('place_required');
    expect(resolveViolationFields(true, TB_KIND, { ...FILLED, violation_date: null })).toBe('place_required');
  });

  it('прежняя строка того же вида без места и даты — правится пустой', () => {
    const before = { ...EMPTY_VIOLATION, kind_id: TB_KIND };
    expect(resolveViolationFields(true, TB_KIND, EMPTY_VIOLATION, before)).toEqual(EMPTY_VIOLATION);
  });

  it('прежняя строка: начали заполнять (уточнение или дата) — нужны и объект, и дата', () => {
    const before = { ...EMPTY_VIOLATION, kind_id: TB_KIND };
    expect(resolveViolationFields(true, TB_KIND, { ...EMPTY_VIOLATION, violation_place: 'корпус 2' }, before)).toBe('place_required');
    expect(resolveViolationFields(true, TB_KIND, { ...EMPTY_VIOLATION, violation_date: '2026-11-25' }, before)).toBe('place_required');
  });

  it('строку с местом очистить нельзя; смена вида на вид с признаком — заполнить обязательно', () => {
    expect(resolveViolationFields(true, TB_KIND, EMPTY_VIOLATION, { ...FILLED, kind_id: TB_KIND })).toBe('place_required');
    expect(resolveViolationFields(true, TB_KIND, EMPTY_VIOLATION, { ...EMPTY_VIOLATION, kind_id: 5 })).toBe('place_required');
  });
});
