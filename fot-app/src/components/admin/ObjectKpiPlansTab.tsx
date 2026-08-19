import type { Dispatch, FC, SetStateAction } from 'react';

import type { IObjectKpiCard } from '../../api/objectKpi';
import { formatDate, formatMoney, formatMonthLabel, formatPercent } from '../../utils/formatMoney';
import { formatMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Вкладка «План месяца»: расчёт по месяцам с правкой плана.
 *
 * Состояние правок живёт в модалке, а не здесь: кнопка «Сохранить» в её футере применяет
 * то, что изменено на текущей вкладке. Компонент выделен, чтобы карточка не переваливала
 * за лимит в 500 строк.
 *
 * Факт здесь только показывается. Он собирается из подписанных КС-2 (п. 3.1) и правится
 * на вкладке КС-2 — суммой записи и комментарием к ней.
 *
 * ВАЖНО: многострочные ячейки обёрнуты в <div>, а не размечены прямо на <td>. Ячейка
 * с display:flex перестаёт быть table-cell, и браузер сливает две соседние такие ячейки
 * в одну анонимную — именно так план и факт оказывались в одном столбце.
 */

export type PlanDraft = Record<string, { amount: string; reason: string }>;

interface IProps {
  card: IObjectKpiCard | undefined;
  canEdit: boolean;
  /** Право пересматривать зафиксированный план (руководитель эк. отдела или админ). */
  canRevisePlan: boolean;
  planEdits: PlanDraft;
  setPlanEdits: Dispatch<SetStateAction<PlanDraft>>;
  onFixMonth: (periodMonth: string) => void;
}

export const ObjectKpiPlansTab: FC<IProps> = ({
  card,
  canEdit,
  canRevisePlan,
  planEdits,
  setPlanEdits,
  onFixMonth,
}) => (
  <div className={styles.tableWrap}>
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Месяц</th><th>Остаток</th><th>Мес.</th><th>План</th><th>Факт</th>
          <th>%</th><th>Статус</th><th /></tr>
      </thead>
      <tbody>
        {(card?.report ?? []).map(row => {
          const plan = card?.plans.find(p => p.period_month === row.period_month && p.is_current);
          // Правка доступна в любой момент, а не только после фиксации: у открытого месяца
          // ручной становится только сумма плана, сам месяц остаётся открытым.
          const editable = canEdit && canRevisePlan;
          const draft = planEdits[row.period_month];
          return (
            <tr key={row.period_month}>
              <td>{formatMonthLabel(row.period_month)}</td>
              <td>{formatMoney(row.remainder)}</td>
              <td>{row.months_remaining ?? '—'}</td>
              <td>
                <div className={styles.planCell}>
                  {draft ? (
                    <>
                      <input
                        className={styles.cellInput}
                        inputMode="decimal"
                        value={draft.amount}
                        onChange={(event) => setPlanEdits(prev => ({
                          ...prev,
                          [row.period_month]: {
                            ...prev[row.period_month],
                            amount: formatMoneyInput(event.target.value),
                          },
                        }))}
                      />
                      <input
                        className={styles.cellInput}
                        placeholder="Обоснование"
                        value={draft.reason}
                        onChange={(event) => setPlanEdits(prev => ({
                          ...prev,
                          [row.period_month]: {
                            ...prev[row.period_month],
                            reason: event.target.value,
                          },
                        }))}
                      />
                    </>
                  ) : (
                    <button
                      type="button"
                      className={editable ? styles.planValueBtn : styles.planValue}
                      disabled={!editable}
                      title={editable
                        ? 'Изменить план месяца'
                        : 'Правка плана доступна руководителю эк. отдела'}
                      onClick={() => setPlanEdits(prev => ({
                        ...prev,
                        [row.period_month]: {
                          amount: toMoneyInput(row.plan_amount),
                          reason: '',
                        },
                      }))}
                    >
                      {formatMoney(row.plan_amount)}
                      {row.plan_overridden && <span className={styles.mark} title="Задан вручную">✎</span>}
                    </button>
                  )}
                  {plan?.correction_reason && !draft && (
                    <span className={styles.planReason}>
                      ✎ {plan.correction_reason}
                      {plan.fixed_by_name ? ` · ${plan.fixed_by_name}` : ''}
                      {plan.fixed_at ? ` · ${formatDate(plan.fixed_at.slice(0, 10))}` : ''}
                    </span>
                  )}
                </div>
              </td>
              {/* Факт — сумма подписанных КС-2 (п. 3.1). Правится на вкладке КС-2. */}
              <td>{formatMoney(row.fact_amount)}</td>
              <td>{formatPercent(row.completion_pct)}</td>
              <td>
                {row.report_status}
                {plan && plan.revision > 1 && <span className={styles.mark}>ревизия {plan.revision}</span>}
              </td>
              <td className={styles.actions}>
                {canEdit && row.report_status === 'open' && (
                  <button type="button" onClick={() => onFixMonth(row.period_month)}>
                    Зафиксировать
                  </button>
                )}
              </td>
            </tr>
          );
        })}
        {(card?.report ?? []).length === 0 && (
          <tr><td colSpan={8} className={styles.empty}>Нет расчётных месяцев в периоде</td></tr>
        )}
      </tbody>
    </table>
  </div>
);
