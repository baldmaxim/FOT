import type { Dispatch, FC, SetStateAction } from 'react';

import type { IObjectKpiCard } from '../../api/objectKpi';
import { formatDate, formatMoney, formatMonthLabel, formatPercent } from '../../utils/formatMoney';
import { formatMoneyInput, toMoneyInput } from '../../utils/moneyInput';
import styles from './ObjectKpiCardModal.module.css';

/**
 * Вкладка «План месяца»: расчёт по месяцам с правкой плана и факта.
 *
 * Состояние правок живёт в модалке, а не здесь: кнопка «Сохранить» в её футере применяет
 * то, что изменено на текущей вкладке. Компонент выделен, чтобы карточка не переваливала
 * за лимит в 500 строк.
 *
 * Факт не переписывается числом: по приказу это сумма подписанных КС-2 (п. 3.1), поэтому
 * правка уходит целевой суммой, а сервер заводит корректирующий акт на разницу.
 */

export type PlanDraft = Record<string, { amount: string; reason: string }>;
export interface IFactDraft { month: string; amount: string; reason: string }

interface IProps {
  card: IObjectKpiCard | undefined;
  canEdit: boolean;
  /** Право пересматривать зафиксированный план (руководитель эк. отдела или админ). */
  canRevisePlan: boolean;
  /** Текущий месяц по МСК: у будущих месяцев факт не корректируется. */
  currentMonth: string;
  /** Месяц → причина последней корректировки факта (записи КС-2 с source=fact_adjustment). */
  factAdjustments: Map<string, string>;
  planEdits: PlanDraft;
  setPlanEdits: Dispatch<SetStateAction<PlanDraft>>;
  factEdit: IFactDraft | null;
  setFactEdit: Dispatch<SetStateAction<IFactDraft | null>>;
  factPending: boolean;
  onSubmitFact: (draft: IFactDraft) => void;
  onFixMonth: (periodMonth: string) => void;
}

export const ObjectKpiPlansTab: FC<IProps> = ({
  card,
  canEdit,
  canRevisePlan,
  currentMonth,
  factAdjustments,
  planEdits,
  setPlanEdits,
  factEdit,
  setFactEdit,
  factPending,
  onSubmitFact,
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
          const fixed = row.report_status === 'fixed' || row.report_status === 'corrected';
          const editable = canEdit && canRevisePlan && fixed;
          const draft = planEdits[row.period_month];
          const factDraft = factEdit?.month === row.period_month ? factEdit : null;
          // Будущий месяц корректировать нечем: акт с датой подписания вперёд —
          // ошибка ввода, сервер такой запрос тоже отклонит.
          const factEditable = canEdit && row.period_month.slice(0, 7) <= currentMonth;
          return (
            <tr key={row.period_month}>
              <td>{formatMonthLabel(row.period_month)}</td>
              <td>{formatMoney(row.remainder)}</td>
              <td>{row.months_remaining ?? '—'}</td>
              <td className={styles.planCell}>
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
                      : 'Правка доступна руководителю эк. отдела после фиксации месяца'}
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
              </td>
              <td className={styles.planCell}>
                {factDraft ? (
                  <>
                    <input
                      className={styles.cellInput}
                      inputMode="decimal"
                      value={factDraft.amount}
                      onChange={(event) => setFactEdit({
                        ...factDraft,
                        amount: formatMoneyInput(event.target.value),
                      })}
                    />
                    <input
                      className={styles.cellInput}
                      placeholder="Причина корректировки"
                      value={factDraft.reason}
                      onChange={(event) => setFactEdit({ ...factDraft, reason: event.target.value })}
                    />
                    <span className={styles.factActions}>
                      <button
                        type="button"
                        onClick={() => onSubmitFact(factDraft)}
                        disabled={factPending}
                      >
                        Сохранить
                      </button>
                      <button type="button" onClick={() => setFactEdit(null)}>Отмена</button>
                    </span>
                  </>
                ) : (
                  <button
                    type="button"
                    className={factEditable ? styles.planValueBtn : styles.planValue}
                    disabled={!factEditable}
                    title={factEditable
                      ? 'Изменить факт: система заведёт корректирующий акт КС-2 на разницу'
                      : 'Факт будущего месяца не корректируется'}
                    onClick={() => setFactEdit({
                      month: row.period_month,
                      amount: toMoneyInput(row.fact_amount),
                      reason: '',
                    })}
                  >
                    {formatMoney(row.fact_amount)}
                  </button>
                )}
                {/* Причина живёт в корректирующем акте (source='fact_adjustment'),
                    поэтому переживает перезагрузку и видна во вкладке КС-2. */}
                {!factDraft && factAdjustments.get(row.period_month) && (
                  <span className={styles.planReason}>
                    ✎ {factAdjustments.get(row.period_month)}
                  </span>
                )}
              </td>
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
