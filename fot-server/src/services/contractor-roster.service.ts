/**
 * Ростер подрядчика: синхронизация людей из Sigur (прямые сотрудники отдела
 * организации) в contractor_roster + выборки ростера и пропусков для UI.
 *
 * Синхронизация добавляет новых людей (state='active') и обновляет ФИО
 * активных строк. НЕ перетирает pending_add / pending_remove / removed —
 * это незакоммиченное намерение подрядчика.
 */
import { query, execute } from '../config/postgres.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import { getOrgSigurDepartmentId } from './contractor-scope.service.js';
import { sigurService } from './sigur.service.js';
import { listSigurEmployees } from './sigur-live-admin.service.js';

export interface IContractorRosterRow {
  id: string;
  full_name: string;
  sigur_employee_id: number | null;
  state: 'active' | 'pending_add' | 'pending_remove' | 'removed';
  assigned_pass_id: string | null;
  assigned_pass_number: string | null;
  submission_id: string | null;
  removal_requested_at: string | null;
}

export type ContractorPassStatus =
  | 'in_pool'
  | 'assigned'
  | 'submitted'
  | 'applied'
  | 'blocked'
  | 'revoked';

export type ContractorPassApprovalStatus = 'not_submitted' | 'pending' | 'approved' | 'rejected';

export interface IContractorPassRow {
  id: string;
  pass_number: string;
  status: ContractorPassStatus;
  approval_status: ContractorPassApprovalStatus;
  is_active: boolean;
  sigur_employee_id: number | null;
  card_uid: string | null;
  holder_name: string | null;
  expires_at: string | null;
  submission_id: string | null;
  access_point_names: string[] | null;
  object_label: string;
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  has_residence_permit: boolean;
  residence_permit_number: string | null;
}

const PAGE_SIZE = 500;

/**
 * Подтягивает прямых сотрудников отдела организации из Sigur и сливает
 * в contractor_roster. В dry-run Sigur не дёргается (возвращает текущий ростер).
 */
export const syncRosterFromSigur = async (orgDepartmentId: string): Promise<void> => {
  if (isContractorSigurDryRun()) return;

  const sigurDepartmentId = await getOrgSigurDepartmentId(orgDepartmentId);
  const connection = await sigurService.getBackgroundConnectionType();

  const sigurEmployees: Array<{ id: number; name: string }> = [];
  let page = 1;
  // Пагинация Sigur: тянем страницы, пока приходит полная страница.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await listSigurEmployees(
      { departmentId: sigurDepartmentId },
      { page, pageSize: PAGE_SIZE },
      connection,
    );
    for (const item of result.items) {
      if (Number.isFinite(item.id)) {
        sigurEmployees.push({ id: item.id, name: item.name });
      }
    }
    if (result.items.length < PAGE_SIZE) break;
    page += 1;
  }

  const existing = await query<{ sigur_employee_id: number; state: string; full_name: string }>(
    `SELECT sigur_employee_id, state, full_name
       FROM contractor_roster
      WHERE org_department_id = $1::uuid AND sigur_employee_id IS NOT NULL`,
    [orgDepartmentId],
  );
  const existingById = new Map(existing.map(row => [row.sigur_employee_id, row]));

  for (const emp of sigurEmployees) {
    const found = existingById.get(emp.id);
    if (!found) {
      await execute(
        `INSERT INTO contractor_roster (org_department_id, full_name, sigur_employee_id, state)
         VALUES ($1::uuid, $2, $3, 'active')
         ON CONFLICT DO NOTHING`,
        [orgDepartmentId, emp.name, emp.id],
      );
      continue;
    }
    // Имя обновляем только у активных строк (не трогаем staged-намерения).
    if (found.state === 'active' && found.full_name !== emp.name) {
      await execute(
        `UPDATE contractor_roster
            SET full_name = $1, updated_at = now()
          WHERE org_department_id = $2::uuid AND sigur_employee_id = $3 AND state = 'active'`,
        [emp.name, orgDepartmentId, emp.id],
      );
    }
  }
};

/** Ростер организации (без removed). */
export const getRoster = async (orgDepartmentId: string): Promise<IContractorRosterRow[]> =>
  query<IContractorRosterRow>(
    `SELECT r.id,
            r.full_name,
            r.sigur_employee_id,
            r.state,
            r.assigned_pass_id,
            p.pass_number AS assigned_pass_number,
            r.submission_id,
            r.removal_requested_at
       FROM contractor_roster r
       LEFT JOIN contractor_passes p ON p.id = r.assigned_pass_id
      WHERE r.org_department_id = $1::uuid AND r.state <> 'removed'
      ORDER BY r.full_name ASC`,
    [orgDepartmentId],
  );

/**
 * Пропуска организации: номер, карта, объекты/точки, срок, текущее ФИО владельца.
 * holder_name берётся из текущей открытой строки contractor_pass_holders
 * (valid_until IS NULL); fallback на denormalized contractor_passes.holder_name.
 */
export const getPasses = async (orgDepartmentId: string): Promise<IContractorPassRow[]> =>
  query<IContractorPassRow>(
    `SELECT p.id,
            p.pass_number,
            p.status,
            p.approval_status,
            p.is_active,
            p.sigur_employee_id,
            p.card_uid,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            p.expires_at,
            p.submission_id,
            p.access_point_names,
            p.passport_series_number,
            to_char(p.passport_issue_date, 'YYYY-MM-DD') AS passport_issue_date,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
            p.citizenship,
            p.patent_number,
            to_char(p.patent_issue_date, 'YYYY-MM-DD') AS patent_issue_date,
            p.patent_blank_number,
            p.has_residence_permit,
            p.residence_permit_number,
            COALESCE(
              (SELECT string_agg(o.name, ', ' ORDER BY o.name)
                 FROM skud_objects o WHERE o.id = ANY(p.object_ids)),
              '') AS object_label
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h
         ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.org_department_id = $1::uuid AND p.status <> 'revoked'
      ORDER BY p.pass_number ASC`,
    [orgDepartmentId],
  );
