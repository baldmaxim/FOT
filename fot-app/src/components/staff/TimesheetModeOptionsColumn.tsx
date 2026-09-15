import { useMemo, useState, type FC, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TimesheetExportMode } from '../../services/adminService';
import { employeeService } from '../../services/employeeService';
import { CURRENT_ACTIVITY_LABEL } from '../../utils/objectGroups';
import type { ITimesheetModeCurrent } from './timesheetModeLabels';

/**
 * Безобъектные варианты. «Объект» отдельным пунктом не нужен — им становится выбор объекта
 * ниже. Сброс явного режима делает кнопка в футере, поэтому пункта «Не задавать» здесь нет:
 * случайный клик по списку не должен очищать настройку.
 */
const PLAIN_MODE_OPTIONS: Array<{ value: TimesheetExportMode; label: string; hint: string }> = [
  { value: 'current_activity', label: 'Текущая деятельность', hint: 'Одна строка, адрес «Текущая деятельность».' },
  { value: 'skud', label: 'По СКУД', hint: 'Разбивка по фактическим проходам — несколько строк.' },
];

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

interface IProps {
  /** undefined — режим ещё не выбран. */
  mode: TimesheetExportMode | undefined;
  objectId: string | null;
  onSelect: (mode: TimesheetExportMode, objectId: string | null) => void;
  /** Текущий вариант единственной выбранной строки — помечается «сейчас», но не выбирается. */
  current: ITimesheetModeCurrent | null;
  hint: ReactNode;
  /** Только просмотр: поиск и варианты недоступны (нет права, ошибка или загрузка). */
  readOnly?: boolean;
  /**
   * Текущий закреплённый объект стал неактивным: в списке только активные, поэтому
   * показываем его отдельной строкой без возможности выбора.
   */
  inactiveCurrent?: { name: string | null; address: string | null } | null;
}

/** Правая колонка «Вариант табелирования» — общая для всех вкладок окна. */
export const TimesheetModeOptionsColumn: FC<IProps> = ({ mode, objectId, onSelect, current, hint, readOnly = false, inactiveCurrent = null }) => {
  const [objectSearch, setObjectSearch] = useState('');
  const objectsQuery = useQuery({
    queryKey: ['work-object-options'],
    queryFn: () => employeeService.listWorkObjectOptions(),
    staleTime: 5 * 60_000,
  });

  /**
   * Записи с адресом «Текущая деятельность» отфильтрованы: им соответствует отдельный режим
   * current_activity, а режим object требует РОВНО один UUID (инвариант миграции 249).
   */
  const selectableObjects = useMemo(() => {
    const isCurrentActivity = (name: string | null | undefined): boolean =>
      normalize(name ?? '') === CURRENT_ACTIVITY_LABEL.toLowerCase();
    const q = normalize(objectSearch);
    return (objectsQuery.data ?? [])
      .filter(o => !isCurrentActivity(o.alt_name))
      .filter(o => !q || normalize(o.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [objectsQuery.data, objectSearch]);

  const isCurrent = (value: TimesheetExportMode, id: string | null): boolean =>
    Boolean(current && current.mode === value && (value !== 'object' || current.objectId === id));

  const currentMark = <span className="sc-mode-current" title="Действует сейчас у выбранной строки">сейчас</span>;

  return (
    <div className="sc-obj-col">
      <div className="sc-obj-col-label" id="timesheet-mode-options-label">Вариант табелирования</div>
      {/* fieldset disabled — блокирует поиск и все радио разом, с корректной доступностью. */}
      <fieldset className="sc-mode-fieldset" disabled={readOnly} aria-labelledby="timesheet-mode-options-label">
        <input
          type="text"
          className="sc-obj-search"
          value={objectSearch}
          onChange={e => setObjectSearch(e.target.value)}
          placeholder="Поиск объекта…"
          aria-label="Поиск объекта"
        />
        <div className="sc-obj-list">
          <div className="sc-obj-group-label">Режим</div>
          {PLAIN_MODE_OPTIONS.map(option => (
            <label key={option.value} className={`sc-obj-item ${mode === option.value ? 'sc-obj-item--on' : ''}`}>
              <input
                type="radio"
                name="timesheet-mode-option"
                checked={mode === option.value}
                onChange={() => onSelect(option.value, null)}
              />
              <span>
                {option.label}
                {isCurrent(option.value, null) && currentMark}
                <span className="sc-obj-empty sc-mode-option-hint">{option.hint}</span>
              </span>
            </label>
          ))}

          <div className="sc-obj-group-label">Объекты</div>
          {inactiveCurrent && (
            <div className="sc-obj-item sc-obj-item--inactive" title="Объект неактивен — выберите другой вариант">
              <span>
                {inactiveCurrent.name || 'Объект'}
                <span className="sc-mode-current">сейчас, объект неактивен</span>
                {inactiveCurrent.address && <span className="sc-obj-empty sc-mode-option-hint">{inactiveCurrent.address}</span>}
              </span>
            </div>
          )}
          {objectsQuery.isLoading ? (
            <div className="sc-obj-empty">Загрузка объектов…</div>
          ) : selectableObjects.length === 0 ? (
            <div className="sc-obj-empty">— объекты не найдены —</div>
          ) : selectableObjects.map(o => (
            <label key={o.id} className={`sc-obj-item ${mode === 'object' && objectId === o.id ? 'sc-obj-item--on' : ''}`}>
              <input
                type="radio"
                name="timesheet-mode-option"
                checked={mode === 'object' && objectId === o.id}
                onChange={() => onSelect('object', o.id)}
              />
              <span>
                {o.name}
                {isCurrent('object', o.id) && currentMark}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="sc-mode-hint">{hint}</p>
    </div>
  );
};
