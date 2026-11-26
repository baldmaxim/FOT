import { type FC } from 'react';
import type { EmployeeSign } from '../../types';
import { formatDate } from '../../utils/formatMoney';
import { toMoscowDateIso } from '../../utils/moscowDate';

const SIGN_CLASS: Record<EmployeeSign, string> = {
  'Работает': 'sc-sign--working',
  'Уволен': 'sc-sign--fired',
  'Неактивен': 'sc-sign--inactive',
};

interface IStaffSignBadgeProps {
  sign: EmployeeSign | undefined;
  /** Ручная метка «Неактивный» (ISO-время): дата перевода по Москве — во всплывающей подсказке. */
  inactiveAt?: string | null;
}

const inactiveTitle = (inactiveAt: string | null | undefined): string | undefined => {
  if (!inactiveAt) return undefined;
  const moment = new Date(inactiveAt);
  return Number.isNaN(moment.getTime()) ? undefined : `Переведён в неактивные ${formatDate(toMoscowDateIso(moment))}`;
};

/** «Признак»: Работает / Уволен / Неактивен. До прихода данных — скелетон той же высоты. */
export const StaffSignBadge: FC<IStaffSignBadgeProps> = ({ sign, inactiveAt }) => {
  if (!sign) return <span className="sc-skeleton sc-skeleton--short" aria-label="Загрузка" />;
  const title = sign === 'Неактивен' ? inactiveTitle(inactiveAt) : undefined;
  return <span className={`sc-sign ${SIGN_CLASS[sign] ?? 'sc-sign--inactive'}`} title={title}>{sign}</span>;
};
