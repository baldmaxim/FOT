import { describe, it, expect } from 'vitest';
import { decideHolderSave, resolveHolderChoice, type HolderConfirmDecision } from './useHolderSave';

describe('decideHolderSave', () => {
  it('ничего не изменилось — пропуск', () => {
    expect(decideHolderSave('Иванов Иван', 'Иванов Иван ', true)).toEqual({ kind: 'skip' });
  });

  it('короче 2 символов — ошибка', () => {
    expect(decideHolderSave(null, 'И', false)).toEqual({ kind: 'invalid' });
  });

  it('документов нет — сохранить сразу, без окна', () => {
    expect(decideHolderSave('Иванов Иван', 'Петров Пётр', false))
      .toEqual({ kind: 'save', name: 'Петров Пётр', keepDocuments: false });
  });

  it('первичное назначение (ФИО не было) — сразу, документы не трогаются', () => {
    expect(decideHolderSave(null, 'Петров Пётр', true))
      .toEqual({ kind: 'save', name: 'Петров Пётр', keepDocuments: false });
  });

  it('то же ФИО в другом написании — сразу', () => {
    expect(decideHolderSave('Иванов Пётр', 'иванов петр', true))
      .toEqual({ kind: 'save', name: 'иванов петр', keepDocuments: false });
  });

  it('другое ФИО при заполненных документах — окно «replace»', () => {
    expect(decideHolderSave('Иванов Иван', 'Петров Пётр', true))
      .toEqual({ kind: 'confirm', mode: 'replace', name: 'Петров Пётр' });
  });

  it('ФИО стёрто при заполненных документах — окно «clear»', () => {
    expect(decideHolderSave('Иванов Иван', '  ', true))
      .toEqual({ kind: 'confirm', mode: 'clear', name: null });
  });
});

describe('resolveHolderChoice', () => {
  const replace: HolderConfirmDecision = { kind: 'confirm', mode: 'replace', name: 'Петров Пётр' };
  const clear: HolderConfirmDecision = { kind: 'confirm', mode: 'clear', name: null };

  it('другой человек → keep_documents=false', () => {
    expect(resolveHolderChoice(replace, 'other')).toEqual({ kind: 'save', name: 'Петров Пётр', keepDocuments: false });
  });

  it('опечатка → keep_documents=true', () => {
    expect(resolveHolderChoice(replace, 'typo')).toEqual({ kind: 'save', name: 'Петров Пётр', keepDocuments: true });
  });

  it('очистка ФИО → сброс при любом выборе, кроме отмены', () => {
    expect(resolveHolderChoice(clear, 'clear')).toEqual({ kind: 'save', name: null, keepDocuments: false });
    expect(resolveHolderChoice(clear, 'typo')).toEqual({ kind: 'save', name: null, keepDocuments: false });
  });

  it('отмена → вернуть прежнее значение в поле', () => {
    expect(resolveHolderChoice(replace, 'cancel')).toEqual({ kind: 'revert' });
    expect(resolveHolderChoice(clear, 'cancel')).toEqual({ kind: 'revert' });
  });
});
