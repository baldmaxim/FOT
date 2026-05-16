/**
 * Админ-контроллер подрядчиков: массовый выпуск нумерованных пропусков
 * в Sigur, привязка пользователя-подрядчика к организации (зеркало
 * replaceUserCompanies), список заявок на согласовании и их применение
 * к Sigur (не транзакционно — алгоритм в approveSubmission).
 */
import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { resolveCompanyScope } from '../services/data-scope.service.js';
import { getAllRoles, getRoleByCode } from '../services/roles-cache.service.js';
import {
  getContractorOrgs,
  getOrgSigurDepartmentId,
  ContractorScopeError,
} from '../services/contractor-scope.service.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import { sigurService } from '../services/sigur.service.js';
import {
  createSigurEmployee,
  updateSigurEmployee,
  deleteSigurEmployee,
} from '../services/sigur-live-employees-crud.service.js';
import {
  assignSigurEmployeeCardBinding,
  replaceSigurEmployeeAccessPoints,
} from '../services/sigur-live-cards.service.js';
import { resolveObjectAccessPointIds } from '../services/contractor-access.service.js';

/** Только системный админ (как approveUser/replaceUserCompanies). */
const ensureSystemAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<boolean> => {
  const scope = await resolveCompanyScope(req);
  if (scope.roots !== 'all') {
    res.status(403).json({ success: false, error: 'Доступно только системному администратору' });
    return false;
  }
  return true;
};

export const contractorAdminController = {
  /** GET /orgs — список подрядных организаций. */
  async listOrgs(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await getContractorOrgs();
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor listOrgs error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить организации' });
    }
  },

  /**
   * POST /passes/issue — массовый выпуск нумерованных профилей в папке
   * организации в Sigur. Body: { org_department_id, count } | { org_department_id, from, to }
   * card_uids: опциональный список UID (по одному на пропуск, по порядку).
   */
  async issuePassBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = z.object({
        org_department_id: z.string().uuid(),
        count: z.number().int().positive().max(500).optional(),
        from: z.number().int().positive().optional(),
        to: z.number().int().positive().optional(),
        card_uids: z.array(z.string().trim().min(1)).optional(),
        skud_object_id: z.string().uuid().nullable().optional(),
      }).parse(req.body);

      const orgId = body.org_department_id;

      // Объект (набор точек доступа) — опционально, применяется к пачке.
      let skudObjectId: string | null = null;
      if (body.skud_object_id) {
        const obj = await queryOne<{ id: string }>(
          'SELECT id FROM skud_objects WHERE id = $1::uuid AND is_active = true',
          [body.skud_object_id],
        );
        if (!obj) {
          res.status(400).json({ success: false, error: 'Объект не найден или неактивен' });
          return;
        }
        skudObjectId = obj.id;
      }
      let sigurDepartmentId: number;
      try {
        sigurDepartmentId = await getOrgSigurDepartmentId(orgId);
      } catch (scopeError) {
        if (scopeError instanceof ContractorScopeError) {
          res.status(scopeError.status).json({ success: false, error: scopeError.message });
          return;
        }
        throw scopeError;
      }

      // Следующий номер = max(pass_number::int)+1 среди пропусков организации.
      const maxRow = await queryOne<{ max_num: number | null }>(
        `SELECT MAX(pass_number::int) AS max_num
           FROM contractor_passes WHERE org_department_id = $1::uuid`,
        [orgId],
      );
      const startFrom = body.from ?? (maxRow?.max_num ? maxRow.max_num + 1 : 1);
      const requested = body.count ?? (body.to ? body.to - startFrom + 1 : 0);
      if (requested <= 0) {
        res.status(400).json({ success: false, error: 'Не задано количество пропусков' });
        return;
      }
      const lastNumber = startFrom + requested - 1;
      const width = Math.max(2, String(lastNumber).length);

      const dryRun = isContractorSigurDryRun();
      const connection = await sigurService.getBackgroundConnectionType();
      const created: string[] = [];
      const failed: Array<{ pass_number: string; error: string }> = [];

      for (let i = 0; i < requested; i += 1) {
        const num = startFrom + i;
        const passNumber = String(num).padStart(width, '0');
        const cardUid = body.card_uids?.[i]?.trim() || null;
        try {
          let sigurEmployeeId: number;
          if (dryRun) {
            sigurEmployeeId = -(Date.now() + num);
          } else {
            const profile = await createSigurEmployee({
              name: `Пропуск ${passNumber}`,
              departmentId: sigurDepartmentId,
              description: `FOT-PASS:${orgId}:${passNumber}`,
              blocked: true,
            }, connection);
            sigurEmployeeId = profile.sigurEmployeeId;
            if (cardUid) {
              try {
                await assignSigurEmployeeCardBinding(sigurEmployeeId, [cardUid], undefined, connection);
              } catch (cardError) {
                // Ошибка карты не откатывает профиль.
                console.error(`Pass ${passNumber} card bind failed:`, cardError);
              }
            }
          }
          await execute(
            `INSERT INTO contractor_passes
               (org_department_id, pass_number, sigur_employee_id, card_uid, skud_object_id, status, created_by)
             VALUES ($1::uuid, $2, $3, $4, $5, 'issued', $6::uuid)
             ON CONFLICT (org_department_id, pass_number) DO NOTHING`,
            [orgId, passNumber, sigurEmployeeId, cardUid, skudObjectId, req.user.id],
          );
          created.push(passNumber);
        } catch (passError) {
          const msg = passError instanceof Error ? passError.message : String(passError);
          failed.push({ pass_number: passNumber, error: msg });
        }
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_PASSES_ISSUED, {
        entityType: 'contractor_org',
        entityId: orgId,
        details: { requested, created: created.length, failed: failed.length, dryRun },
      });

      res.json({ success: true, data: { requested, created, failed } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor issuePassBatch error:', error);
      res.status(500).json({ success: false, error: 'Не удалось выпустить пропуска' });
    }
  },

  /** GET /users — пользователи с ролью «Подрядчик» + их привязка к организации. */
  async listContractorUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const role = await getRoleByCode('contractor');
      if (!role) {
        res.json({ success: true, data: [] });
        return;
      }
      const data = await query(
        `SELECT up.id,
                up.full_name,
                coa.org_department_id,
                d.name AS org_name
           FROM user_profiles up
           LEFT JOIN contractor_org_access coa ON coa.user_id = up.id
           LEFT JOIN org_departments d ON d.id = coa.org_department_id
          WHERE up.system_role_id = $1::uuid
          ORDER BY up.full_name ASC NULLS LAST`,
        [role.id],
      );
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor listContractorUsers error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить подрядчиков' });
    }
  },

  /** GET /users/:id/org — текущая привязка подрядчика к организации. */
  async getUserOrg(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const row = await queryOne<{ org_department_id: string }>(
        'SELECT org_department_id FROM contractor_org_access WHERE user_id = $1::uuid',
        [req.params.id],
      );
      res.json({ success: true, data: { org_department_id: row?.org_department_id ?? null } });
    } catch (error) {
      console.error('Contractor getUserOrg error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить привязку' });
    }
  },

  /** PUT /users/:id/org — замена привязки. Body: { org_department_id: string|null }. */
  async replaceUserOrg(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const { id } = req.params;
      const { org_department_id } = z.object({
        org_department_id: z.string().uuid().nullable(),
      }).parse(req.body);

      const profile = await queryOne<{ id: string; system_role_id: string }>(
        'SELECT id, system_role_id FROM user_profiles WHERE id = $1::uuid',
        [id],
      );
      if (!profile) {
        res.status(404).json({ success: false, error: 'Пользователь не найден' });
        return;
      }
      const allRoles = await getAllRoles();
      const role = allRoles.find(r => r.id === profile.system_role_id);
      if (!role || role.code !== 'contractor') {
        res.status(400).json({
          success: false,
          error: 'Привязка к организации доступна только пользователю с ролью «Подрядчик»',
        });
        return;
      }

      try {
        await withTransaction(async client => {
          await client.query('DELETE FROM contractor_org_access WHERE user_id = $1::uuid', [id]);
          if (org_department_id) {
            await client.query(
              `INSERT INTO contractor_org_access (user_id, org_department_id, created_by)
               VALUES ($1::uuid, $2::uuid, $3::uuid)`,
              [id, org_department_id, req.user.id],
            );
          }
        });
      } catch (writeError) {
        const msg = writeError instanceof Error ? writeError.message : 'Не удалось обновить привязку';
        res.status(400).json({ success: false, error: msg });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_ORG_ACCESS_CHANGED, {
        entityType: 'user',
        entityId: id,
        details: { org_department_id },
      });

      res.json({ success: true, data: { org_department_id } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor replaceUserOrg error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обновить привязку' });
    }
  },

  /** GET /submissions/pending — заявки на согласовании. */
  async getPendingSubmissions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await query(
        `SELECT s.id,
                s.org_department_id,
                d.name AS org_name,
                s.status,
                s.submitted_at,
                s.apply_error,
                COUNT(r.*) FILTER (WHERE r.state = 'pending_add')    AS adds,
                COUNT(r.*) FILTER (WHERE r.state = 'pending_remove') AS removes,
                COUNT(r.*) FILTER (WHERE r.assigned_pass_id IS NOT NULL) AS assigns
           FROM contractor_submissions s
           JOIN org_departments d ON d.id = s.org_department_id
           LEFT JOIN contractor_roster r ON r.submission_id = s.id
          WHERE s.status IN ('pending', 'partially_applied')
          GROUP BY s.id, d.name
          ORDER BY s.submitted_at ASC`,
      );
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor getPendingSubmissions error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить заявки' });
    }
  },

  /** GET /submissions/:id — детали заявки (строки ростера). */
  async getSubmissionDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const rows = await query(
        `SELECT r.id, r.full_name, r.state, r.sigur_employee_id,
                p.pass_number, p.status AS pass_status
           FROM contractor_roster r
           LEFT JOIN contractor_passes p ON p.id = r.assigned_pass_id
          WHERE r.submission_id = $1::uuid
          ORDER BY r.state, r.full_name`,
        [req.params.id],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Contractor getSubmissionDetail error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить детали заявки' });
    }
  },

  /**
   * POST /submissions/:id/approve — применение к Sigur.
   * Sigur не транзакционен с PG: применяем по одному, каждый успех сразу
   * коммитим в PG, повторный апрув идемпотентно дозавершает остаток.
   */
  async approveSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const submissionId = req.params.id;
      const sub = await queryOne<{ id: string; status: string }>(
        'SELECT id, status FROM contractor_submissions WHERE id = $1::uuid',
        [submissionId],
      );
      if (!sub) {
        res.status(404).json({ success: false, error: 'Заявка не найдена' });
        return;
      }
      if (sub.status !== 'pending' && sub.status !== 'partially_applied') {
        res.status(409).json({ success: false, error: 'Заявка уже обработана' });
        return;
      }

      const dryRun = isContractorSigurDryRun();
      const connection = await sigurService.getBackgroundConnectionType();
      const failures: string[] = [];
      const warnings: string[] = [];
      let applied = 0;

      // Шаг 1. Удаления.
      const toRemove = await query<{ id: string; sigur_employee_id: number }>(
        `SELECT id, sigur_employee_id FROM contractor_roster
          WHERE submission_id = $1::uuid AND state = 'pending_remove'
            AND sigur_employee_id IS NOT NULL`,
        [submissionId],
      );
      for (const row of toRemove) {
        try {
          if (!dryRun) {
            try {
              await deleteSigurEmployee(row.sigur_employee_id, connection);
            } catch (delError) {
              const m = delError instanceof Error ? delError.message : String(delError);
              if (!/not found|не найден|404/i.test(m)) throw delError;
            }
          }
          await withTransaction(async client => {
            await client.query(
              `UPDATE contractor_roster SET state = 'removed', updated_at = now() WHERE id = $1::uuid`,
              [row.id],
            );
            // Профиль в Sigur удалён — связанный пропуск (нумерованный профиль)
            // больше не существует: помечаем revoked для консистентности.
            await client.query(
              `UPDATE contractor_passes SET status = 'revoked', updated_at = now()
                WHERE sigur_employee_id = $1 AND status <> 'revoked'`,
              [row.sigur_employee_id],
            );
          });
          applied += 1;
        } catch (e) {
          failures.push(`delete ${row.sigur_employee_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Шаг 2. Переименование нумерованных профилей → ФИО.
      const toRename = await query<{
        roster_id: string; full_name: string;
        pass_id: string; pass_status: string; pass_sigur_id: number | null;
        skud_object_id: string | null;
      }>(
        `SELECT r.id AS roster_id, r.full_name,
                p.id AS pass_id, p.status AS pass_status, p.sigur_employee_id AS pass_sigur_id,
                p.skud_object_id AS skud_object_id
           FROM contractor_roster r
           JOIN contractor_passes p ON p.id = r.assigned_pass_id
          WHERE r.submission_id = $1::uuid
            AND r.state IN ('pending_add', 'active')`,
        [submissionId],
      );
      for (const row of toRename) {
        if (row.pass_status === 'applied') continue; // идемпотентность
        if (row.pass_sigur_id == null) {
          failures.push(`pass ${row.pass_id}: профиль не создан в Sigur`);
          continue;
        }
        try {
          if (!dryRun) {
            await updateSigurEmployee(
              row.pass_sigur_id,
              { name: row.full_name, blocked: false },
              connection,
            );
            // ЭТАП 2: бинд точек доступа объекта (если задан на пропуске).
            if (row.skud_object_id) {
              const resolved = await resolveObjectAccessPointIds(row.skud_object_id, connection);
              if (resolved.accessPointIds.length > 0) {
                await replaceSigurEmployeeAccessPoints(
                  row.pass_sigur_id,
                  resolved.accessPointIds,
                  connection,
                );
              }
              if (resolved.unmatchedNames.length > 0) {
                warnings.push(
                  `pass ${row.pass_id}: точки не сопоставлены в Sigur: ${resolved.unmatchedNames.join(', ')}`,
                );
              }
            }
          }
          await withTransaction(async client => {
            await client.query(
              `UPDATE contractor_passes SET status = 'applied', updated_at = now() WHERE id = $1::uuid`,
              [row.pass_id],
            );
            await client.query(
              `UPDATE contractor_roster
                  SET state = 'active', sigur_employee_id = $1, updated_at = now()
                WHERE id = $2::uuid`,
              [row.pass_sigur_id, row.roster_id],
            );
          });
          applied += 1;
        } catch (e) {
          failures.push(`pass ${row.pass_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // warnings (несопоставленные точки) — не блокируют применение.
      const finalStatus = failures.length === 0 ? 'approved' : 'partially_applied';
      const applyError = [...failures, ...warnings];
      await execute(
        `UPDATE contractor_submissions
            SET status = $1, reviewed_by = $2::uuid, reviewed_at = now(),
                apply_error = $3
          WHERE id = $4::uuid`,
        [finalStatus, req.user.id, applyError.length ? applyError.join('; ') : null, submissionId],
      );

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_SUBMISSION_APPROVED, {
        entityType: 'contractor_submission',
        entityId: submissionId,
        details: { status: finalStatus, applied, failed: failures.length, warnings: warnings.length, dryRun },
      });

      res.json({
        success: true,
        data: { status: finalStatus, applied, failed: failures.length, errors: failures, warnings },
      });
    } catch (error) {
      console.error('Contractor approveSubmission error:', error);
      res.status(500).json({ success: false, error: 'Не удалось согласовать заявку' });
    }
  },

  /** POST /submissions/:id/reject — отклонение. Body: { comment }. Sigur не трогаем. */
  async rejectSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const submissionId = req.params.id;
      const { comment } = z.object({
        comment: z.string().trim().max(1000).optional(),
      }).parse(req.body);

      const sub = await queryOne<{ id: string; status: string }>(
        'SELECT id, status FROM contractor_submissions WHERE id = $1::uuid',
        [submissionId],
      );
      if (!sub) {
        res.status(404).json({ success: false, error: 'Заявка не найдена' });
        return;
      }
      if (sub.status !== 'pending') {
        res.status(409).json({ success: false, error: 'Заявку нельзя отклонить' });
        return;
      }

      await withTransaction(async client => {
        // Освобождаем назначенные (не выданные) пропуска.
        await client.query(
          `UPDATE contractor_passes SET status = 'issued', updated_at = now()
            WHERE status = 'assigned'
              AND id IN (SELECT assigned_pass_id FROM contractor_roster
                          WHERE submission_id = $1::uuid AND assigned_pass_id IS NOT NULL)`,
          [submissionId],
        );
        // Откат staged-строк ростера.
        await client.query(
          `DELETE FROM contractor_roster
            WHERE submission_id = $1::uuid AND state = 'pending_add'`,
          [submissionId],
        );
        await client.query(
          `UPDATE contractor_roster SET state = 'active' WHERE submission_id = $1::uuid AND state = 'pending_remove'`,
          [submissionId],
        );
        await client.query(
          `UPDATE contractor_roster
              SET assigned_pass_id = NULL, submission_id = NULL, updated_at = now()
            WHERE submission_id = $1::uuid`,
          [submissionId],
        );
        await client.query(
          `UPDATE contractor_submissions
              SET status = 'rejected', reviewed_by = $1::uuid, reviewed_at = now(), comment = $2
            WHERE id = $3::uuid`,
          [req.user.id, comment ?? null, submissionId],
        );
      });

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_SUBMISSION_REJECTED, {
        entityType: 'contractor_submission',
        entityId: submissionId,
        details: { comment: comment ?? null },
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor rejectSubmission error:', error);
      res.status(500).json({ success: false, error: 'Не удалось отклонить заявку' });
    }
  },
};
