import type { IDormitoryStay } from '../services/dormitoryService';
import { formatDate } from './formatMoney';
import { moscowTodayIso } from './moscowDate';
import { buildExportTable, type ITableColumn, type ITableExportSnapshot } from './tableView';

/**
 * Таблица «Общежитие» — вкладка «Управления кадрами» и окно «Справочника» «Зарплаты»: столбцы для
 * экрана, сортировки, фильтров и выгрузки в xlsx (общие функции — в tableView.ts).
 */

/** Класс ширины колонки в DormitoryStaysTable.module.css. */
export type DormitoryColumnWidth = 'colName' | 'colDepartment' | 'colPosition' | 'colDate' | 'colAddress';

export interface IDormitoryColumn extends ITableColumn<IDormitoryStay> {
  width: DormitoryColumnWidth;
}

/** Предел снимка xlsx на сервере (TABLE_SNAPSHOT_MAX_ROWS). */
export const DORMITORY_EXPORT_MAX_ROWS = 1000;

const orDash = (value: string | null): string => value || '—';

export const DORMITORY_COLUMNS: ReadonlyArray<IDormitoryColumn> = [
  {
    key: 'full_name',
    label: 'ФИО',
    type: 'text',
    width: 'colName',
    text: stay => stay.full_name,
    sortValue: stay => stay.full_name,
  },
  {
    key: 'department',
    label: 'Отдел',
    type: 'text',
    width: 'colDepartment',
    text: stay => orDash(stay.department),
    sortValue: stay => stay.department,
  },
  {
    key: 'position',
    label: 'Должность',
    type: 'text',
    width: 'colPosition',
    text: stay => orDash(stay.position),
    sortValue: stay => stay.position,
  },
  {
    key: 'check_in',
    label: 'Дата въезда',
    type: 'text',
    width: 'colDate',
    text: stay => formatDate(stay.check_in),
    sortValue: stay => stay.check_in,
  },
  {
    key: 'check_out',
    label: 'Дата выезда',
    type: 'text',
    width: 'colDate',
    text: stay => (stay.check_out ? formatDate(stay.check_out) : '—'),
    sortValue: stay => stay.check_out,
  },
  {
    key: 'address',
    label: 'Адрес / номер',
    type: 'text',
    width: 'colAddress',
    text: stay => stay.address,
    sortValue: stay => stay.address,
  },
];

/** Поиск по ФИО над таблицей: без учёта регистра и «ё». */
export const matchesDormitorySearch = (stay: IDormitoryStay, search: string): boolean => {
  const needle = search.trim().toLocaleLowerCase('ru').replace(/ё/g, 'е');
  if (!needle) return true;
  return stay.full_name.toLocaleLowerCase('ru').replace(/ё/g, 'е').includes(needle);
};

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
