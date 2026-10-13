/**
 * Книга xlsx для замера влияния смены типа зоны (report-access-point-zone-impact.ts).
 * Только раскладка по листам — расчётов здесь нет.
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

export interface IDayRecord {
  status: string;
  hours: number;
  corrected: boolean;
  overridden: boolean;
  travelMin: number;
  /** Раскладка по объектам: «Объект=часы», корректировка помечена «*». */
  objects: string;
}

export interface IDayDiffRow {
  /** Подразделение первого уровня под корнем: свои отделы или «Подрядные организации». */
  branch: string;
  department: string;
  fullName: string;
  tabNumber: string;
  employeeId: number;
  employmentStatus: string;
  inRoster: boolean;
  date: string;
  before: IDayRecord | null;
  now: IDayRecord | null;
  adjustment: string;
  submission: string;
}

export interface IVersionDiffRow {
  approvalId: number;
  department: string;
  period: string;
  closed: boolean;
  versionCreatedAt: string;
  employeeId: number;
  fullName: string;
  date: string;
  stored: string;
  calculated: string;
  candidate: boolean;
  category: string;
}

export interface IReplicaRow {
  employeeId: number;
  fullName: string;
  department: string;
  date: string;
  touched: boolean;
  changedAt: string;
  fields: string;
  stored: string;
  calculated: string;
}

export interface ITravelLossSheetRow {
  branch: string;
  department: string;
  fullName: string;
  employeeId: number;
  date: string;
  from: string;
  to: string;
  exitTime: string;
  entryTime: string;
  actualMinutes: number;
  creditedMinutes: number;
  delayMinutes: number;
  versionHours: number | null;
  approvalId: number | null;
  beforeHours: number;
  verdict: string;
}

export interface IImpactBook {
  meta: Record<string, string | number>;
  dayRows: IDayDiffRow[];
  versionRows: IVersionDiffRow[];
  replicaRows: IReplicaRow[];
  travelRows: ITravelLossSheetRow[];
  traces: { corrections: Array<Record<string, unknown>>; travel: Array<Record<string, unknown>> };
}

const yesNo = (value: boolean): string => (value ? 'да' : 'нет');

const addSheet = (workbook: ExcelJS.Workbook, name: string, header: string[], rows: unknown[][]): void => {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow(header).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.columns.forEach((column, index) => {
    const longest = Math.max(header[index]?.length ?? 8, ...rows.slice(0, 500).map(row => String(row[index] ?? '').length));
    column.width = Math.min(60, Math.max(8, longest + 2));
  });
  if (rows.length > 0) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
};

const cell = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value ?? '');

export const writeImpactWorkbook = async (file: string, book: IImpactBook): Promise<void> => {
  const workbook = new ExcelJS.Workbook();

  addSheet(workbook, 'Сводка', ['Показатель', 'Значение'], Object.entries(book.meta));

  // По отделам — отдельно видно, сколько затронутых сотрудников реально есть в подачах табеля.
  const byDepartment = new Map<string, { branch: string; department: string; employees: Set<number>; inRoster: Set<number>; days: number; before: number; now: number }>();
  for (const row of book.dayRows) {
    const key = `${row.branch}\u0000${row.department}`;
    const item = byDepartment.get(key)
      ?? { branch: row.branch, department: row.department, employees: new Set<number>(), inRoster: new Set<number>(), days: 0, before: 0, now: 0 };
    item.employees.add(row.employeeId);
    if (row.inRoster) item.inRoster.add(row.employeeId);
    item.days += 1;
    item.before += row.before?.hours ?? 0;
    item.now += row.now?.hours ?? 0;
    byDepartment.set(key, item);
  }
  const round = (value: number): number => Math.round(value * 100) / 100;
  addSheet(
    workbook, 'По отделам',
    ['Ветка', 'Отдел', 'Сотрудников', 'Из них в подачах табеля', 'Дней', 'Часов было', 'Часов сейчас', 'Разница'],
    [...byDepartment.values()]
      .sort((a, b) => a.branch.localeCompare(b.branch) || b.days - a.days)
      .map(item => [item.branch, item.department, item.employees.size, item.inRoster.size, item.days, round(item.before), round(item.now), round(item.now - item.before)]),
  );

  addSheet(
    workbook, 'По дням',
    ['Ветка', 'Отдел', 'ФИО', 'Таб. №', 'ID', 'Статус занятости', 'В подачах табеля', 'Дата',
      'Статус было', 'Часы было', 'Статус сейчас', 'Часы сейчас', 'Разница',
      'Корр. было', 'Корр. сейчас', 'Дорога было, мин', 'Дорога сейчас, мин',
      'Объекты было', 'Объекты сейчас', 'Корректировки дня', 'Подача табеля'],
    book.dayRows.map(row => [
      row.branch, row.department, row.fullName, row.tabNumber, row.employeeId, row.employmentStatus, yesNo(row.inRoster), row.date,
      row.before?.status ?? '—', row.before?.hours ?? 0, row.now?.status ?? '—', row.now?.hours ?? 0,
      round((row.now?.hours ?? 0) - (row.before?.hours ?? 0)),
      yesNo(row.before?.corrected ?? false), yesNo(row.now?.corrected ?? false),
      row.before?.travelMin ?? 0, row.now?.travelMin ?? 0,
      row.before?.objects ?? '', row.now?.objects ?? '', row.adjustment, row.submission,
    ]),
  );

  addSheet(
    workbook, 'Сверка с версиями',
    ['Подача', 'Отдел', 'Период', 'Закрыта', 'Версия от', 'ID', 'ФИО', 'Дата', 'В версии', 'Расчёт «как было»', 'Ходил через точку', 'Причина'],
    book.versionRows.map(row => [
      row.approvalId, row.department, row.period, yesNo(row.closed), row.versionCreatedAt, row.employeeId || '', row.fullName,
      row.date, row.stored, row.calculated, yesNo(row.candidate), row.category,
    ]),
  );

  addSheet(
    workbook, 'Калька сводки',
    ['ID', 'ФИО', 'Отдел', 'Дата', 'Пересчитана после переключения', 'Изменена', 'Расходится', 'В сводке', 'Калька'],
    book.replicaRows.map(row => [
      row.employeeId, row.fullName, row.department, row.date, yesNo(row.touched), row.changedAt, row.fields, row.stored, row.calculated,
    ]),
  );

  addSheet(
    workbook, 'Дорога решения',
    ['Ветка', 'Отдел', 'ФИО', 'ID', 'Дата', 'Откуда', 'Куда', 'Выход', 'Вход', 'Факт, мин', 'Зачтено без решения, мин',
      'Сверх нормы, мин', 'Часы в версии', 'Подача', 'Часы «как было» без решения', 'Вывод'],
    book.travelRows.map(row => [
      row.branch, row.department, row.fullName, row.employeeId, row.date, row.from, row.to, row.exitTime, row.entryTime,
      row.actualMinutes, row.creditedMinutes, row.delayMinutes, row.versionHours ?? '', row.approvalId ?? '', row.beforeHours, row.verdict,
    ]),
  );

  const table = (rows: Array<Record<string, unknown>>): { header: string[]; body: unknown[][] } => {
    const header = rows.length > 0 ? Object.keys(rows[0]) : ['нет строк'];
    return { header, body: rows.map(row => header.map(key => cell(row[key]))) };
  };
  const corrections = table(book.traces.corrections);
  addSheet(workbook, 'Корректировки после', corrections.header, corrections.body);
  const travel = table(book.traces.travel);
  addSheet(workbook, 'Дорога с точкой', travel.header, travel.body);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  await workbook.xlsx.writeFile(file);
};
