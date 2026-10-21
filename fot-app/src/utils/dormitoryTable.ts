import type { IDormitoryStay } from '../services/dormitoryService';
import { DORMITORY_STAY_KIND_LABELS } from './dormitoryStayForm';
import { formatDate } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { formatPayrollMoney } from './payrollFormat';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица проживаний: «Проживание» «Управления кадрами» (общежития и квартиры — с видом и суммой) и «Общежитие»
 * в «Справочнике» «Зарплаты» (только общежития). Столбцы для экрана, сортировки, фильтров и выгрузки в xlsx
 * (общие функции — в tableView.ts).
 */

const orDash = (value: string | null): string => value || '—';

export const DORMITORY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryStay>> = [
  {
    key: 'full_name',
    label: 'ФИО',
    type: 'text',
    text: stay => stay.full_name,
    sortValue: stay => stay.full_name,
  },
  {
    key: 'department',
    label: 'Отдел',
    type: 'text',
    width: 140,
    text: stay => orDash(stay.department),
    sortValue: stay => stay.department,
  },
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 148,
    text: stay => orDash(stay.position),
    sortValue: stay => stay.position,
  },
  {
    key: 'check_in',
    label: 'Дата въезда',
    type: 'text',
    width: 112,
    nowrap: true,
    text: stay => formatDate(stay.check_in),
    sortValue: stay => stay.check_in,
  },
  {
    key: 'check_out',
    label: 'Дата выезда',
    type: 'text',
    width: 112,
    nowrap: true,
    text: stay => (stay.check_out ? formatDate(stay.check_out) : '—'),
    sortValue: stay => stay.check_out,
  },
  {
    key: 'address',
    label: 'Адрес / номер',
    type: 'text',
    width: 152,
    text: stay => orDash(stay.address),
    sortValue: stay => stay.address,
  },
];

/** Вкладка «Проживание»: после должности — вид (Общежитие / Квартира), в конце — сумма доплаты у квартиры. */
export const HOUSING_STAY_COLUMNS: ReadonlyArray<IRegistryColumn<IDormitoryStay>> = [
  ...DORMITORY_COLUMNS.slice(0, 3),
  {
    key: 'kind',
    label: 'Тип',
    type: 'text',
    width: 112,
    nowrap: true,
    text: stay => DORMITORY_STAY_KIND_LABELS[stay.kind],
    sortValue: stay => DORMITORY_STAY_KIND_LABELS[stay.kind],
  },
  ...DORMITORY_COLUMNS.slice(3),
  {
    key: 'amount',
    label: 'Сумма, ₽/мес',
    type: 'money',
    width: 128,
    nowrap: true,
    numeric: true,
    text: stay => formatPayrollMoney(stay.amount) ?? '—',
    sortValue: stay => (stay.amount === null ? null : Number(stay.amount)),
    exportValue: stay => stay.amount,
  },
];

const buildExport = (title: string, columns: ReadonlyArray<IRegistryColumn<IDormitoryStay>>) =>
  (rows: ReadonlyArray<IDormitoryStay>): ITableExportSnapshot => {
    const isoDate = moscowTodayIso();
    return buildExportTable({
      title,
      subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
      fileName: `${title}_${isoDate}.xlsx`,
      columns,
      rows,
    });
  };

export const buildDormitoryExport = buildExport('Общежитие', DORMITORY_COLUMNS);
export const buildHousingStaysExport = buildExport('Проживание', HOUSING_STAY_COLUMNS);
