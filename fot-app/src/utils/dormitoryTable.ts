import type { IDormitoryStay } from '../services/dormitoryService';
import { formatDate } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { buildExportTable, type IRegistryColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица «Общежитие» — вкладка «Управления кадрами» и окно «Справочника» «Зарплаты»: столбцы для
 * экрана, сортировки, фильтров и выгрузки в xlsx (общие функции — в tableView.ts).
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
    text: stay => stay.address,
    sortValue: stay => stay.address,
  },
];

export const buildDormitoryExport = (rows: ReadonlyArray<IDormitoryStay>): ITableExportSnapshot => {
  const isoDate = moscowTodayIso();
  return buildExportTable({
    title: 'Общежитие',
    subtitle: `Дата выгрузки: ${isoDate.split('-').reverse().join('.')}`,
    fileName: `Общежитие_${isoDate}.xlsx`,
    columns: DORMITORY_COLUMNS,
    rows,
  });
};
