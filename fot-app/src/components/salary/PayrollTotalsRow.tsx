import { memo, useMemo, useState, type FC, type ReactNode } from 'react';
import { ArrowLeft, Minus, Plus } from 'lucide-react';

import type { IPayrollTermsRow } from '../../services/payrollService';
import { cx } from '../../utils/motion';
import {
  payrollColumnTotals,
  payrollTotalState,
  splitPayrollTotalsRows,
  type IPayrollColumnTotal,
  type IPayrollTotalsStatus,
} from '../../utils/payrollCalcTotals';
import { formatPaidAmount } from '../../utils/payrollPaid';
import type { PayrollTableColumnEntry } from '../../utils/payrollSubColumns';
import styles from './PayrollTermsTable.module.css';

interface IPayrollTotalsRowProps {
  rows: readonly IPayrollTermsRow[];
  /** Те же столбцы по порядку, что в colgroup, шапке и строках. */
  columns: readonly PayrollTableColumnEntry[];
  status: IPayrollTotalsStatus;
  /** Оформление групп «+» по ключу столбца — как в ячейках строк. */
  groupCellClass: (key: string) => string | undefined;
  /** Клик по «Не посчитано, N чел.» — в таблице только эти люди; нет — подпись не нажимается. */
  onShowUncounted?: () => void;
  /**
   * В таблице только «не посчитанные» (после клика по «Не посчитано»): одна строка «← Не посчитано, N чел.», «←» — снова
   * все. Без этого все строки — «не посчитанные», и подвал был бы просто «Итого» без пути назад.
   */
  onHideUncounted?: () => void;
}

/** Открыта ли строка «Не посчитано» — удобство браузера; по умолчанию скрыта (решение 12.11.2026). */
const UNCOUNTED_OPEN_KEY = 'fot:payroll-calc:uncounted-open';

const loadUncountedOpen = (): boolean => {
  try {
    return window.localStorage.getItem(UNCOUNTED_OPEN_KEY) === '1';
  } catch {
    return false;
  }
};

const saveUncountedOpen = (open: boolean): void => {
  try {
    if (open) window.localStorage.setItem(UNCOUNTED_OPEN_KEY, '1');
    else window.localStorage.removeItem(UNCOUNTED_OPEN_KEY);
  } catch {
    // Хранилище недоступно (приватный режим, запрет) — выбор живёт до перезагрузки страницы.
  }
};

interface ITotalsLine {
  key: 'all' | 'counted' | 'uncounted' | 'uncountedOnly';
  label: string;
  totals: Map<string, IPayrollColumnTotal>;
  className?: string;
}

/**
 * «Итого» «Расчётов»: подвал той же таблицы, закреплён снизу обёртки (sticky), как шапка сверху. Столбцы совпадают сами,
 * при прокрутке вбок едет вместе с таблицей, а последняя строка списка не уходит под него.
 *
 * Когда ФОТ посчитан, а у части людей «Суммы» нет, — две строки (splitPayrollTotalsRows): «Итого (посчитано)», где
 * «Сумма» − «Выплаты на карту» = «Остаток», и «Не посчитано, N чел.» — суммы 1С людей без «Суммы». Вторая занимает
 * место, поэтому по умолчанию скрыта: её открывает «+» у «Итого (посчитано)».
 */
export const PayrollTotalsRow: FC<IPayrollTotalsRowProps> = memo(({
  rows, columns, status, groupCellClass, onShowUncounted, onHideUncounted,
}) => {
  const [uncountedOpen, setUncountedOpen] = useState(loadUncountedOpen);
  const toggleUncounted = () => {
    const next = !uncountedOpen;
    setUncountedOpen(next);
    saveUncountedOpen(next);
  };

  const uncountedOnly = Boolean(onHideUncounted);
  const lines = useMemo<ITotalsLine[]>(() => {
    const ready = status.rows === 'ready' && status.calc === 'ready';
    if (uncountedOnly) {
      // Пока порции и расчёт идут, число было бы частью выборки — без него.
      const label = ready ? `Не посчитано, ${rows.length.toLocaleString('ru-RU')} чел.` : 'Не посчитано';
      return [{ key: 'uncountedOnly', label, totals: payrollColumnTotals(rows, columns) }];
    }
    const groups = ready ? splitPayrollTotalsRows(rows) : null;
    if (!groups) return [{ key: 'all', label: 'Итого', totals: payrollColumnTotals(rows, columns) }];
    return [
      { key: 'counted', label: 'Итого (посчитано)', totals: payrollColumnTotals(groups.counted, columns) },
      {
        key: 'uncounted',
        label: `Не посчитано, ${groups.uncounted.length.toLocaleString('ru-RU')} чел.`,
        totals: payrollColumnTotals(groups.uncounted, columns),
        className: styles.totalsUncounted,
      },
    ];
  }, [rows, columns, status.rows, status.calc, uncountedOnly]);

  const renderAmount = (total: IPayrollColumnTotal): ReactNode => {
    const state = payrollTotalState(status, total.fromCalc);
    if (state === 'pending') return <span className={styles.calcMuted} aria-label="Считается">…</span>;
    if (state === 'failed' || total.amount === null) return '—';
    return formatPaidAmount(Number(total.amount));
  };

  const uncounted = lines.find(line => line.key === 'uncounted');
  const shownLines = uncountedOpen ? lines : lines.filter(line => line.key !== 'uncounted');
  const ToggleIcon = uncountedOpen ? Minus : Plus;

  return (
    <tfoot>
      {shownLines.map(line => (
        <tr key={line.key} className={line.className}>
          <td className={`${styles.stickyNum} ${styles.cellNum}`} />
          <td className={styles.stickyName}>
            {line.key === 'uncountedOnly' && onHideUncounted ? (
              <span className={styles.totalsLabel}>
                <button
                  type="button"
                  className={styles.expandButton}
                  aria-label="Назад ко всем сотрудникам"
                  onClick={onHideUncounted}
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                </button>
                {line.label}
              </span>
            ) : line.key === 'counted' && uncounted ? (
              <span className={styles.totalsLabel}>
                {line.label}
                <button
                  type="button"
                  className={styles.expandButton}
                  aria-expanded={uncountedOpen}
                  aria-label={`${uncountedOpen ? 'Скрыть' : 'Показать'} «${uncounted.label}»`}
                  onClick={toggleUncounted}
                >
                  <ToggleIcon size={14} aria-hidden="true" />
                </button>
              </span>
            ) : line.key === 'uncounted' && onShowUncounted ? (
              <button
                type="button"
                className={styles.totalsLink}
                aria-label={`Показать: ${line.label.toLowerCase()}`}
                onClick={onShowUncounted}
              >
                {line.label}
              </button>
            ) : line.label}
          </td>
          {columns.map(entry => {
            const total = line.totals.get(entry.key);
            const className = groupCellClass(entry.key);
            if (!total) return <td key={entry.key} className={className} />;
            // Подсказка — только когда итог готов: иначе она говорила бы о части выборки.
            const ready = payrollTotalState(status, total.fromCalc) === 'ready';
            return (
              <td key={entry.key} className={cx(styles.cellNumber, className)} title={ready ? total.title ?? undefined : undefined}>
                {renderAmount(total)}
              </td>
            );
          })}
        </tr>
      ))}
    </tfoot>
  );
});

PayrollTotalsRow.displayName = 'PayrollTotalsRow';
