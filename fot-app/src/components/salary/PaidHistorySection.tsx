import { useMemo, useState, type CSSProperties, type FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';

import { payrollService } from '../../services/payrollService';
import { moscowCurrentMonth } from '../../utils/moscowDate';
import { formatAccrualMonthLabel } from '../../utils/payrollAccruals';
import {
  formatPaidAmount,
  paidHistory,
  PAYROLL_PAID_ALL_FROM,
  type IPaidHistoryMonth,
  type PayrollPaidTotalKind,
} from '../../utils/payrollPaid';
import { PaidPayslipRow } from './PaidPayslipRow';
import disclosure from './PayrollDisclosure.module.css';
import paidTable from './PayrollPaidTable.module.css';

interface IPaidHistorySectionProps {
  employeeId: number;
  /** Должность сотрудника — первая строка расчётного листка. */
  positionName: string | null;
}

const SUM_COLUMNS: ReadonlyArray<{ kind: PayrollPaidTotalKind | 'payout'; label: string }> = [
  { kind: 'accrued', label: 'Начислено' },
  { kind: 'deducted', label: 'Удержано' },
  { kind: 'payout', label: 'К выплате' },
];

// Ширина таблицы — по числу столбцов сумм (см. .table в PayrollPaidTable.module.css).
const WIDTH_VARS = { '--paid-cols': SUM_COLUMNS.length } as CSSProperties;

const formatTotal = (value: number | null): string => (value === null ? '—' : formatPaidAmount(value));

const monthValue = (entry: IPaidHistoryMonth, kind: PayrollPaidTotalKind | 'payout'): number | null => (
  kind === 'payout' ? entry.payout : entry.totals[kind]
);

/**
 * «История выплат» — раскрываемый блок карточки, свёрнут по умолчанию. Все месяцы, за которые из 1С
 * пришли суммы «Оплачено», новые сверху: «Начислено», «Удержано» и «К выплате» (начислено минус удержано,
 * как в «Своде»). Клик по месяцу раскрывает его расчётный листок (PaidPayslipRow). Только чтение.
 */
export const PaidHistorySection: FC<IPaidHistorySectionProps> = ({ employeeId, positionName }) => {
  // «Сейчас» — на момент открытия карточки.
  const [toMonth] = useState(moscowCurrentMonth);
  const historyQuery = useQuery({
    // Под префиксом 'payroll-terms': сохранение карточки перечитывает и суммы.
    queryKey: ['payroll-terms', 'paid-history', employeeId, toMonth],
    queryFn: ({ signal }) => payrollService.getPaid(employeeId, PAYROLL_PAID_ALL_FROM, toMonth, signal),
    staleTime: 30_000,
  });
  const history = useMemo(() => (historyQuery.data ? paidHistory(historyQuery.data) : null), [historyQuery.data]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleMonth = (month: string) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(month)) next.delete(month);
    else next.add(month);
    return next;
  });

  let meta: string;
  if (historyQuery.isPending) meta = 'загрузка…';
  else if (historyQuery.isError) meta = 'не удалось загрузить';
  else meta = history && history.months.length > 0 ? `месяцев: ${history.months.length}` : 'выплат нет';

  return (
    <details className={disclosure.disclosure}>
      <summary className={disclosure.summary}>
        <span className={disclosure.summaryHead}>
          <ChevronRight size={16} className={disclosure.chevron} aria-hidden="true" />
          <span className={disclosure.summaryTitle}>История выплат</span>
        </span>
        <span className={historyQuery.isError ? `${disclosure.summaryMeta} ${disclosure.summaryMetaError}` : disclosure.summaryMeta}>
          {meta}
        </span>
      </summary>

      <div className={disclosure.content}>
        {historyQuery.isPending && <p className={disclosure.state}>Загрузка…</p>}
        {historyQuery.isError && (
          <div className={disclosure.stateError}>
            <span>Не удалось загрузить выплаты</span>
            <button type="button" className={disclosure.retryButton} onClick={() => { void historyQuery.refetch(); }}>
              Повторить
            </button>
          </div>
        )}

        {history && history.months.length === 0 && <p className={disclosure.state}>Выплат из 1С пока нет.</p>}

        {history && history.months.length > 0 && (
          <div className={paidTable.scroll} style={WIDTH_VARS}>
            <table className={paidTable.table} aria-label="История выплат">
              <thead>
                <tr>
                  <th scope="col" className={paidTable.corner}>Месяц</th>
                  {SUM_COLUMNS.map(column => (
                    <th key={column.kind} scope="col" className={paidTable.monthHead}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              {history.months.map(entry => {
                const open = expanded.has(entry.month);
                return (
                  <tbody key={entry.month}>
                    {/* Клик и Enter/Space с кнопки всплывают до строки. */}
                    <tr className={paidTable.totalRow} onClick={() => toggleMonth(entry.month)}>
                      <th scope="row" className={`${paidTable.rowHead} ${paidTable.totalHead}`}>
                        <button type="button" className={paidTable.totalToggle} aria-expanded={open}>
                          <ChevronRight size={16} className={paidTable.chevron} aria-hidden="true" />
                          {formatAccrualMonthLabel(entry.month, true)}
                        </button>
                      </th>
                      {SUM_COLUMNS.map(column => (
                        <td key={column.kind} className={paidTable.total}>{formatTotal(monthValue(entry, column.kind))}</td>
                      ))}
                    </tr>
                    {open && (
                      <PaidPayslipRow
                        employeeId={employeeId}
                        month={entry.month}
                        positionName={positionName}
                        amounts={history.amounts}
                        totals={entry.totals}
                        colSpan={SUM_COLUMNS.length + 1}
                      />
                    )}
                  </tbody>
                );
              })}
              {history.months.length > 1 && (
                <tbody>
                  <tr>
                    <th scope="row" className={`${paidTable.rowHead} ${paidTable.totalHead}`}>Итого</th>
                    {SUM_COLUMNS.map(column => (
                      <td key={column.kind} className={paidTable.total}>
                        {formatTotal(column.kind === 'payout' ? history.overallPayout : history.overall[column.kind])}
                      </td>
                    ))}
                  </tr>
                </tbody>
              )}
            </table>
          </div>
        )}
      </div>
    </details>
  );
};
