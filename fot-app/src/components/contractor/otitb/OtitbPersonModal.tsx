import { useMemo, useState, type FC } from 'react';
import { ApiError } from '../../../api/client';
import { DateInput } from '../../ui/DateInput';
import { ModalShell } from '../../ui/ModalShell';
import { useToast } from '../../../contexts/ToastContext';
import {
  contractorAdminService,
  type IInductedPerson,
  type IOtTrainingDef,
  type OtTrainingsPatch,
} from '../../../services/contractorService';
import { isValidIsoDate, todayLocal } from './otitbShared';
import { OtitbTrainingBadge } from './OtitbStatusBadge';
import contractorStyles from '../../../pages/contractor/Contractor.module.css';
import styles from './Otitb.module.css';

interface IProps {
  orgId: string;
  /** Отсутствует — режим создания. */
  person?: IInductedPerson;
  catalog: IOtTrainingDef[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

type Draft = Record<string, string>;

const draftFrom = (person: IInductedPerson | undefined): Draft => {
  const draft: Draft = {};
  for (const t of person?.trainings ?? []) draft[t.kind] = t.passed_on;
  return draft;
};

/**
 * Ввод дат обучения по ОТ на одного сотрудника подрядчика. Сохраняется одним запросом,
 * но в тело уходят ТОЛЬКО изменённые поля — иначе форма, открытая давно, вернула бы
 * устаревшие значения поверх чужой правки. Ревизия (updated_at) даёт 409 при гонке.
 *
 * Дата окончания вручную не правится: её считает сервер из периодичности регламента.
 */
export const OtitbPersonModal: FC<IProps> = ({ orgId, person, catalog, onClose, onSaved }) => {
  const toast = useToast();
  const initial = useMemo(() => draftFrom(person), [person]);
  const [fullName, setFullName] = useState(person?.full_name ?? '');
  const [draft, setDraft] = useState<Draft>(initial);
  const [busy, setBusy] = useState(false);

  const stateByKind = useMemo(
    () => new Map((person?.trainings ?? []).map(t => [t.kind, t])),
    [person],
  );

  const setDate = (kind: string, value: string) => {
    setDraft(prev => ({ ...prev, [kind]: value }));
  };

  /** Изменённые виды: '' считаем снятием даты (null). */
  const changedTrainings = (): OtTrainingsPatch => {
    const patch: OtTrainingsPatch = {};
    for (const def of catalog) {
      const next = draft[def.kind] ?? '';
      const before = initial[def.kind] ?? '';
      if (next === before) continue;
      patch[def.kind] = next === '' ? null : next;
    }
    return patch;
  };

  const handleSave = async () => {
    const name = fullName.trim();
    if (name.length < 2) {
      toast.warning('Введите ФИО (минимум 2 символа)');
      return;
    }

    const today = todayLocal();
    for (const def of catalog) {
      const value = draft[def.kind] ?? '';
      if (value === '') continue;
      if (!isValidIsoDate(value)) {
        toast.warning(`Некорректная дата: ${def.label}`);
        return;
      }
      if (value > today) {
        toast.warning(`Дата в будущем: ${def.label}`);
        return;
      }
    }

    const trainings = changedTrainings();
    const nameChanged = !person || name !== person.full_name;
    if (person && !nameChanged && Object.keys(trainings).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    try {
      if (person) {
        await contractorAdminService.updateInducted(person.id, {
          ...(nameChanged ? { full_name: name } : {}),
          ...(Object.keys(trainings).length > 0 ? { trainings } : {}),
          expected_updated_at: person.updated_at,
        });
      } else {
        await contractorAdminService.addInducted(orgId, name, trainings);
      }
      await onSaved();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error('Запись изменена другим пользователем — обновите страницу');
        await onSaved();
        onClose();
        return;
      }
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить обучение');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={contractorStyles.overlay}
      containerClassName={styles.modal}
      aria-label="Обучение по охране труда"
    >
      {({ requestClose }) => (
        <>
          <h2 className={contractorStyles.modalTitle}>
            {person ? `Обучение по ОТ — ${person.full_name}` : 'Новый сотрудник'}
          </h2>

          <div className={contractorStyles.field}>
            <label className={contractorStyles.label}>ФИО</label>
            <input
              className={`${contractorStyles.input} ${contractorStyles.fullInput}`}
              value={fullName}
              placeholder="Фамилия Имя Отчество"
              disabled={busy}
              onChange={e => setFullName(e.target.value)}
            />
          </div>

          {catalog.map(def => {
            const value = draft[def.kind] ?? '';
            const dirty = value !== (initial[def.kind] ?? '');
            return (
              <div className={styles.trainingRow} key={def.kind}>
                <div className={styles.trainingLabel}>
                  <span className={styles.trainingName}>{def.label}</span>
                  <span className={styles.trainingHint}>{def.hint}</span>
                </div>
                <DateInput
                  value={value}
                  onChange={next => setDate(def.kind, next)}
                  disabled={busy}
                />
                <div className={styles.trainingState}>
                  <OtitbTrainingBadge
                    state={stateByKind.get(def.kind)}
                    validMonths={def.validMonths}
                    dirty={dirty}
                  />
                  {value !== '' && (
                    <button
                      type="button"
                      className={`${contractorStyles.btn} ${contractorStyles.btnIcon}`}
                      onClick={() => setDate(def.kind, '')}
                      disabled={busy}
                      title="Снять дату"
                      aria-label={`Снять дату: ${def.label}`}
                    >
                      ✗
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div className={contractorStyles.modalActions}>
            <button className={contractorStyles.btn} onClick={requestClose} disabled={busy}>
              Отмена
            </button>
            <button
              type="button"
              className={`${contractorStyles.btn} ${contractorStyles.btnPrimary}`}
              onClick={() => void handleSave()}
              disabled={busy}
            >
              Сохранить
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};

export default OtitbPersonModal;
