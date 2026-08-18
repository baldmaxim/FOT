import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { objectKpiApi } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { PremiumHero } from '../../components/employee/objects/PremiumHero';
import { PremiumMonthsTable } from '../../components/employee/objects/PremiumMonthsTable';
import { ScaleTable } from '../../components/employee/objects/ScaleTable';
import { formatMonthLabel } from '../../utils/formatMoney';
import styles from './EmployeeObjectsPage.module.css';

/**
 * ЛК руководителя строительства: KPI по своим объектам и ПРЕДВАРИТЕЛЬНЫЙ расчёт премии.
 *
 * Только чтение и только свои закрепления — чужие проценты и ввод данных живут на вкладке
 * «KPI объектов» в админке. Все суммы приходят с сервера готовыми: денежная арифметика
 * на фронте запрещена (numeric приходит строкой).
 */

/** Глубина истории под плашкой месяца. */
const WINDOW_MONTHS = 12;

const shiftMonth = (month: string, delta: number): string => {
  const [year, value] = month.slice(0, 7).split('-').map(Number);
  const total = year * 12 + (value - 1) + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
};

/**
 * Текущий месяц по Москве, как везде в проекте: toISOString() отдаёт UTC и ночью по МСК
 * показал бы предыдущий месяц.
 */
const currentMonth = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date()).slice(0, 7);

export const EmployeeObjectsPage: FC = () => {
  // Два состояния намеренно: anchor задаёт окно запроса, selected — раскрытый месяц.
  // С одним состоянием клик по строке сдвигал бы окно, и таблица «прыгала» бы под курсором.
  const [anchorMonth, setAnchorMonth] = useState(currentMonth);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const period = useMemo(
    () => ({ from: shiftMonth(anchorMonth, -(WINDOW_MONTHS - 1)), to: anchorMonth }),
    [anchorMonth],
  );

  const query = useQuery({
    queryKey: objectKpiKeys.myObjects(period.from, period.to),
    queryFn: () => objectKpiApi.getMyObjects(period),
  });

  const premium = useMemo(() => query.data?.premium ?? [], [query.data]);
  const scales = useMemo(() => query.data?.scales ?? [], [query.data]);

  // Свежий месяц сверху: он же по умолчанию раскрыт в плашке.
  const monthsDesc = useMemo(
    () => [...premium].sort((a, b) => b.period_month.localeCompare(a.period_month)),
    [premium],
  );

  // Выбранный месяц — производная, а не состояние-копия: при смене окна прежний выбор
  // может исчезнуть из выдачи, и синхронизировать его эффектом значило бы лишний рендер.
  const activeMonth = useMemo(
    () => monthsDesc.find((month) => month.period_month === selectedMonth) ?? monthsDesc[0] ?? null,
    [monthsDesc, selectedMonth],
  );

  const activeScale = useMemo(
    () => scales.find((scale) => scale.id === activeMonth?.scale_version_id) ?? null,
    [scales, activeMonth],
  );

  const rangeLabel = `${formatMonthLabel(period.from)} — ${formatMonthLabel(period.to)}`;

  /**
   * Месяц внутри уже загруженного окна только выбирается: сдвиг якоря выбросил бы из
   * таблицы месяцы после выбранного (выбрал май — пропали июнь–август). Окно двигается
   * лишь когда выбранный месяц за его границами.
   */
  const handleMonthChange = (month: string): void => {
    const value = month.slice(0, 7);
    if (value < period.from || value > period.to) setAnchorMonth(value);
    setSelectedMonth(`${value}-01`);
  };

  return (
    <div className={styles.page}>
      {query.isLoading && <p className={styles.empty}>Загрузка…</p>}
      {query.isError && <p className={styles.empty}>Не удалось загрузить данные</p>}

      {!query.isLoading && !query.isError && (
        <>
          <PremiumHero
            month={activeMonth}
            scale={activeScale}
            isCurrentMonth={activeMonth?.period_month.slice(0, 7) === currentMonth()}
            // Активный месяц, а не якорь: иначе шапка показывала бы границу окна.
            pickerValue={activeMonth?.period_month ?? selectedMonth ?? `${anchorMonth}-01`}
            pickerMax={currentMonth()}
            onMonthChange={handleMonthChange}
          />

          <p className={styles.note}>
            Предварительный расчёт по приказу: не является утверждённым начислением.
            План и факт — в рублях с НДС. Премия и зарплата — до НДФЛ.
          </p>

          <ScaleTable
            scale={activeScale}
            interpolation={activeMonth?.interpolation ?? null}
            completionPct={activeMonth?.completion_pct ?? null}
          />

          {monthsDesc.length > 0 && (
            <PremiumMonthsTable
              months={monthsDesc}
              selected={activeMonth?.period_month ?? null}
              onSelect={setSelectedMonth}
              rangeLabel={rangeLabel}
            />
          )}

        </>
      )}
    </div>
  );
};
