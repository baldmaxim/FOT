/**
 * Выгрузка ЗУП — XLSX в формате PassDesk (лист «Сотрудники», колонки как в
 * client/src/components/Employees/ExcelExportModal.jsx), под существующий загрузчик 1С.
 * Выгрузка ставит только zup_exported_at (факт формирования файла); флаг «ЗУП: ДА»
 * ставится тумблером вручную.
 */
import ExcelJS from 'exceljs';
import { query } from '../config/postgres.js';
import { getCitizenshipById, rowToPlainFields, type IHrProfileRow } from './hr-profile.service.js';

const HEADERS = [
  'UUID', 'Фамилия', 'Имя', 'Отчество', 'Пол', 'Телефон', 'Дата рождения', 'Страна рождения', 'Область рождения',
  'Населенный пункт рождения', 'Тип паспорта', 'Номер паспорта', 'Дата выдачи паспорта', 'Кем выдан паспорт',
  'Код подразделения', 'Адрес регистрации', 'Патент', 'Дата выдачи патента', 'Номер бланка патента', 'ИНН', 'СНИЛС',
  'КИГ', 'Дата окончания КИГ', 'Гражданство', 'Организация', 'ИНН организации', 'р/с', 'БИК', 'id_all',
  'Дата окончания паспорта', 'ID_FOT', 'Табельный номер',
] as const;

const fmtDate = (v: string | null | undefined): string => {
  if (!v) return '';
  const s = String(v).slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
};

const PROFILE_SELECT = `
  p.*,
  e.full_name, e.last_name, e.first_name, e.middle_name, e.birth_date, e.email, e.pension_number,
  e.patent_issue_date, e.patent_expiry_date, e.employment_status, e.hire_date, e.org_department_id, e.tab_number`;

export interface IZupExportFilter {
  employeeIds?: number[];
  notUploadedOnly?: boolean;
  activeOnly?: boolean;
  scopeEmployeeIds?: Set<number> | 'all';
}

export const loadRowsForExport = async (filter: IZupExportFilter): Promise<IHrProfileRow[]> => {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.employeeIds && filter.employeeIds.length > 0) {
    params.push(filter.employeeIds);
    where.push(`p.employee_id = ANY($${params.length}::int[])`);
  }
  if (filter.notUploadedOnly) where.push(`p.zup_is_uploaded = false`);
  if (filter.activeOnly) where.push(`e.employment_status = 'active' AND e.is_archived = false`);
  if (filter.scopeEmployeeIds && filter.scopeEmployeeIds !== 'all') {
    params.push([...filter.scopeEmployeeIds]);
    where.push(`p.employee_id = ANY($${params.length}::int[])`);
  }
  return query<IHrProfileRow>(
    `SELECT ${PROFILE_SELECT} FROM employee_hr_profiles p JOIN employees e ON e.id = p.employee_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.full_name`,
    params,
  );
};

const resolveRootDepartmentNames = async (departmentIds: string[]): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  if (departmentIds.length === 0) return map;
  const rows = await query<{ id: string; root_name: string }>(
    `WITH RECURSIVE up AS (
       SELECT id AS start_id, id, parent_id, name FROM org_departments WHERE id = ANY($1::uuid[])
       UNION ALL
       SELECT up.start_id, d.id, d.parent_id, d.name FROM org_departments d JOIN up ON d.id = up.parent_id
     )
     SELECT DISTINCT ON (start_id) start_id AS id, name AS root_name FROM up WHERE parent_id IS NULL`,
    [departmentIds],
  );
  for (const r of rows) map.set(r.id, r.root_name);
  return map;
};

export const buildZupWorkbook = async (rows: IHrProfileRow[]): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FOT';
  const ws = wb.addWorksheet('Сотрудники');
  ws.addRow([...HEADERS]);
  ws.getRow(1).font = { bold: true };

  const roots = await resolveRootDepartmentNames([...new Set(rows.map(r => r.org_department_id).filter((v): v is string => !!v))]);

  for (const row of rows) {
    const f = rowToPlainFields(row);
    const cit = await getCitizenshipById(row.citizenship_id);
    const birthCountry = await getCitizenshipById(row.birth_country_id);
    ws.addRow([
      row.passdesk_id ?? '',
      row.last_name ?? '',
      row.first_name ?? '',
      row.middle_name ?? '',
      f.gender === 'male' ? 'Мужской' : f.gender === 'female' ? 'Женский' : '',
      f.phone ?? '',
      fmtDate(row.birth_date),
      birthCountry?.name ?? '',
      f.birth_region ?? '',
      f.birth_city ?? '',
      f.passport_type === 'foreign' ? 'Иностранного гражданина' : f.passport_type === 'russian' ? 'Паспорт РФ' : '',
      f.passport_number ?? '',
      fmtDate(f.passport_date as string | null),
      f.passport_issuer ?? '',
      f.passport_department_code ?? '',
      f.registration_address ?? '',
      f.patent_number ?? '',
      fmtDate(row.patent_issue_date),
      f.patent_blank_number ?? '',
      f.inn ?? '',
      row.pension_number ?? '',
      f.kig ?? '',
      fmtDate(f.kig_end_date as string | null),
      cit?.name ?? '',
      row.org_department_id ? roots.get(row.org_department_id) ?? '' : '',
      '',
      f.bank_account_number ?? '',
      f.bank_bik ?? '',
      row.passdesk_id_all ?? '',
      fmtDate(f.passport_expiry_date as string | null),
      row.employee_id,
      row.tab_number ?? '',
    ]);
  }
  ws.columns.forEach(col => { col.width = 18; });
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
};

export const buildZupFileName = (): string => {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Выгрузка_сотрудников_${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}_${pad(d.getHours())}-${pad(d.getMinutes())}.xlsx`;
};
