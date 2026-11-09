import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type StaffCategory } from '../../services/payrollService';
import type { ICalcMonthFilter } from '../../utils/payrollViews';
import { SearchableSelect, type ISearchableSelectOption } from '../ui/SearchableSelect';
import styles from './PayrollMonthFilterFields.module.css';

/** Как вкладки «Свода». */
const CATEGORY_OPTIONS: ISearchableSelectOption[] = [
  { value: 'itr', label: 'ИТР' },
  { value: 'office', label: 'Офис' },
  { value: 'worker', label: 'Рабочие' },
];

interface IPayrollMonthFilterFieldsProps {
  /** Месяцы «Расчётов» (YYYY-MM); null — ещё не известны, список объектов не грузится. */
  months: string[] | null;
  date: string;
  /** Отдел «Расчётов»: объекты — его сотрудников. */
  departmentId: string;
  value: ICalcMonthFilter;
  onChange: (next: ICalcMonthFilter) => void;
}

/**
 * «Расчёты»: «Все категории» и «Все объекты» рядом с «Все отделы» — категория и объект месяца, как в «Своде».
 * Список объектов считает сервер (тяжело), поэтому он грузится при первом фокусе поля, а не с открытием экрана.
 * Выбранный объект, которого нет в новом списке (другие месяцы или категория), показывается по сохранённому имени.
 */
export const PayrollMonthFilterFields: FC<IPayrollMonthFilterFieldsProps> = ({ months, date, departmentId, value, onChange }) => {
  const [objectsWanted, setObjectsWanted] = useState(false);
  const category = value.category ?? undefined;
  const objectsQuery = useQuery({
    queryKey: ['payroll-terms', 'month-objects', months, date, departmentId, category ?? null],
    queryFn: ({ signal }) => payrollService.monthObjects(
      { months: months ?? [], date, departmentId: departmentId || undefined, category },
      signal,
    ),
    enabled: objectsWanted && months !== null && months.length > 0,
    staleTime: 60_000,
  });

  const objects = objectsQuery.data;
  const objectOptions = useMemo(() => {
    const list: ISearchableSelectOption[] = (objects ?? []).map(object => ({
      value: object.key,
      label: `${object.name} (${object.count})`,
    }));
    const selected = value.object;
    if (selected && !list.some(option => option.value === selected.key)) {
      list.unshift({ value: selected.key, label: selected.name });
    }
    return list;
  }, [objects, value.object]);

  const pickObject = (key: string) => {
    if (!key) {
      onChange({ ...value, object: null });
      return;
    }
    const name = objects?.find(object => object.key === key)?.name ?? value.object?.name ?? key;
    onChange({ ...value, object: { key, name } });
  };

  const objectsEmptyText = objectsQuery.isError ? 'Не удалось загрузить' : objects ? 'Не найдено' : 'Загрузка…';

  return (
    <>
      <div className={styles.category}>
        <SearchableSelect
          options={CATEGORY_OPTIONS}
          value={value.category ?? ''}
          onChange={next => onChange({ ...value, category: next ? next as StaffCategory : null })}
          allLabel="Все категории"
          placeholder="Категория..."
          ariaLabel="Категория"
        />
      </div>
      {/* Фокус поля (всплывает из input) — сигнал грузить список; упавший — повторить. */}
      <div
        className={styles.object}
        onFocus={() => {
          setObjectsWanted(true);
          if (objectsQuery.isError) void objectsQuery.refetch();
        }}
      >
        <SearchableSelect
          options={objectOptions}
          value={value.object?.key ?? ''}
          onChange={pickObject}
          allLabel="Все объекты"
          placeholder="Поиск объекта..."
          ariaLabel="Объект"
          emptyText={objectsEmptyText}
        />
      </div>
    </>
  );
};
