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
}

export interface IContractorPassRow {
  id: string;
  pass_number: string;
  status: 'issued' | 'assigned' | 'applied' | 'revoked';
  sigur_employee_id: number | null;
  card_uid: string | null;
  assigned_roster_id: string | null;
  assigned_full_name: string | null;
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
            r.submission_id
       FROM contractor_roster r
       LEFT JOIN contractor_passes p ON p.id = r.assigned_pass_id
      WHERE r.org_department_id = $1::uuid AND r.state <> 'removed'
      ORDER BY r.full_name ASC`,
    [orgDepartmentId],
  );

/** Пропуска организации с информацией о назначенном человеке. */
export const getPasses = async (orgDepartmentId: string): Promise<IContractorPassRow[]> =>
  query<IContractorPassRow>(
    `SELECT p.id,
            p.pass_number,
            p.status,
            p.sigur_employee_id,
            p.card_uid,
            r.id AS assigned_roster_id,
            r.full_name AS assigned_full_name
       FROM contractor_passes p
       LEFT JOIN contractor_roster r
              ON r.assigned_pass_id = p.id AND r.state <> 'removed'
      WHERE p.org_department_id = $1::uuid AND p.status <> 'revoked'
      ORDER BY p.pass_number ASC`,
    [orgDepartmentId],
  );
