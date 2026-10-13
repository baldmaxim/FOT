import { useState } from 'react';
import type { FC } from 'react';
import { ArrowRight } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import { skudService } from '../../services/skudService';
import { moscowCurrentMonth, moscowTodayIso } from '../../utils/moscowDate';
import styles from './AccessPointZoneModal.module.css';

interface IAccessPointZoneModalProps {
  /** Имя точки, как оно приходит из Sigur. */
  pointName: string;
  /** Подпись в заголовке (имя с номером точки). */
  label: string;
  /** Тип зоны на сегодня; окно меняет его на противоположный. */
  isInternal: boolean;
  onClose: () => void;
  /** Тип зоны, который теперь действует на сегодня. */
  onSaved: (pointName: string, isInternal: boolean) => void;
}

const zoneName = (isInternal: boolean): string => (isInternal ? 'Внутренняя' : 'Внешняя');

/**
 * Смена типа зоны точки доступа с датой начала. Дата — не раньше 1-го числа текущего месяца
 * и не позже сегодня: смена без даты меняла расчёт часов за все прошлые месяцы.
 */
export const AccessPointZoneModal: FC<IAccessPointZoneModalProps> = ({
  pointName,
  label,
  isInternal,
  onClose,
  onSaved,
}) => {
  const toast = useToast();
  const today = moscowTodayIso();
  const monthStart = `${moscowCurrentMonth()}-01`;
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [saving, setSaving] = useState(false);

  const next = !isInternal;
  const dateValid = effectiveFrom >= monthStart && effectiveFrom <= today;

  const handleSave = async (requestClose: () => void) => {
    if (!dateValid) return;
    setSaving(true);
    try {
      const result = await skudService.changeAccessPointZone({ accessPointName: pointName, isInternal: next, effectiveFrom });
      toast.success(result.changed ? 'Тип зоны изменён, табель пересчитывается' : 'Тип зоны уже такой');
      onSaved(pointName, next);
      requestClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Не удалось изменить тип зоны');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.overlay}
      containerClassName={styles.modal}
      aria-labelledby="access-point-zone-title"
    >
      {({ requestClose }) => (
        <>
          <h2 id="access-point-zone-title" className={styles.title}>{label}</h2>
          <div className={styles.change}>
            <span className={`sigur-ap-type-label ${isInternal ? 'internal' : 'external'}`}>{zoneName(isInternal)}</span>
            <ArrowRight size={16} aria-hidden="true" />
            <span className={`sigur-ap-type-label ${next ? 'internal' : 'external'}`}>{zoneName(next)}</span>
          </div>

          <p className={styles.description}>
            Точка будет считаться {next ? 'внутренней' : 'внешней'} с выбранной даты. Проходы до этой даты
            считаются по-прежнему. Дата — не раньше 1-го числа текущего месяца.
          </p>

          <label className={styles.field}>
            <span>Считать {next ? 'внутренней' : 'внешней'} с</span>
            <input
              type="date"
              value={effectiveFrom}
              min={monthStart}
              max={today}
              onChange={event => setEffectiveFrom(event.target.value)}
              disabled={saving}
              required
            />
          </label>

          <div className={styles.footer}>
            <button type="button" className="sigur-btn" onClick={requestClose} disabled={saving}>
              Отмена
            </button>
            <button
              type="button"
              className="sigur-btn sigur-btn-primary"
              onClick={() => handleSave(requestClose)}
              disabled={saving || !dateValid}
            >
              {saving ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
