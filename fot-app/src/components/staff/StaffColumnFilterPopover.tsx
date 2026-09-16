import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { employeeService, type IStaffViewParams } from '../../services/employeeService';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import {
  columnFilterKind,
  getColumnFilter,
  MAX_FILTER_TEXT,
  MAX_FILTER_VALUES,
  type IColumnFilterValue,
  type IStaffColumnFilters,
  type StaffFilterColumn,
} from '../../utils/staffColumnFilters';

const EMPTY_LABELS: Partial<Record<StaffFilterColumn, string>> = {
  department: 'Без отдела',
  position: 'Без должности',
  schedule: 'Без графика',
  main_object: 'Без объекта',
  sign: 'Без признака',
};

const POPOVER_WIDTH = 320;

interface IStaffColumnFilterPopoverProps {
  column: StaffFilterColumn;
  label: string;
  filters: IStaffColumnFilters;
  /** Фильтры экрана — для вариантов значений (сервер не применяет фильтр самого столбца). */
  viewParams: Omit<IStaffViewParams, 'sort' | 'dir'>;
  /** Кнопка-воронка; null — открыто из мобильного листа (окно на всю ширину снизу). */
  anchor: HTMLElement | null;
  onApply: (column: StaffFilterColumn, value: IColumnFilterValue | null) => void;
  onClose: () => void;
}

/** Редактор фильтра одного столбца: применяется только по «Применить». */
export const StaffColumnFilterPopover: FC<IStaffColumnFilterPopoverProps> = ({
  column, label, filters, viewParams, anchor, onApply, onClose,
}) => {
  const kind = columnFilterKind(column);
  const initial = useMemo(() => getColumnFilter(filters, column), [filters, column]);
  const [selected, setSelected] = useState<(string | null)[]>(() => initial.values ?? []);
  const [from, setFrom] = useState(initial.dates?.from ?? '');
  const [to, setTo] = useState(initial.dates?.to ?? '');
  const [emptyDate, setEmptyDate] = useState(initial.dates?.empty ?? false);
  const [text, setText] = useState(initial.text ?? '');
  const [hasComment, setHasComment] = useState<boolean | undefined>(initial.hasComment);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300).trim();
  const dismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const valuesQuery = useQuery({
    queryKey: ['employees', 'column-values', column, debouncedSearch, viewParams],
    queryFn: ({ signal }) => employeeService.getColumnValues(column, debouncedSearch, viewParams, signal),
    enabled: kind === 'values',
    staleTime: 30_000,
  });

  const style = useMemo<CSSProperties | undefined>(() => {
    if (!anchor) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    return { top: rect.bottom + 6, left, width: POPOVER_WIDTH };
  }, [anchor]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggleValue = (value: string | null) => {
    setSelected(prev => (prev.includes(value) ? prev.filter(item => item !== value) : [...prev, value].slice(0, MAX_FILTER_VALUES)));
  };
  const visibleValues = valuesQuery.data?.values ?? [];
  const selectVisible = () => setSelected(prev => [...new Set([...prev, ...visibleValues.map(item => item.value)])].slice(0, MAX_FILTER_VALUES));

  const apply = () => {
    if (kind === 'values') onApply(column, selected.length > 0 ? { values: selected } : null);
    else if (kind === 'dates') onApply(column, from || to || emptyDate ? { dates: { from: from || undefined, to: to || undefined, empty: emptyDate || undefined } } : null);
    else onApply(column, text.trim() || hasComment !== undefined ? { text: text.trim(), hasComment } : null);
    onClose();
  };
  const reset = () => {
    onApply(column, null);
    onClose();
  };
  const datesInvalid = kind === 'dates' && Boolean(from && to && from > to);

  return createPortal(
    <>
      <div className="sc-colfilter-backdrop" {...dismiss} />
      <div
        className={`sc-colfilter${anchor ? '' : ' sc-colfilter--sheet'}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={`Фильтр: ${label}`}
      >
        <div className="sc-colfilter-title">{label}</div>

        {kind === 'values' && (
          <>
            <input
              className="sc-colfilter-input"
              type="search"
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Найти значение…"
              aria-label="Найти значение"
              autoFocus
            />
            <div className="sc-colfilter-bulk">
              <button type="button" className="sc-colfilter-link" onClick={selectVisible} disabled={visibleValues.length === 0}>Выбрать показанные</button>
              <button type="button" className="sc-colfilter-link" onClick={() => setSelected([])} disabled={selected.length === 0}>Снять всё</button>
            </div>
            <div className="sc-colfilter-list" role="group" aria-label="Значения">
              {valuesQuery.isPending && <div className="sc-colfilter-hint">Загрузка…</div>}
              {valuesQuery.isError && (
                <div className="sc-colfilter-hint">
                  Не удалось загрузить значения.{' '}
                  <button type="button" className="sc-colfilter-link" onClick={() => { void valuesQuery.refetch(); }}>Повторить</button>
                </div>
              )}
              {valuesQuery.isSuccess && visibleValues.length === 0 && <div className="sc-colfilter-hint">Ничего не найдено</div>}
              {visibleValues.map(item => (
                <label key={item.value ?? '__empty__'} className="sc-colfilter-option">
                  <input type="checkbox" checked={selectedSet.has(item.value)} onChange={() => toggleValue(item.value)} />
                  <span className={`sc-colfilter-option-label${item.value === null ? ' sc-muted' : ''}`}>
                    {item.value ?? EMPTY_LABELS[column] ?? 'Пусто'}
                  </span>
                  <span className="sc-colfilter-count">{item.count}</span>
                </label>
              ))}
              {valuesQuery.data?.truncated && <div className="sc-colfilter-hint">Показаны первые 300 — уточните поиском</div>}
            </div>
            {selected.length > 0 && <div className="sc-colfilter-hint">Выбрано: {selected.length}</div>}
          </>
        )}

        {kind === 'dates' && (
          <div className="sc-colfilter-dates">
            <label className="sc-colfilter-field">
              <span>С</span>
              <input className="sc-colfilter-input" type="date" value={from} onChange={event => setFrom(event.target.value)} />
            </label>
            <label className="sc-colfilter-field">
              <span>По</span>
              <input className="sc-colfilter-input" type="date" value={to} onChange={event => setTo(event.target.value)} />
            </label>
            <label className="sc-colfilter-option">
              <input type="checkbox" checked={emptyDate} onChange={event => setEmptyDate(event.target.checked)} />
              <span className="sc-colfilter-option-label">Без даты</span>
            </label>
            {datesInvalid && <div className="sc-colfilter-hint sc-colfilter-hint--error">Дата «с» позже даты «по»</div>}
          </div>
        )}

        {kind === 'text' && (
          <div className="sc-colfilter-dates">
            {column === 'comment' && (
              <div className="sc-segmented sc-colfilter-segmented" role="radiogroup" aria-label="Наличие комментария">
                {([['Все', undefined], ['Есть', true], ['Нет', false]] as const).map(([title, value]) => (
                  <button
                    key={title}
                    type="button"
                    role="radio"
                    aria-checked={hasComment === value}
                    className={`sc-seg-btn${hasComment === value ? ' is-active' : ''}`}
                    onClick={() => setHasComment(value)}
                  >
                    {title}
                  </button>
                ))}
              </div>
            )}
            <label className="sc-colfilter-field">
              <span>Содержит</span>
              <input
                className="sc-colfilter-input"
                type="search"
                value={text}
                maxLength={MAX_FILTER_TEXT}
                onChange={event => setText(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') apply(); }}
                placeholder={column === 'name' ? 'Часть ФИО' : 'Часть текста'}
                autoFocus
              />
            </label>
          </div>
        )}

        <div className="sc-colfilter-footer">
          <button type="button" className="sc-btn cancel" onClick={reset}>Сбросить</button>
          <button type="button" className="sc-btn apply" onClick={apply} disabled={datesInvalid}>Применить</button>
        </div>
      </div>
    </>,
    document.body,
  );
};
