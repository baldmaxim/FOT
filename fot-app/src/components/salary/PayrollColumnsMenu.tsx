import type { FC } from 'react';

import { TableColumnsMenu } from '../ui/TableColumnsMenu';
import type { PayrollTableColumn, PayrollTableColumns } from '../../utils/payrollColumns';

interface IPayrollColumnsMenuProps {
  /** Кнопка-шестерёнка: меню открывается под ней, выровненным по её правому краю. */
  anchor: HTMLElement;
  /** Столбцы этой таблицы по порядку. */
  columns: PayrollTableColumns;
  hidden: ReadonlySet<PayrollTableColumn>;
  /** «Расчёты»: столбцы без данных в выборке — скрыты сами, в меню помечены «нет данных». */
  empty?: ReadonlySet<PayrollTableColumn>;
  onToggle: (column: PayrollTableColumn, visible: boolean) => void;
  onShowAll: () => void;
  onClose: () => void;
}

/** Выбор видимых столбцов таблицы «Условий оплаты» или «Расчётов». */
export const PayrollColumnsMenu: FC<IPayrollColumnsMenuProps> = props => (
  <TableColumnsMenu {...props} fixedNote="«Сотрудник» показывается всегда" />
);
