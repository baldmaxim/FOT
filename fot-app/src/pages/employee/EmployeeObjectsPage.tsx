import { useMemo, useState, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';

import { objectKpiApi, type IObjectKpiMyRow } from '../../api/objectKpi';
import { objectKpiKeys } from '../../api/queryKeys';
import { PremiumHero } from '../../components/employee/objects/PremiumHero';
import { PremiumMonthsTable } from '../../components/employee/objects/PremiumMonthsTable';
import { ScaleTable } from '../../components/employee/objects/ScaleTable';
import {
  formatDate,
  formatMoney,
  formatMoneyWhole,
  formatMonthLabel,
  formatPercent2,
} from '../../utils/formatMoney';
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

/** Причина, по которой месяц объекта не участвует в премии. */
const EXCLUSION_LABEL: Record<'not_assigned' | 'no_plan', string> = {
  not_assigned: 'вне вашего закрепления',
  no_plan: 'план не определён',
};

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

  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const premium = useMemo(() => query.data?.premium ?? [], [query.data]);
  const totals = query.data?.period_totals;
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

  const calculatedCount = useMemo(
    () => premium.filter((month) => month.status === 'calculated').length,
    [premium],
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

  // Группируем по объекту: карточка на объект, внутри — месяцы.
  const byObject = useMemo(() => {
    const map = new Map<string, { name: string; rows: IObjectKpiMyRow[] }>();
    for (const row of rows) {
      const entry = map.get(row.skud_object_id) ?? { name: row.object_name, rows: [] };
      entry.rows.push(row);
      map.set(row.skud_object_id, entry);
    }
    return [...map.entries()];
  }, [rows]);

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
            Суммы в рублях с НДС, премия — до НДФЛ.
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

          {totals && (
            <section className={styles.totals}>
              <div className={styles.totalsHead}>
                Итого по рассчитанным месяцам: {calculatedCount} из {premium.length}
                <span className={styles.totalsRange}>{rangeLabel}</span>
              </div>
              <div className={styles.summary}>
                <div>
                  <span>План КС-2</span>
                  <strong>{formatMoney(totals.total_plan)}</strong>
                </div>
                <div>
                  <span>Факт КС-2</span>
                  <strong>{formatMoney(totals.total_fact)}</strong>
                </div>
                <div>
                  <span>Выполнение</span>
                  <strong>{formatPercent2(totals.completion_pct)}</strong>
                </div>
                <div>
                  <span>Премия</span>
                  <strong>{formatMoneyWhole(totals.total_premium)}</strong>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {!query.isLoading && byObject.length === 0 && (
        <p className={styles.empty}>За выбранный период за вами не закреплено объектов</p>
      )}

      {byObject.map(([objectId, group]) => (
        <section key={objectId} className={styles.card}>
          <header className={styles.cardHeader}>
            <h2>{group.name}</h2>
            <span className={styles.cardMeta}>
              Плановая ЗОС: {formatDate(group.rows[0]?.planned_zos_date)} ·
              контрольная дата: {formatDate(group.rows[0]?.control_date)}
            </span>
          </header>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Месяц</th><th>Остаток</th><th>Мес.</th><th>План объекта</th>
                  <th>Ваша доля</th><th>Ваш план</th><th>Ваш факт</th><th>%</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map(row => (
                  <tr key={row.period_month}>
                    <td>
                      {formatMonthLabel(row.period_month)}
                      {row.exclusion_reason && (
                        <> · <span className={styles.rowNote}>
                          {EXCLUSION_LABEL[row.exclusion_reason]}
                        </span></>
                      )}
                    </td>
                    <td>{formatMoney(row.remainder)}</td>
                    <td>{row.months_remaining ?? '—'}</td>
                    <td>{formatMoney(row.plan_amount)}</td>
                    <td>
                      {row.my_days > 0
                        ? `${formatPercent2(row.my_share_pct)} (${row.my_days} из ${row.total_days} дн.)`
                        : '—'}
                    </td>
                    <td>{formatMoney(row.my_plan_amount)}</td>
                    <td>{formatMoney(row.my_fact_amount)}</td>
                    {/* Прочерк вместо «0 %»: полностью закрытый объект не провалил KPI. */}
                    <td>{formatPercent2(row.completion_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
};
