import { useMemo, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OtTrainingRow } from '../ot/OtTrainingRow';
import { isValidIsoDate, todayLocal } from '../ot/otShared';
import { useToast } from '../../contexts/ToastContext';
import {
  employeeInductionService,
  type IOtTrainingPatch,
} from '../../services/employeeInductionService';
import type { IEmployeeOtTrainingState } from '../../services/otTraining.types';
import contractorStyles from '../../pages/contractor/Contractor.module.css';
import otStyles from '../ot/Ot.module.css';
import styles from './EmployeeInductionTab.module.css';

interface IProps {
  employeeId: number;
  canEdit: boolean;
}

/**
 * Панель обучения по ОТ под строкой сотрудника: все виды регламента с датой,
 * сроком действия и просрочкой. Сохранение — сразу при вводе полной даты
 * (профессия у сквозных профессий — по уходу фокуса), как и в остальной таблице.
 */
export const EmployeeTrainingsPanel: FC<IProps> = ({ employeeId, canEdit }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyKind, setBusyKind] = useState<string | null>(null);

  const catalogQuery = useQuery({
    queryKey: ['ot-training-catalog', 'employee'],
    queryFn: () => employeeInductionService.otCatalog(),
    staleTime: Infinity,
  });

  const trainingsKey = ['employee-ot-trainings', employeeId] as const;
  const trainingsQuery = useQuery({
    queryKey: trainingsKey,
    queryFn: () => employeeInductionService.trainings(employeeId),
    staleTime: 10_000,
  });

  const byKind = useMemo(
    () => new Map((trainingsQuery.data ?? []).map(t => [t.kind, t])),
    [trainingsQuery.data],
  );

  const saveMutation = useMutation({
    mutationFn: (patch: IOtTrainingPatch) => employeeInductionService.setTraining(employeeId, patch),
    onSuccess: (data: IEmployeeOtTrainingState[]) => {
      queryClient.setQueryData(trainingsKey, data);
      // Счётчик «Пройдено N из M» и фильтр статуса считаются по вводному инструктажу.
      void queryClient.invalidateQueries({ queryKey: ['employee-induction'] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Не удалось сохранить обучение');
      void queryClient.invalidateQueries({ queryKey: trainingsKey });
    },
  });

  const save = (patch: IOtTrainingPatch) => {
    setBusyKind(patch.kind);
    saveMutation.mutate(patch, { onSettled: () => setBusyKind(null) });
  };

  const handleDate = (kind: string, next: string) => {
    // DateInput отдаёт '' на любом неполном вводе — это не очистка, для неё есть крестик.
    if (next === '' || !isValidIsoDate(next)) return;
    if (next === (byKind.get(kind)?.passed_on ?? '')) return;
    if (next > todayLocal()) {
      toast.warning('Дата обучения не может быть в будущем');
      return;
    }
    save({ kind, passed_on: next });
  };

  const handleNoteBlur = (kind: string, value: string) => {
    const next = value.trim();
    const prev = byKind.get(kind)?.note ?? '';
    if (next === prev) return;
    save({ kind, note: next === '' ? null : next });
  };

  if (catalogQuery.isLoading || trainingsQuery.isLoading) {
    return <div className={styles.panelEmpty}>Загрузка…</div>;
  }

  return (
    <div className={styles.panel}>
      {(catalogQuery.data ?? []).map(def => {
        const state = byKind.get(def.kind);
        const value = state?.passed_on ?? '';
        const busy = busyKind === def.kind;
        return (
          <OtTrainingRow
            key={def.kind}
            def={def}
            value={value}
            state={state}
            disabled={!canEdit || busy}
            onChange={next => handleDate(def.kind, next)}
            onClear={() => { if (value) save({ kind: def.kind, passed_on: null }); }}
          >
            {def.hasNote && (
              <div className={otStyles.note}>
                <span className={otStyles.hint}>{def.noteLabel ?? 'Уточнение'}</span>
                <input
                  className={`${contractorStyles.input} ${otStyles.noteInput}`}
                  defaultValue={state?.note ?? ''}
                  key={`${def.kind}:${state?.note ?? ''}`}
                  placeholder="Например: Монтажник"
                  maxLength={120}
                  disabled={!canEdit || busy || !value}
                  title={value ? undefined : 'Сначала укажите дату прохождения'}
                  onBlur={e => handleNoteBlur(def.kind, e.target.value)}
                />
              </div>
            )}
          </OtTrainingRow>
        );
      })}
    </div>
  );
};
