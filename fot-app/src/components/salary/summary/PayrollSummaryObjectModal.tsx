import { useMemo, useState, type FC } from 'react';

import type { IPayrollSummaryRow, SummaryItemCode } from '../../../services/payrollSummaryService';
import { payrollRegistryService } from '../../../services/payrollRegistryService';
import {
  buildSummarySnapshot,
  summaryEmployeeColumns,
  summaryEmployeeTotals,
  summaryHasIssues,
  toSummaryEmployeeRows,
  type ISummaryEmployeeRow,
} from '../../../utils/payrollSummary';
import { RegistryPanel } from '../../ui/registry/RegistryPanel';
import { PayrollRegistryModal } from '../registry/PayrollRegistryModal';

interface IPayrollSummaryObjectModalProps {
  objectName: string;
  /** Строки «Свода» этого объекта в выбранных отделе и категории. */
  rows: ReadonlyArray<IPayrollSummaryRow>;
  /** Статьи-столбцы — те же, что в таблице объектов. */
  items: ReadonlyArray<SummaryItemCode>;
  /** «Все» — столбец «Категория». */
  withCategory: boolean;
  periodLabel: string;
  categoryLabel: string;
  /** Выбранный отдел — в подзаголовок экспорта. */
  departmentLabel?: string;
  onClose: () => void;
}

const sendExport = payrollRegistryService.exportTable('summary');
const rowKey = (row: ISummaryEmployeeRow): string => row.key;
const rowName = (row: ISummaryEmployeeRow): string => row.full_name;

/** «Свод» → объект: его сотрудники и их суммы по статьям за период, строка «Итого». */
export const PayrollSummaryObjectModal: FC<IPayrollSummaryObjectModalProps> = ({
  objectName, rows, items, withCategory, periodLabel, categoryLabel, departmentLabel, onClose,
}) => {
  const [filterOpen, setFilterOpen] = useState(false);
  const employees = useMemo(() => toSummaryEmployeeRows(rows), [rows]);
  const withNotCounted = useMemo(() => summaryHasIssues(rows), [rows]);
  const columns = useMemo(
    () => summaryEmployeeColumns(items, withCategory, withNotCounted),
    [items, withCategory, withNotCounted],
  );
  const totals = useMemo(() => summaryEmployeeTotals(items), [items]);
  const buildExport = useMemo(
    () => buildSummarySnapshot({ title: 'Свод', subject: objectName, periodLabel, categoryLabel, departmentLabel, columns }),
    [objectName, periodLabel, categoryLabel, departmentLabel, columns],
  );

  return (
    <PayrollRegistryModal title={objectName} onClose={onClose} closeOnEscape={!filterOpen} backLabel="Назад к своду">
      <RegistryPanel
        label={`Сотрудники: ${objectName}`}
        columns={columns}
        rows={employees}
        isLoading={false}
        isError={false}
        onRetry={() => undefined}
        rowKey={rowKey}
        rowLabel={rowName}
        searchText={rowName}
        fioSearch
        buildExport={buildExport}
        sendExport={sendExport}
        totals={totals}
        raisedFilters
        onFilterOpenChange={setFilterOpen}
      />
    </PayrollRegistryModal>
  );
};
