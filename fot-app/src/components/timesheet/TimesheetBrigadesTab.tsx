import { useMemo, useState, type FC } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { useBrigadeObjectsSummary } from '../../hooks/useBrigadeObjectsSummary';
import { useTimesheetBrigades } from '../../hooks/useTimesheetBrigades';
import type { ITimesheetBrigadeOutputItem } from '../../types/timesheet';
import { filterObjectsSummary } from '../../utils/brigadeObjectsSummary';
import { filterByFio } from '../../utils/fioSearch';
import { formatSalaryAmount } from '../../utils/timesheetSalary';
import { ClearableInput } from '../ui/ClearableInput';
import { TimesheetBrigadeObjects } from './TimesheetBrigadeObjects';
import { TimesheetObjectsSummary } from './TimesheetObjectsSummary';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';
import styles from './TimesheetBrigadesTab.module.css';

interface ITimesheetBrigadesTabProps {
  /** ГГГГ-ММ. */
  month: string;
  canEdit: boolean;
}

const OBJECTS_FILLED = 'Внесена выработка по объектам — сотрите её, чтобы внести на бригаду';

type BrigadesView = 'brigades' | 'objects';

const VIEWS: ReadonlyArray<{ value: BrigadesView; label: string }> = [
  { value: 'brigades', label: 'Бригады' },
  { value: 'objects', label: 'Объекты' },
];

interface IBrigadeRowProps {
  item: ITimesheetBrigadeOutputItem;
  index: number;
  month: string;
  canEdit: boolean;
  saving: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSaveBrigade: (amount: number | null) => Promise<void>;
}

const BrigadeRow: FC<IBrigadeRowProps> = ({ item, index, month, canEdit, saving, expanded, onToggle, onSaveBrigade }) => {
  const byObjects = item.objects_output !== null;
  return (
    <li className={styles.item}>
      <div className={styles.row}>
        <span className={styles.index}>{index}.</span>
        <span
          className={`${styles.name}${item.is_active ? '' : ` ${styles.nameInactive}`}`}
          title={item.is_active ? item.name : `${item.name} — бригада неактивна`}
        >
          {item.name}
        </span>
        <span className={styles.field} title={byObjects ? OBJECTS_FILLED : undefined}>
          <span className={styles.fieldLabel}>Выработка бригады, ₽</span>
          <TimesheetSalaryOutputInput
            value={item.brigade_output}
            canEdit={canEdit && !byObjects}
            saving={saving}
            label={`Выработка бригады, ${item.name}`}
            onSave={onSaveBrigade}
          />
        </span>
        <span className={styles.byObjects}>
          <span className={styles.fieldLabel}>По объектам, ₽</span>
          <span className={styles.amount}>{formatSalaryAmount(item.objects_output)}</span>
        </span>
        <button
          type="button"
          className={styles.toggle}
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? `Скрыть объекты: ${item.name}` : `Объекты: ${item.name}`}
        >
          {expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
      </div>
      {expanded && <TimesheetBrigadeObjects departmentId={item.department_id} month={month} canEdit={canEdit} />}
    </li>
  );
};

/**
 * «Табель → Бригады» (341; 5 учёток «Зарплаты» и галочка «Выработка», 342): бригады месяца и их выработка — одной суммой на бригаду
 * (делится на всех по КТУ × часы за месяц) или по объектам (стрелка), не обе сразу. Внесённое видно во «Зарплате по
 * объектам» этой бригады. Переключатель «Объекты» — объекты месяца по всем бригадам: люди, часы и стоимость часа
 * (только просмотр); грузится только выбранный режим.
 */
export const TimesheetBrigadesTab: FC<ITimesheetBrigadesTabProps> = ({ month, canEdit }) => {
  const [view, setView] = useState<BrigadesView>('brigades');
  const { brigades, loading, error, setBrigadeOutput, savingDepartmentId } = useTimesheetBrigades({
    month, enabled: view === 'brigades',
  });
  const summary = useBrigadeObjectsSummary({ month, enabled: view === 'objects' });
  const [search, setSearch] = useState('');
  const [objectSearch, setObjectSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => filterByFio(brigades ?? [], item => item.name, search), [brigades, search]);
  const objectViews = useMemo(
    () => filterObjectsSummary(summary.data?.objects ?? [], objectSearch),
    [summary.data, objectSearch],
  );

  const toggle = (departmentId: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(departmentId)) next.delete(departmentId);
    else next.add(departmentId);
    return next;
  });

  return (
    <div className="ts-table-container">
      <div className={styles.head}>
        <div className={styles.viewSwitch} role="group" aria-label="Вид вкладки">
          {VIEWS.map(item => (
            <button
              key={item.value}
              type="button"
              className={`${styles.viewChip}${view === item.value ? ` ${styles.viewChipActive}` : ''}`}
              aria-pressed={view === item.value}
              onClick={() => setView(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {view === 'brigades' && brigades && <span className={styles.count}>{visible.length} из {brigades.length}</span>}
        {view === 'objects' && summary.data && (
          <span className={styles.count}>{objectViews.length} из {summary.data.objects.length}</span>
        )}
        {view === 'brigades' ? (
          <ClearableInput
            key="brigades"
            className={styles.search}
            value={search}
            onValueChange={setSearch}
            placeholder="Поиск бригады"
            aria-label="Поиск бригады"
            clearLabel="Очистить поиск бригады"
            autoComplete="off"
          />
        ) : (
          <ClearableInput
            key="objects"
            className={styles.search}
            value={objectSearch}
            onValueChange={setObjectSearch}
            placeholder="Поиск объекта или ФИО"
            aria-label="Поиск объекта, бригады или ФИО"
            clearLabel="Очистить поиск объекта"
            autoComplete="off"
          />
        )}
      </div>
      {view === 'objects' ? (
        <TimesheetObjectsSummary
          key={objectSearch.trim()}
          data={summary.data}
          views={objectViews}
          loading={summary.loading}
          error={summary.error}
        />
      ) : error ? (
        <div className="ts-loading">Не удалось загрузить бригады</div>
      ) : loading || !brigades ? (
        <div className="ts-loading">Загрузка…</div>
      ) : visible.length === 0 ? (
        <div className="ts-loading">{brigades.length === 0 ? 'Нет бригад за месяц' : 'Ничего не найдено'}</div>
      ) : (
        <div className={styles.scroll}>
          <div className={styles.columns} aria-hidden="true">
            <span>№</span>
            <span>Бригада</span>
            <span>Выработка бригады, ₽</span>
            <span>По объектам, ₽</span>
            <span />
          </div>
          <ul className={styles.list}>
            {visible.map((item, index) => (
              <BrigadeRow
                key={item.department_id}
                item={item}
                index={index + 1}
                month={month}
                canEdit={canEdit}
                saving={savingDepartmentId === item.department_id}
                expanded={expanded.has(item.department_id)}
                onToggle={() => toggle(item.department_id)}
                onSaveBrigade={amount => setBrigadeOutput(item.department_id, amount)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
