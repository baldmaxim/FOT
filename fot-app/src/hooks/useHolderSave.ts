import { useState } from 'react';
import { useToast } from '../contexts/ToastContext';
import { contractorService, type IPassRow } from '../services/contractorService';
import { hasAnyDocs } from '../utils/contractorPassDocs';

/** Что делать с правкой ФИО держателя в строке пропуска (ЛК подрядчика, до подачи). */
export type HolderSaveDecision =
  | { kind: 'skip' }
  | { kind: 'invalid' }
  | { kind: 'save'; name: string | null; keepDocuments: boolean }
  | { kind: 'confirm'; mode: 'replace' | 'clear'; name: string | null };

export type HolderConfirmDecision = Extract<HolderSaveDecision, { kind: 'confirm' }>;

/** Выбор в окне: другой человек / опечатка / стереть / отмена. */
export type HolderChoice = 'other' | 'typo' | 'clear' | 'cancel';

const normName = (v: string | null | undefined): string =>
  (v ?? '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');

/**
 * Решение по правке ФИО. Окно нужно, только когда документы уже заполнены и ФИО
 * действительно меняется на другое или стирается; иначе сохраняем сразу, как раньше.
 * Зеркало holderChangeResetsDocuments на бэке (contractor-docs.service).
 */
export const decideHolderSave = (
  prevName: string | null,
  rawValue: string,
  hasDocs: boolean,
): HolderSaveDecision => {
  const value = rawValue.trim();
  if (value === (prevName ?? '')) return { kind: 'skip' };
  if (value && value.length < 2) return { kind: 'invalid' };
  const name = value || null;
  const prevEmpty = !(prevName ?? '').trim();
  if (!hasDocs || prevEmpty || (value && normName(prevName) === normName(value))) {
    return { kind: 'save', name, keepDocuments: false };
  }
  return { kind: 'confirm', mode: value ? 'replace' : 'clear', name };
};

/**
 * Ответ окна → действие. Отмена — вернуть прежнее ФИО в поле. Стирание ФИО очищает
 * документы всегда: флаг «оставить» для него не отправляется.
 */
export const resolveHolderChoice = (
  decision: HolderConfirmDecision,
  choice: HolderChoice,
): { kind: 'revert' } | { kind: 'save'; name: string | null; keepDocuments: boolean } => {
  if (choice === 'cancel') return { kind: 'revert' };
  if (decision.mode === 'clear') return { kind: 'save', name: null, keepDocuments: false };
  return { kind: 'save', name: decision.name, keepDocuments: choice === 'typo' };
};

interface IUseHolderSaveArgs {
  /** Обёртка страницы: busy, toast ошибки, обновление списков. */
  run: (fn: () => Promise<void>, okMsg?: string) => Promise<void>;
  /** Сброс локальной правки поля ФИО (вернуть значение с сервера). */
  revert: (passId: string) => void;
}

export const useHolderSave = ({ run, revert }: IUseHolderSaveArgs) => {
  const toast = useToast();
  const [pending, setPending] = useState<{ pass: IPassRow; decision: HolderConfirmDecision } | null>(null);

  const save = (passId: string, name: string | null, keepDocuments: boolean) =>
    run(() => contractorService.setPassHolder(passId, name, keepDocuments));

  const saveHolder = async (p: IPassRow, rawValue: string): Promise<void> => {
    const decision = decideHolderSave(p.holder_name, rawValue, hasAnyDocs(p));
    if (decision.kind === 'skip') return;
    if (decision.kind === 'invalid') {
      toast.error('ФИО — минимум 2 символа');
      return;
    }
    if (decision.kind === 'confirm') {
      setPending({ pass: p, decision });
      return;
    }
    await save(p.id, decision.name, decision.keepDocuments);
  };

  const resolveConfirm = async (choice: HolderChoice): Promise<void> => {
    if (!pending) return;
    const { pass, decision } = pending;
    setPending(null);
    const action = resolveHolderChoice(decision, choice);
    if (action.kind === 'revert') {
      revert(pass.id);
      return;
    }
    await save(pass.id, action.name, action.keepDocuments);
  };

  return { saveHolder, pendingConfirm: pending, resolveConfirm };
};
