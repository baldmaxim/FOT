import type { FC } from 'react';

import type { IZup3ExportCell } from '../../services/payrollService';
import { formatDate } from '../../utils/formatMoney';
import styles from './PayrollZup3Badge.module.css';

interface IPayrollZup3BadgeProps {
  cell: IZup3ExportCell;
  /** Подпись месяца — когда в «Расчётах» выбрано несколько месяцев. */
  showMonth: boolean;
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const monthLabel = (month: string): string => MONTHS[Number(month.slice(5, 7)) - 1] ?? month;

/** «1–15» или «16–30» (последний день месяца). */
const halfLabel = (month: string, half: 1 | 2): string => {
  if (half === 1) return '1–15';
  const [year, monthNumber] = month.split('-').map(Number);
  return `16–${new Date(year, monthNumber, 0).getDate()}`;
};

const dateTime = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const LABEL: Record<IZup3ExportCell['state'], string> = {
  not_ready: 'Не готов',
  ready: 'Готов к выгрузке',
  exported: 'Выгружен',
  changed: 'Изменён после выгрузки',
};

/**
 * Статус выгрузки объектов и часов в ЗУП3 за половину месяца — строкой под выплатами 1С в «Расчётах». «Выгружен»
 * ставится сам, когда 1С подтвердила приём данных этой половины; «Не готов» — половина не закончилась или табель за
 * неё не закрыт.
 */
export const PayrollZup3Badge: FC<IPayrollZup3BadgeProps> = ({ cell, showMonth }) => {
  const acked = cell.state === 'exported' && cell.acked_at ? ` ${formatDate(cell.acked_at.slice(0, 10))}` : '';
  const title = [
    cell.state === 'not_ready' ? 'Половина не закончилась или табель за неё не закрыт — данные предварительные' : null,
    cell.state === 'changed' ? 'Данные изменились после выгрузки — ЗУП3 заберёт их заново' : null,
    cell.acked_at ? `Подтверждено 1С: ${dateTime(cell.acked_at)}` : null,
    cell.document_ref ? `Документ 1С: ${cell.document_ref}` : null,
    cell.computed_at ? `Данные на ${dateTime(cell.computed_at)}` : null,
  ].filter(Boolean).join('\n');
  return (
    <span className={`${styles.badge} ${styles[cell.state]}`} title={title || undefined}>
      <span className={styles.prefix}>ЗУП3{showMonth ? ` · ${monthLabel(cell.month)}` : ''} {halfLabel(cell.month, cell.half)}:</span>
      {LABEL[cell.state]}{acked}
    </span>
  );
};
