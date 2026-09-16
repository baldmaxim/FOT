import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';

import {
  payrollService,
  type IPayrollColumnFilters,
  type IPayrollTermsViewParams,
  type PayrollSortKey,
} from '../../services/payrollService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  isPayrollValueFilterColumn,
  MAX_PAYROLL_FILTER_TEXT,
  MAX_PAYROLL_FILTER_VALUES,
} from '../../utils/payrollColumnFilters';
import { formatPayrollFilterValue } from '../../utils/payrollFormat';
import styles from './PayrollColumnFilterPopover.module.css';

const POPOVER_WIDTH = 320;
/** Уже этой ширины окно открывается листом снизу во всю ширину. */
const SHEET_MEDIA = '(max-width: 768px)';

interface IPayrollColumnFilterPopoverProps {
  column: PayrollSortKey;
  label: string;
  filters: IPayrollColumnFilters;
  /** Выборка экрана — для вариантов значений (сервер не применяет фильтр самого столбца). */
  viewParams: IPayrollTermsViewParams;
  /** Кнопка-воронка, под которой открывается окно. */
  anchor: HTMLElement;
  /** Список значений, текст ФИО или null — снять фильтр столбца. */
  onApply: (column: PayrollSortKey, value: (string | null)[] | string | null) => void;
  onClose: () => void;
}

/** Редактор фильтра одного столбца; применяется только по «Применить». */
export const PayrollColumnFilterPopover: FC<IPayrollColumnFilterPopoverProps> = ({
  column, label, filters, viewParams, anchor, onApply, onClose,
}) => {
  const valueColumn = isPayrollValueFilterColumn(column) ? column : null;
  const [selected, setSelected] = useState<(string | null)[]>(() => (valueColumn ? filters.values?.[valueColumn] ?? [] : []));
  const [text, setText] = useState(() => filters.text?.name ?? '');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300).trim();
  const dismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valuesQuery = useQuery({
    queryKey: ['payroll-terms', 'column-values', column, debouncedSearch, viewParams],
    queryFn: ({ signal }) => (valueColumn
      ? payrollService.getColumnValues(valueColumn, debouncedSearch, viewParams, signal)
      : Promise.resolve({ values: [], truncated: false })),
    enabled: valueColumn !== null,
    staleTime: 30_000,
  });

  // Позиция считается один раз при открытии: окно модальное, таблица под ним не прокручивается.
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);
  const style = useMemo<CSSProperties | undefined>(() => {
    if (isSheet) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    return { top: rect.bottom + 6, left, width: POPOVER_WIDTH };
  }, [anchor, isSheet]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visibleValues = valuesQuery.data?.values ?? [];

  const toggleValue = (value: string | null) => {
    setSelected(prev => (prev.includes(value)
      ? prev.filter(item => item !== value)
      : [...prev, value].slice(0, MAX_PAYROLL_FILTER_VALUES)));
  };
  const selectVisible = () => {
    setSelected(prev => [...new Set([...prev, ...visibleValues.map(item => item.value)])].slice(0, MAX_PAYROLL_FILTER_VALUES));
  };

  const apply = () => {
    if (valueColumn) onApply(column, selected.length > 0 ? selected : null);
    else onApply(column, text.trim() ? text.trim() : null);
    onClose();
  };
  const reset = () => {
    onApply(column, null);
    onClose();
  };

  return createPortal(
    <>
      <div className={styles.backdrop} {...dismiss} />
      <div
        className={`${styles.popover}${isSheet ? ` ${styles.sheet}` : ''}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={`Фильтр: ${label}`}
      >
        <div className={styles.title}>{label}</div>

        {valueColumn ? (
          <>
            <input
              className={styles.input}
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Найти значение…"
              aria-label="Найти значение"
              autoFocus
            />
            <div className={styles.bulk}>
              <button type="button" className={styles.link} onClick={selectVisible} disabled={visibleValues.length === 0}>
                Выбрать показанные
              </button>
              <button type="button" className={styles.link} onClick={() => setSelected([])} disabled={selected.length === 0}>
                Снять всё
              </button>
            </div>
            <div className={styles.list} role="group" aria-label="Значения">
              {valuesQuery.isPending && <div className={styles.hint}>Загрузка…</div>}
              {valuesQuery.isError && (
                <div className={styles.hint}>
                  Не удалось загрузить значения.{' '}
                  <button type="button" className={styles.link} onClick={() => { void valuesQuery.refetch(); }}>Повторить</button>
                </div>
              )}
              {valuesQuery.isSuccess && visibleValues.length === 0 && <div className={styles.hint}>Ничего не найдено</div>}
              {visibleValues.map(item => (
                <label key={item.value ?? '__empty__'} className={styles.option}>
                  <input type="checkbox" checked={selectedSet.has(item.value)} onChange={() => toggleValue(item.value)} />
                  <span className={`${styles.optionLabel}${item.value === null ? ` ${styles.muted}` : ''}`}>
                    {formatPayrollFilterValue(valueColumn, item.value)}
                  </span>
                  <span className={styles.count}>{item.count}</span>
                </label>
              ))}
              {valuesQuery.data?.truncated && <div className={styles.hint}>Показаны первые 300 — уточните поиском</div>}
            </div>
            {selected.length > 0 && <div className={styles.hint}>Выбрано: {selected.length}</div>}
          </>
        ) : (
          <label className={styles.field}>
            <span>Содержит</span>
            <input
              className={styles.input}
              type="search"
              value={text}
              maxLength={MAX_PAYROLL_FILTER_TEXT}
              onChange={event => setText(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') apply(); }}
              placeholder="Часть ФИО"
              autoFocus
            />
          </label>
        )}

        <div className={styles.footer}>
          <button type="button" className={styles.secondaryButton} onClick={reset}>Сбросить</button>
          <button type="button" className={styles.primaryButton} onClick={apply}>Применить</button>
        </div>
      </div>
    </>,
    document.body,
  );
};
