import { useState, type FC, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Check, Pencil, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { contractorAdminService, type IMonitorPassRow } from '../../services/contractorService';
import styles from '../../pages/contractor/Contractor.module.css';

interface IMonitorHolderNameCellProps {
  row: IMonitorPassRow;
  canEdit: boolean;
  onOpenDocs: () => void;
  onSaved: () => void;
}

const normalizeName = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * Ячейка ФИО во вкладке «Мониторинг»: клик по имени включает правку на месте.
 * У одобренного пропуска сервер пишет то же имя в «Управление кадрами» и Sigur;
 * чип «В кадрах» показывает расхождение и подставляет верное имя.
 */
export const MonitorHolderNameCell: FC<IMonitorHolderNameCellProps> = ({ row, canEdit, onOpenDocs, onSaved }) => {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');

  // Пустой слот не правим: держателя вписывает подрядчик, здесь — только исправление ФИО.
  const editable = canEdit && !!row.holder_name && row.status !== 'revoked' && row.status !== 'in_pool';
  const referenceName = row.employee_holder_name ?? null;
  const approved = row.approval_status === 'approved';

  const mutation = useMutation({
    mutationFn: (fullName: string) =>
      contractorAdminService.renamePassHolder(row.id, {
        full_name: fullName,
        expected_updated_at: row.updated_at,
      }),
    onSuccess: result => {
      setEditing(false);
      toast.success(result.changed ? 'ФИО исправлено' : 'ФИО уже совпадает');
      onSaved();
    },
  });

  const startEdit = (initial: string) => {
    mutation.reset();
    setValue(initial);
    setEditing(true);
  };

  const cancel = () => {
    if (mutation.isPending) return;
    mutation.reset();
    setEditing(false);
  };

  const normalized = normalizeName(value);
  // Совпадающее с пропуском имя тоже сохраняем, если кадры расходятся: тогда оно уйдёт в кадры и Sigur.
  const canSave = normalized.split(' ').length >= 2
    && (normalized !== row.holder_name || referenceName !== null)
    && !mutation.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) mutation.mutate(normalized);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  };

  const mismatchTitle = 'ФИО в «Управлении кадрами» — копия Sigur, обновляется синхронизацией раз в 2 часа';
  const mismatchChip = referenceName && (
    editable ? (
      <button
        type="button"
        className={styles.nameMismatch}
        onClick={() => (editing ? setValue(referenceName) : startEdit(referenceName))}
        title={`${mismatchTitle}. Нажмите, чтобы подставить`}
        disabled={mutation.isPending}
      >
        <AlertTriangle size={14} className={styles.nameMismatchIcon} aria-hidden />
        В кадрах: {referenceName}
      </button>
    ) : (
      <span className={styles.nameMismatch} title={mismatchTitle}>
        <AlertTriangle size={14} className={styles.nameMismatchIcon} aria-hidden />
        В кадрах: {referenceName}
      </span>
    )
  );

  if (editing) {
    const errorText = mutation.error instanceof Error ? mutation.error.message : null;
    return (
      <form className={styles.nameEditForm} onSubmit={submit}>
        <input
          className={`${styles.input} ${styles.nameEditInput}`}
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={200}
          autoFocus
          disabled={mutation.isPending}
          aria-label="ФИО держателя пропуска"
        />
        <button type="submit" className={styles.rowBtn} disabled={!canSave} title="Сохранить (Enter)" aria-label="Сохранить ФИО">
          <Check size={16} aria-hidden />
        </button>
        <button type="button" className={styles.rowBtn} onClick={cancel} disabled={mutation.isPending} title="Отмена (Esc)" aria-label="Отменить правку">
          <X size={16} aria-hidden />
        </button>
        {mismatchChip}
        <div className={styles.nameEditHint}>
          {approved
            ? 'Имя изменится в пропуске, в «Управлении кадрами» и в Sigur'
            : 'Имя изменится в пропуске; в Sigur уйдёт при одобрении'}
        </div>
        {errorText && <div className={styles.nameEditError} role="alert">{errorText}</div>}
      </form>
    );
  }

  return (
    <div className={styles.nameCell}>
      <div className={styles.nameMain}>
        {editable ? (
          <button
            type="button"
            className={styles.nameEditBtn}
            // При расхождении сразу предлагаем имя из кадров — на проде верным оказывалось оно.
            onClick={() => startEdit(referenceName ?? row.holder_name ?? '')}
            title="Нажмите, чтобы исправить ФИО"
          >
            <span className={styles.nameEditLabel}>{row.holder_name ?? '—'}</span>
            <Pencil size={14} className={styles.nameEditIcon} aria-hidden />
          </button>
        ) : (
          <span className={styles.nameText}>{row.holder_name ?? '—'}</span>
        )}
        {mismatchChip}
      </div>
      <button
        type="button"
        className={styles.rowBtn}
        onClick={onOpenDocs}
        title={canEdit ? 'Документы держателя (просмотр и правка)' : 'Просмотр документов'}
      >
        Документы
      </button>
    </div>
  );
};
