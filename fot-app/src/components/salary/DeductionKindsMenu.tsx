import { useEffect, useId, useMemo, useState, type CSSProperties, type FC, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { PAYROLL_DEDUCTION_KINDS_KEY } from '../../hooks/usePayrollDeductionKinds';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { payrollService, type IPayrollDeductionKind } from '../../services/payrollService';
import shared from './PayrollColumnsMenu.module.css';
import styles from './DeductionKindsMenu.module.css';

interface IDeductionKindsMenuProps {
  /** Ячейка или поле: меню открывается под ним, по его левому краю. */
  anchor: HTMLElement;
  /** Чьи удержания — подпись под заголовком. */
  subtitle?: string;
  kinds: readonly IPayrollDeductionKind[];
  selected: readonly number[];
  onToggle: (kindId: number, checked: boolean) => void;
  onClose: () => void;
}

const MENU_WIDTH = 300;
/** Места под якорем меньше — и сверху больше: меню раскрывается вверх. */
const MIN_SPACE_BELOW = 320;
const VIEWPORT_GAP = 8;
/** Смартфон — лист снизу, как у меню «Столбцы таблицы». */
const SHEET_MEDIA = '(max-width: 768px)';

/**
 * Выпадающий список «Удержание»: виды справочника галочками (несколько сразу) и добавление
 * нового вида — он попадает в справочник и сразу отмечается. Галочка применяется сразу;
 * закрытие — Escape, клик мимо или «Готово».
 */
export const DeductionKindsMenu: FC<IDeductionKindsMenuProps> = ({ anchor, subtitle, kinds, selected, onToggle, onClose }) => {
  const dismiss = useOverlayDismiss(onClose);
  const queryClient = useQueryClient();
  const inputId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Перехват на document: Escape закрывает только меню, а не окно сотрудника под ним (оно слушает window).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Позиция считается один раз при открытии: меню модальное, страница под ним не прокручивается.
  // Поле у низа экрана (карточка) — меню раскрывается вверх; высота — по свободному месту.
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);
  const style = useMemo<CSSProperties | undefined>(() => {
    if (isSheet) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(VIEWPORT_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP));
    const spaceBelow = window.innerHeight - rect.bottom - 6 - VIEWPORT_GAP;
    const spaceAbove = rect.top - 6 - VIEWPORT_GAP;
    if (spaceBelow >= MIN_SPACE_BELOW || spaceBelow >= spaceAbove) {
      return { top: rect.bottom + 6, left, width: MENU_WIDTH, maxHeight: spaceBelow };
    }
    return { bottom: window.innerHeight - rect.top + 6, left, width: MENU_WIDTH, maxHeight: spaceAbove };
  }, [anchor, isSheet]);

  const addMutation = useMutation({
    mutationFn: (value: string) => payrollService.addDeductionKind(value),
    onSuccess: kind => {
      setName('');
      onToggle(kind.id, true);
      void queryClient.invalidateQueries({ queryKey: PAYROLL_DEDUCTION_KINDS_KEY });
    },
    onError: (err: Error) => setError(err.message || 'Не удалось добавить вид'),
  });

  const handleAdd = (event: FormEvent) => {
    event.preventDefault();
    // События портала идут по дереву React: без этого submit дошёл бы до формы карточки.
    event.stopPropagation();
    const value = name.replace(/\s+/g, ' ').trim();
    if (!value || addMutation.isPending) return;
    addMutation.mutate(value);
  };

  const selectedSet = new Set(selected);

  return createPortal(
    <>
      <div className={`${shared.backdrop} ${styles.raisedBackdrop}`} {...dismiss} />
      <div
        className={`${isSheet ? `${shared.menu} ${shared.sheet}` : shared.menu} ${styles.raisedMenu}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label="Удержание"
      >
        <div className={shared.title}>Удержание</div>
        {subtitle && <p className={shared.fixed}>{subtitle}</p>}

        <ul className={shared.list}>
          {kinds.map((kind, index) => (
            <li key={kind.id}>
              <label className={shared.option}>
                <input
                  type="checkbox"
                  className={shared.checkbox}
                  checked={selectedSet.has(kind.id)}
                  autoFocus={index === 0}
                  onChange={event => onToggle(kind.id, event.target.checked)}
                />
                <span>{kind.name}</span>
              </label>
            </li>
          ))}
        </ul>

        {/* Отдельная форма: Enter в поле добавляет вид, а не отправляет форму карточки под меню. */}
        <form className={styles.addRow} onSubmit={handleAdd} noValidate>
          <input
            id={inputId}
            className={styles.addInput}
            value={name}
            maxLength={100}
            autoComplete="off"
            placeholder="Новый вид удержания"
            aria-label="Новый вид удержания"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            onChange={event => {
              setName(event.target.value);
              setError(null);
            }}
          />
          <button type="submit" className={styles.addButton} disabled={!name.trim() || addMutation.isPending}>
            {addMutation.isPending ? '…' : 'Добавить'}
          </button>
        </form>
        {error && <p id={`${inputId}-error`} className={styles.addError} role="alert">{error}</p>}

        <div className={shared.footer}>
          <span />
          <button type="button" className={shared.doneButton} onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};
