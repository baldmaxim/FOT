import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { payrollService, type PayrollDepartmentGroup } from '../../services/payrollService';
import type { ICalcObject } from '../../utils/payrollViews';
import { SearchableSelect, type ISearchableSelectOption } from '../ui/SearchableSelect';
import styles from './PayrollObjectFilterField.module.css';

interface IPayrollObjectFilterFieldProps {
  /** Месяцы «Расчётов» (YYYY-MM); null — ещё не известны, список объектов не грузится. */
  months: string[] | null;
  date: string;
  /** Отдел или группа отделов «Расчётов»: объекты — их сотрудников. */
  departmentId: string;
  group: PayrollDepartmentGroup | null;
  value: ICalcObject | null;
  onChange: (next: ICalcObject | null) => void;
}

/**
 * «Расчёты»: «Все объекты» рядом с «Все отделы» — объект месяца, как в «Своде». Список объектов считает сервер (тяжело),
 * поэтому он грузится при первом фокусе поля, а не с открытием экрана. Выбранный объект, которого нет в новом списке
 * (другие месяцы, отдел или группа), показывается по сохранённому имени.
 */
export const PayrollObjectFilterField: FC<IPayrollObjectFilterFieldProps> = ({
  months, date, departmentId, group, value, onChange,
}) => {
  const [wanted, setWanted] = useState(false);
  const objectsQuery = useQuery({
    queryKey: ['payroll-terms', 'month-objects', months, date, departmentId, group],
    queryFn: ({ signal }) => payrollService.monthObjects(
      { months: months ?? [], date, departmentId: departmentId || undefined, group: group ?? undefined },
      signal,
    ),
    enabled: wanted && months !== null && months.length > 0,
    staleTime: 60_000,
  });

  const objects = objectsQuery.data;
  const options = useMemo(() => {
    const list: ISearchableSelectOption[] = (objects ?? []).map(object => ({
      value: object.key,
      label: `${object.name} (${object.count})`,
    }));
    if (value && !list.some(option => option.value === value.key)) list.unshift({ value: value.key, label: value.name });
    return list;
  }, [objects, value]);

  const pick = (key: string) => {
    if (!key) {
      onChange(null);
      return;
    }
    onChange({ key, name: objects?.find(object => object.key === key)?.name ?? value?.name ?? key });
  };

  const emptyText = objectsQuery.isError ? 'Не удалось загрузить' : objects ? 'Не найдено' : 'Загрузка…';

  return (
    // Фокус поля (всплывает из input) — сигнал грузить список; упавший — повторить.
    <div
      className={styles.object}
      onFocus={() => {
        setWanted(true);
        if (objectsQuery.isError) void objectsQuery.refetch();
      }}
    >
      <SearchableSelect
        options={options}
        value={value?.key ?? ''}
        onChange={pick}
        allLabel="Все объекты"
        placeholder="Поиск объекта..."
        ariaLabel="Объект"
        emptyText={emptyText}
      />
    </div>
  );
};
