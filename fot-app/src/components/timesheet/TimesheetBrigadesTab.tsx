import { useMemo, useState, type FC } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { useTimesheetBrigades } from '../../hooks/useTimesheetBrigades';
import type { ITimesheetBrigadeOutputItem } from '../../types/timesheet';
import { filterByFio } from '../../utils/fioSearch';
import { formatSalaryAmount } from '../../utils/timesheetSalary';
import { ClearableInput } from '../ui/ClearableInput';
import { TimesheetBrigadeObjects } from './TimesheetBrigadeObjects';
import { TimesheetSalaryOutputInput } from './TimesheetSalaryOutputInput';
import styles from './TimesheetBrigadesTab.module.css';

interface ITimesheetBrigadesTabProps {
  /** ГГГГ-ММ. */
  month: string;
  canEdit: boolean;
}

const OBJECTS_FILLED = 'Внесена выработка по объектам — сотрите её, чтобы внести на бригаду';

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
 * «Табель → Бригады» (341, только 5 учёток «Зарплаты»): бригады месяца и их выработка — одной суммой на бригаду
 * (делится на всех по КТУ × часы за месяц) или по объектам (стрелка), не обе сразу. Внесённое видно во «Зарплате по
 * объектам» этой бригады.
 */
export const TimesheetBrigadesTab: FC<ITimesheetBrigadesTabProps> = ({ month, canEdit }) => {
  const { brigades, loading, error, setBrigadeOutput, savingDepartmentId } = useTimesheetBrigades({ month, enabled: true });
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => filterByFio(brigades ?? [], item => item.name, search), [brigades, search]);

  const toggle = (departmentId: string) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(departmentId)) next.delete(departmentId);
    else next.add(departmentId);
    return next;
  });

  return (
    <div className="ts-table-container">
      <div className={styles.head}>
        <h3 className="ts-table-title">Бригады</h3>
        {brigades && <span className={styles.count}>{visible.length} из {brigades.length}</span>}
        <ClearableInput
          className={styles.search}
          value={search}
          onValueChange={setSearch}
          placeholder="Поиск бригады"
          aria-label="Поиск бригады"
          clearLabel="Очистить поиск бригады"
          autoComplete="off"
        />
      </div>
      {error ? (
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
