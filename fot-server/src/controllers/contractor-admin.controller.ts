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
  getContractorUserIdsForOrg,
  ContractorScopeError,
} from '../services/contractor-scope.service.js';
import { notificationService } from '../services/notification.service.js';
import { pushService } from '../services/push.service.js';
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
import { resolveAccessPointNamesToIds } from '../services/contractor-access.service.js';

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
   * POST /passes/issue — массовый выпуск нумерованных профилей-заглушек в
   * папке организации в Sigur. Карты считываются считывателем по порядку;
   * каждый профиль создаётся заблокированным, сразу с привязкой карты,
   * сроком действия и точками доступа выбранных объектов.
   * Body: { org_department_id, from, to?, object_ids[], access_point_names[],
   *         expires_at?, cards: [{uid, sequence}], notify? }.
   * Клиент может слать пачку чанками (для прогресс-бара); идемпотентно по
   * (org, pass_number). notify=false подавляет уведомление подрядчику
   * (true только на финальном чанке).
   */
  async issuePassBatch(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = z.object({
        org_department_id: z.string().uuid(),
        from: z.number().int().positive(),
        to: z.number().int().positive().optional(),
        object_ids: z.array(z.string().uuid()).min(1),
        access_point_names: z.array(z.string().trim().min(1)).min(1),
        expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        cards: z.array(z.object({
          uid: z.string().trim().min(1),
          sequence: z.number().int().nonnegative(),
        })).min(1).max(100),
        notify: z.boolean().optional(),
      }).parse(req.body);

      const orgId = body.org_department_id;

      // Объекты обязательны — проверяем что существуют и активны.
      const objRows = await query<{ id: string }>(
        `SELECT id FROM skud_objects WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [body.object_ids],
      );
      if (objRows.length !== body.object_ids.length) {
        res.status(400).json({ success: false, error: 'Некоторые объекты не найдены или неактивны' });
        return;
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

      const dryRun = isContractorSigurDryRun();
      const connection = await sigurService.getBackgroundConnectionType();

      // Резолв точек доступа один раз на пачку.
      const resolvedPoints = dryRun
        ? { accessPointIds: [] as number[], unmatchedNames: [] as string[] }
        : await resolveAccessPointNamesToIds(body.access_point_names, connection);
      if (!dryRun && resolvedPoints.accessPointIds.length === 0) {
        res.status(400).json({
          success: false,
          error: `Точки доступа не сопоставлены в Sigur: ${resolvedPoints.unmatchedNames.join(', ')}`,
        });
        return;
      }

      // Срок действия пропуска: дефолт +5 лет, конец дня.
      const expDate = body.expires_at ?? (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 5);
        return d.toISOString().slice(0, 10);
      })();
      const expIso = new Date(`${expDate}T23:59:59`).toISOString();

      const maxSeq = body.cards.reduce((m, c) => Math.max(m, c.sequence), 0);
      const lastNumber = Math.max(body.to ?? 0, body.from + maxSeq);
      const width = Math.max(2, String(lastNumber).length);

      const created: string[] = [];
      const failed: Array<{ pass_number: string; error: string }> = [];
      const warnings: string[] = [];
      if (resolvedPoints.unmatchedNames.length > 0) {
        warnings.push(`точки не сопоставлены: ${resolvedPoints.unmatchedNames.join(', ')}`);
      }

      // Сортировка по sequence — детерминированная нумерация и при чанках.
      const cards = [...body.cards].sort((a, b) => a.sequence - b.sequence);
      for (const card of cards) {
        const num = body.from + card.sequence;
        if (body.to && num > body.to) {
          failed.push({ pass_number: String(num), error: `вне пула (> ${body.to})` });
          continue;
        }
        const passNumber = String(num).padStart(width, '0');
        const cardUid = card.uid.trim();
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
            try {
              await assignSigurEmployeeCardBinding(sigurEmployeeId, [cardUid], expIso, connection);
            } catch (cardError) {
              const m = cardError instanceof Error ? cardError.message : String(cardError);
              warnings.push(`${passNumber} карта: ${m}`);
            }
            try {
              await replaceSigurEmployeeAccessPoints(sigurEmployeeId, resolvedPoints.accessPointIds, connection);
            } catch (apError) {
              const m = apError instanceof Error ? apError.message : String(apError);
              warnings.push(`${passNumber} точки: ${m}`);
            }
          }
          await execute(
            `INSERT INTO contractor_passes
               (org_department_id, pass_number, sigur_employee_id, card_uid,
                object_ids, access_point_names, expires_at, status, created_by)
             VALUES ($1::uuid, $2, $3, $4, $5::uuid[], $6::text[], $7::date, 'issued', $8::uuid)
             ON CONFLICT (org_department_id, pass_number) DO NOTHING`,
            [orgId, passNumber, sigurEmployeeId, cardUid,
             body.object_ids, body.access_point_names, expDate, req.user.id],
          );
          created.push(passNumber);
        } catch (passError) {
          const msg = passError instanceof Error ? passError.message : String(passError);
          failed.push({ pass_number: passNumber, error: msg });
        }
      }

      // Уведомление подрядчику (notify=true только на финальном чанке).
      if (body.notify !== false && created.length > 0) {
        try {
          const userIds = await getContractorUserIdsForOrg(orgId);
          if (userIds.length > 0) {
            const title = 'Выпущены пропуска';
            const text = `Вам выдано пропусков: ${created.length}. Впишите ФИО в кабинете.`;
            await notificationService.createMany(userIds.map(uid => ({
              userId: uid,
              type: 'contractor_passes_issued',
              title,
              body: text,
              metadata: { org_department_id: orgId, count: created.length },
            })));
            await pushService.sendGenericNotification(userIds, title, text);
          }
        } catch (notifyError) {
          console.error('Contractor issue notify error:', notifyError);
        }
      }

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_PASSES_ISSUED, {
        entityType: 'contractor_org',
        entityId: orgId,
        details: { created: created.length, failed: failed.length, warnings: warnings.length, dryRun },
      });

      res.json({ success: true, data: { created, failed, warnings } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor issuePassBatch error:', error);
      res.status(500).json({ success: false, error: 'Не удалось выпустить пропуска' });
    }
  },

  /** GET /objects — активные объекты СКУД (id, name) для формы выпуска. */
  async listObjects(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await query<{ id: string; name: string }>(
        `SELECT id, name FROM skud_objects WHERE is_active = true ORDER BY name`,
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Contractor listObjects error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить объекты' });
    }
  },

  /** GET /objects/access-points?object_ids=a,b — точки доступа выбранных объектов. */
  async listObjectAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const raw = String(req.query.object_ids ?? '').trim();
      const ids = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
      if (ids.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }
      const rows = await query<{ object_id: string; object_name: string; access_point_name: string }>(
        `SELECT ap.object_id, o.name AS object_name, ap.access_point_name
           FROM skud_object_access_points ap
           JOIN skud_objects o ON o.id = ap.object_id
          WHERE ap.object_id = ANY($1::uuid[])
          ORDER BY o.name, ap.access_point_name`,
        [ids],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Contractor listObjectAccessPoints error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить точки доступа' });
    }
  },

  /** GET /orgs/:orgId/next-pass — следующий свободный номер пропуска организации. */
  async getNextPassNumber(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = z.string().uuid().parse(req.params.orgId);
      const row = await queryOne<{ max_num: number | null }>(
        `SELECT MAX(pass_number::int) AS max_num
           FROM contractor_passes WHERE org_department_id = $1::uuid`,
        [orgId],
      );
      res.json({ success: true, data: { next: row?.max_num ? row.max_num + 1 : 1 } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректная организация' });
        return;
      }
      console.error('Contractor getNextPassNumber error:', error);
      res.status(500).json({ success: false, error: 'Не удалось вычислить номер' });
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
                COUNT(p.*)                                       AS passes,
                COUNT(p.*) FILTER (WHERE p.status = 'applied')    AS applied
           FROM contractor_submissions s
           JOIN org_departments d ON d.id = s.org_department_id
           LEFT JOIN contractor_passes p ON p.submission_id = s.id
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

  /** GET /submissions/:id — детали заявки (пропуска с вписанным ФИО). */
  async getSubmissionDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const rows = await query(
        `SELECT p.id,
                p.pass_number,
                p.holder_name,
                p.card_uid,
                p.status AS pass_status,
                COALESCE(
                  (SELECT string_agg(o.name, ', ' ORDER BY o.name)
                     FROM skud_objects o WHERE o.id = ANY(p.object_ids)),
                  '') AS object_label
           FROM contractor_passes p
          WHERE p.submission_id = $1::uuid
          ORDER BY p.pass_number ASC`,
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

      // Шаг 2. Переименование нумерованных профилей → ФИО (вписано подрядчиком).
      // Точки доступа уже привязаны при выпуске; здесь — идемпотентный ре-бинд
      // из access_point_names как страховка.
      const toRename = await query<{
        pass_id: string; pass_status: string; pass_sigur_id: number | null;
        holder_name: string; access_point_names: string[] | null;
      }>(
        `SELECT p.id AS pass_id, p.status AS pass_status,
                p.sigur_employee_id AS pass_sigur_id,
                p.holder_name, p.access_point_names
           FROM contractor_passes p
          WHERE p.submission_id = $1::uuid
            AND p.status = 'assigned'
            AND p.holder_name IS NOT NULL`,
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
              { name: row.holder_name, blocked: false },
              connection,
            );
            const names = row.access_point_names ?? [];
            if (names.length > 0) {
              const resolved = await resolveAccessPointNamesToIds(names, connection);
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
          await execute(
            `UPDATE contractor_passes SET status = 'applied', updated_at = now() WHERE id = $1::uuid`,
            [row.pass_id],
          );
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
        // Возвращаем пропуска заявки в 'issued' (ФИО сохраняем — подрядчик
        // может поправить и переотправить); отвязываем от заявки.
        await client.query(
          `UPDATE contractor_passes
              SET status = 'issued', submission_id = NULL, updated_at = now()
            WHERE submission_id = $1::uuid AND status = 'assigned'`,
          [submissionId],
        );
        // Откат staged-строк ростера (legacy, пусто для нового потока).
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
