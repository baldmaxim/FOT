import { type FC } from 'react';
import type { EmployeeSign } from '../../types';

const SIGN_CLASS: Record<EmployeeSign, string> = {
  'Работает': 'sc-sign--working',
  'Уволен': 'sc-sign--fired',
  'Декрет': 'sc-sign--maternity',
};

/** «Признак»: Работает / Уволен / Декрет. До прихода данных — скелетон той же высоты. */
export const StaffSignBadge: FC<{ sign: EmployeeSign | undefined }> = ({ sign }) => {
  if (!sign) return <span className="sc-skeleton sc-skeleton--short" aria-label="Загрузка" />;
  return <span className={`sc-sign ${SIGN_CLASS[sign]}`}>{sign}</span>;
};
