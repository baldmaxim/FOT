import { describe, expect, it } from 'vitest';
import { displayFieldValue, fmtSnils } from './hrFormat';

describe('fmtSnils', () => {
  it('разбивает 11 цифр по группам', () => {
    expect(fmtSnils('21697763310')).toBe('216-977-633 10');
  });

  it('маскированное значение не трогает', () => {
    // Сервер отдаёт маску как '•'.repeat(len - 4) + последние 4 цифры.
    expect(fmtSnils('•••••••3310')).toBe('•••••••3310');
  });

  it('не форматирует строку неверной длины', () => {
    expect(fmtSnils('2169776331')).toBe('2169776331');
  });
});

describe('displayFieldValue для snils', () => {
  it('форматирует полный номер', () => {
    expect(displayFieldValue('snils', '21697763310', undefined)).toBe('216-977-633 10');
  });

  it('пустое значение даёт прочерк', () => {
    expect(displayFieldValue('snils', null, undefined)).toBe('—');
  });
});
