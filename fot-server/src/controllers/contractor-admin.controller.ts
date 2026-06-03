/**
 * Админ-контроллер подрядчиков: массовый выпуск нумерованных пропусков
 * в Sigur, привязка пользователя-подрядчика к организации (зеркало
 * replaceUserCompanies), список заявок на согласовании и их применение
 * к Sigur (не транзакционно — алгоритм в approveSubmission).
 */
import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import ExcelJS from 'exceljs';
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
  getOrgDocumentDownloadUrl,
  listOrgDocuments,
} from '../services/contractor-documents.service.js';
import {
  assignSigurEmployeeCardBinding,
  replaceSigurEmployeeAccessPoints,
} from '../services/sigur-live-cards.service.js';
import { resolveAccessPointNamesToIds } from '../services/contractor-access.service.js';
import {
  applyDismissalImmediately,
  insertDismissalHistory,
  loadEmployeeLifecycleRow,
  getHttpErrorStatus,
  getHttpErrorCode,
  getErrorMessage,
} from './employee-lifecycle.controller.js';
import { employeeCache } from '../services/employee-cache.service.js';

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
   * GET /removals — заявки подрядчиков на удаление сотрудников
   * (contractor_roster.state='pending_remove'). Группировку по организациям
   * делает фронт. employee_id резолвится по sigur_employee_id (нужен для увольнения).
   */
  async listRemovals(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const data = await query(
        `SELECT r.id AS roster_id,
                r.org_department_id,
                od.name AS org_name,
                r.full_name,
                r.sigur_employee_id,
                r.removal_requested_at,
                e.id AS employee_id,
                e.employment_status
           FROM contractor_roster r
           JOIN org_departments od ON od.id = r.org_department_id
           LEFT JOIN employees e ON e.sigur_employee_id = r.sigur_employee_id
          WHERE r.state = 'pending_remove'
          ORDER BY od.name ASC, r.full_name ASC`,
      );
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor listRemovals error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить заявки на удаление' });
    }
  },

  /** GET /removals/count — количество заявок на удаление (для бейджа вкладки). */
  async removalsCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM contractor_roster WHERE state = 'pending_remove'`,
      );
      res.json({ success: true, data: { count: Number(row?.count ?? 0) } });
    } catch (error) {
      console.error('Contractor removalsCount error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить счётчик' });
    }
  },

  /**
   * POST /removals/:rosterId/approve — одобрить удаление сотрудника = уволить
   * его (как кнопка «Уволить» в «Управление кадрами»). Дата увольнения —
   * автоматически дата, когда подрядчик нажал «Удалить» (removal_requested_at),
   * без модалки выбора даты. Привязанный пропуск НЕ трогаем.
   */
  async approveRemoval(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const rosterId = z.string().uuid().parse(req.params.rosterId);

      const roster = await queryOne<{
        id: string; state: string; sigur_employee_id: number | null;
        removal_requested_at: string | null; full_name: string;
      }>(
        `SELECT id, state, sigur_employee_id,
                to_char(removal_requested_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS removal_requested_at,
                full_name
           FROM contractor_roster WHERE id = $1::uuid`,
        [rosterId],
      );
      if (!roster || roster.state !== 'pending_remove') {
        res.status(409).json({ success: false, error: 'Заявка на удаление недоступна' });
        return;
      }
      if (roster.sigur_employee_id == null) {
        res.status(409).json({ success: false, error: 'У сотрудника нет привязки к Sigur — увольнение невозможно' });
        return;
      }

      const emp = await queryOne<{ id: number }>(
        `SELECT id FROM employees WHERE sigur_employee_id = $1 LIMIT 1`,
        [roster.sigur_employee_id],
      );
      if (!emp) {
        res.status(409).json({ success: false, error: 'Сотрудник ещё не синхронизирован из Sigur — повторите позже' });
        return;
      }
      const employeeId = Number(emp.id);
      const existing = await loadEmployeeLifecycleRow(employeeId);
      if (!existing) {
        res.status(409).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }

      // Дата увольнения = дата нажатия подрядчиком; не раньше даты найма.
      const today = new Date().toISOString().slice(0, 10);
      let dismissalDate = roster.removal_requested_at
        ? roster.removal_requested_at.slice(0, 10)
        : today;
      if (existing.hire_date && dismissalDate < existing.hire_date) {
        dismissalDate = today >= existing.hire_date ? today : existing.hire_date;
      }

      if (existing.employment_status !== 'fired') {
        const { fromDepartmentId } = await applyDismissalImmediately({
          employeeId,
          existing,
          dismissalDate,
          userId: req.user.id,
        });
        employeeCache.invalidate(employeeId);
        await insertDismissalHistory(employeeId, dismissalDate, {
          scheduled: false,
          createdBy: req.user.id,
          fromDepartmentId,
        });
        await auditService.logFromRequest(req, req.user.id, 'FIRE_EMPLOYEE', {
          entityType: 'employee',
          entityId: String(employeeId),
          details: { source: 'contractor_removal', dismissal_date: dismissalDate, roster_id: rosterId },
        });
      }

      await execute(
        `UPDATE contractor_roster SET state = 'removed', updated_at = now() WHERE id = $1::uuid`,
        [rosterId],
      );

      res.json({ success: true, data: { roster_id: rosterId, employee_id: employeeId, dismissal_date: dismissalDate } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id заявки' });
        return;
      }
      const httpStatus = getHttpErrorStatus(error);
      if (httpStatus) {
        res.status(httpStatus).json({
          success: false,
          error: getErrorMessage(error, 'Не удалось уволить сотрудника'),
          ...(getHttpErrorCode(error) ? { code: getHttpErrorCode(error) } : {}),
        });
        return;
      }
      // Пересечение периодов назначений — data-condition, как в fire(): 409, не шумим в Sentry.
      if (getErrorMessage(error, '').includes('Overlapping employee_assignments period')) {
        console.warn('[approveRemoval] overlapping assignment periods', { rosterId: req.params.rosterId });
        res.status(409).json({
          success: false,
          error: 'У сотрудника пересекаются периоды назначений (employee_assignments). Исправьте историю назначений и повторите увольнение.',
          code: 'ASSIGNMENT_OVERLAP',
        });
        return;
      }
      console.error('Contractor approveRemoval error:', error);
      Sentry.captureException(error, {
        tags: { route: 'contractor.approveRemoval' },
        extra: { rosterId: req.params.rosterId },
      });
      res.status(500).json({ success: false, error: 'Не удалось одобрить удаление' });
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
             VALUES ($1::uuid, $2, $3, $4, $5::uuid[], $6::text[], $7::date, 'assigned', $8::uuid)
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

  /** GET /sigur-access-points — каталог точек доступа Sigur для модалки одобрения. */
  async listSigurAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const connection = await sigurService.getBackgroundConnectionType();
      const data = await sigurService.getAccessPointOptionsCached(connection);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor listSigurAccessPoints error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить точки доступа Sigur' });
    }
  },

  /** GET /submissions/pending/count — счётчик pending-заявок для бейджа в меню. */
  async getPendingSubmissionsCount(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const row = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM contractor_submissions
          WHERE status IN ('pending', 'partially_applied')`,
      );
      res.json({ success: true, data: { count: Number(row?.count ?? 0) } });
    } catch (error) {
      console.error('Contractor getPendingSubmissionsCount error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить счётчик заявок' });
    }
  },

  /**
   * GET /submissions/:id/export — xlsx со списком пропусков заявки.
   * Колонки: «№ пропуска», «ФИО». Нужен для согласования с заказчиком по почте.
   */
  async exportSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const submissionId = req.params.id;

      const sub = await queryOne<{ id: string; org_name: string; submitted_at: string }>(
        `SELECT s.id, d.name AS org_name, s.submitted_at
           FROM contractor_submissions s
           JOIN org_departments d ON d.id = s.org_department_id
          WHERE s.id = $1::uuid`,
        [submissionId],
      );
      if (!sub) {
        res.status(404).json({ success: false, error: 'Заявка не найдена' });
        return;
      }

      const rows = await query<{ pass_number: string; holder_name: string | null }>(
        `SELECT p.pass_number,
                COALESCE(h.holder_name, p.holder_name) AS holder_name
           FROM contractor_passes p
           LEFT JOIN contractor_pass_holders h
             ON h.pass_id = p.id AND h.valid_until IS NULL
          WHERE p.submission_id = $1::uuid
          ORDER BY p.pass_number::int ASC`,
        [submissionId],
      );

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Заявка');
      ws.columns = [
        { header: '№ пропуска', key: 'pass_number', width: 16 },
        { header: 'ФИО', key: 'holder_name', width: 48 },
      ];
      ws.getRow(1).font = { bold: true };
      for (const r of rows) {
        ws.addRow({ pass_number: r.pass_number, holder_name: r.holder_name ?? '' });
      }

      const buf = Buffer.from(await wb.xlsx.writeBuffer());

      const dateIso = new Date(sub.submitted_at).toISOString().slice(0, 10);
      const safeOrg = sub.org_name.replace(/[\\/:*?"<>|]+/g, '_').trim();
      const fileName = `Заявка_${safeOrg}_${dateIso}.xlsx`;

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition',
        `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
      res.send(buf);
    } catch (error) {
      console.error('Contractor exportSubmission error:', error);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Не удалось сформировать файл' });
      }
    }
  },

  /** GET /orgs/:orgId/documents — список документов организации подрядчика для модалки заявки. */
  async getOrgDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const orgId = z.string().uuid().parse(req.params.orgId);
      const data = await listOrgDocuments(orgId);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректная организация' });
        return;
      }
      console.error('Contractor getOrgDocuments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить документы' });
    }
  },

  /** GET /documents/:id/download — pre-signed URL (админ имеет доступ ко всем оргам). */
  async getOrgDocumentDownloadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const docId = z.string().uuid().parse(req.params.id);
      const out = await getOrgDocumentDownloadUrl(docId, null);
      if (!out) {
        res.status(404).json({ success: false, error: 'Документ не найден' });
        return;
      }
      res.json({ success: true, data: out });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id' });
        return;
      }
      console.error('Contractor getOrgDocumentDownloadUrl error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить ссылку' });
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

  /** GET /submissions/:id — детали заявки (пропуска с вписанным ФИО и поштучным статусом). */
  async getSubmissionDetail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const rows = await query(
        `SELECT p.id,
                p.pass_number,
                COALESCE(h.holder_name, p.holder_name) AS holder_name,
                p.card_uid,
                p.status AS pass_status,
                p.approval_status,
                p.is_active,
                p.access_point_names,
                COALESCE(
                  (SELECT string_agg(o.name, ', ' ORDER BY o.name)
                     FROM skud_objects o WHERE o.id = ANY(p.object_ids)),
                  '') AS object_label
           FROM contractor_passes p
           LEFT JOIN contractor_pass_holders h
             ON h.pass_id = p.id AND h.valid_until IS NULL
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
      // из access_point_names как страховка. Берём пропуска со status='submitted'
      // или 'blocked' (после change-holder) с заполненным ФИО.
      const toRename = await query<{
        pass_id: string; pass_status: string; pass_sigur_id: number | null;
        holder_name: string; access_point_names: string[] | null;
      }>(
        `SELECT p.id AS pass_id, p.status AS pass_status,
                p.sigur_employee_id AS pass_sigur_id,
                p.holder_name, p.access_point_names
           FROM contractor_passes p
          WHERE p.submission_id = $1::uuid
            AND p.status IN ('submitted', 'blocked')
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
          await withTransaction(async client => {
            await client.query(
              `UPDATE contractor_passes
                  SET status = 'applied',
                      approval_status = 'approved',
                      is_active = true,
                      updated_at = now()
                WHERE id = $1::uuid`,
              [row.pass_id],
            );
            await client.query(
              `UPDATE contractor_pass_holders
                  SET approved_by = $1::uuid, approved_at = now()
                WHERE pass_id = $2::uuid AND valid_until IS NULL AND approved_at IS NULL`,
              [req.user.id, row.pass_id],
            );
            await client.query(
              `INSERT INTO contractor_submission_decisions
                 (submission_id, pass_id, decision, decided_by, access_point_names)
               VALUES ($1::uuid, $2::uuid, 'approved', $3::uuid, $4::text[])
               ON CONFLICT DO NOTHING`,
              [submissionId, row.pass_id, req.user.id, row.access_point_names],
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

  /**
   * GET /passes/sent?org_department_id=? — пропуска, отправленные подрядчику и
   * ещё не одобренные (assigned/submitted/blocked). Если org_department_id не
   * передан — все подрядчики, сгруппировано на фронте.
   */
  async listSentPasses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const orgFilter = typeof req.query.org_department_id === 'string'
        ? req.query.org_department_id : null;

      const rows = await query(
        `SELECT p.id,
                p.pass_number,
                p.status,
                p.approval_status,
                p.is_active,
                p.sigur_employee_id,
                p.card_uid,
                COALESCE(h.holder_name, p.holder_name) AS holder_name,
                p.org_department_id,
                d.name AS org_name,
                p.submission_id,
                p.created_at,
                p.updated_at
           FROM contractor_passes p
           JOIN org_departments d ON d.id = p.org_department_id
           LEFT JOIN contractor_pass_holders h
             ON h.pass_id = p.id AND h.valid_until IS NULL
          WHERE p.status IN ('assigned', 'submitted', 'blocked')
            ${orgFilter ? 'AND p.org_department_id = $1::uuid' : ''}
          ORDER BY d.name ASC, p.pass_number::int ASC`,
        orgFilter ? [orgFilter] : [],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('Contractor listSentPasses error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить отправленные пропуска' });
    }
  },

  /**
   * GET /passes/monitor?org_department_id=? — все пропуска подрядчика (включая
   * applied/blocked) с текущим ФИО для экрана мониторинга. revoked исключаются.
   */
  async monitorPasses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const orgId = z.string().uuid().parse(req.query.org_department_id);

      const rows = await query(
        `SELECT p.id,
                p.pass_number,
                p.status,
                p.approval_status,
                p.is_active,
                p.sigur_employee_id,
                p.card_uid,
                COALESCE(h.holder_name, p.holder_name) AS holder_name,
                p.expires_at,
                p.access_point_names,
                p.submission_id,
                p.updated_at,
                COALESCE(
                  (SELECT string_agg(o.name, ', ' ORDER BY o.name)
                     FROM skud_objects o WHERE o.id = ANY(p.object_ids)),
                  '') AS object_label
           FROM contractor_passes p
           LEFT JOIN contractor_pass_holders h
             ON h.pass_id = p.id AND h.valid_until IS NULL
          WHERE p.org_department_id = $1::uuid AND p.status <> 'revoked'
          ORDER BY p.pass_number::int ASC`,
        [orgId],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Не указана организация' });
        return;
      }
      console.error('Contractor monitorPasses error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить мониторинг' });
    }
  },

  /**
   * GET /passes/:id/history — история ФИО и решений по пропуску (для модалки
   * timeline в админке).
   */
  async getPassHistoryAdmin(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const passId = req.params.id;
      const holders = await query(
        `SELECT h.id, h.holder_name, h.valid_from, h.valid_until,
                up.full_name AS changed_by_name,
                h.submission_id, h.approved_at,
                upa.full_name AS approved_by_name
           FROM contractor_pass_holders h
           LEFT JOIN user_profiles up  ON up.id = h.changed_by
           LEFT JOIN user_profiles upa ON upa.id = h.approved_by
          WHERE h.pass_id = $1::uuid
          ORDER BY h.valid_from ASC, h.created_at ASC`,
        [passId],
      );
      const decisions = await query(
        `SELECT d.id, d.submission_id, d.decision, d.decided_at, d.reason, d.access_point_names,
                up.full_name AS decided_by_name
           FROM contractor_submission_decisions d
           LEFT JOIN user_profiles up ON up.id = d.decided_by
          WHERE d.pass_id = $1::uuid
          ORDER BY d.decided_at DESC`,
        [passId],
      );
      res.json({ success: true, data: { holders, decisions } });
    } catch (error) {
      console.error('Contractor getPassHistoryAdmin error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить историю' });
    }
  },

  /**
   * POST /submissions/:id/decide — поштучные решения по заявке.
   * Body: { decisions: [{ pass_id, decision: 'approved'|'rejected', reason?,
   *                       access_point_names?[] }] }
   * approved: rename в Sigur + unblock + access points + status='applied',
   *           approval_status='approved', is_active=true, approved_at/by для holder.
   * rejected: block в Sigur + status='blocked', approval_status='rejected'.
   * Идемпотентно: повторные решения для уже обработанных пропусков игнорируются.
   * По завершении переоценивает агрегатный статус заявки.
   */
  async decideSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!(await ensureSystemAdmin(req, res))) return;
      const submissionId = req.params.id;
      const body = z.object({
        decisions: z.array(z.object({
          pass_id: z.string().uuid(),
          decision: z.enum(['approved', 'rejected']),
          reason: z.string().trim().max(1000).optional(),
          access_point_names: z.array(z.string().trim().min(1)).optional(),
        })).min(1).max(500),
      }).parse(req.body);

      const sub = await queryOne<{ id: string; status: string; org_department_id: string }>(
        'SELECT id, status, org_department_id FROM contractor_submissions WHERE id = $1::uuid',
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

      const passes = await query<{
        id: string; status: string; sigur_employee_id: number | null;
        holder_name: string | null; submission_id: string | null;
        access_point_names: string[] | null;
      }>(
        `SELECT id, status, sigur_employee_id, holder_name, submission_id, access_point_names
           FROM contractor_passes
          WHERE submission_id = $1::uuid AND id = ANY($2::uuid[])`,
        [submissionId, body.decisions.map(d => d.pass_id)],
      );
      const byId = new Map(passes.map(p => [p.id, p]));

      const applied: string[] = [];
      const rejected: string[] = [];
      const failures: string[] = [];
      const warnings: string[] = [];

      for (const dec of body.decisions) {
        const pass = byId.get(dec.pass_id);
        if (!pass) {
          failures.push(`pass ${dec.pass_id}: не принадлежит заявке`);
          continue;
        }
        // Идемпотентность: уже обработанные пропуска пропускаем.
        if (pass.status === 'applied' || (pass.status === 'blocked' && (pass.submission_id !== submissionId))) {
          continue;
        }

        if (dec.decision === 'approved') {
          if (!pass.holder_name) {
            failures.push(`pass ${pass.id}: нет ФИО`);
            continue;
          }
          if (pass.sigur_employee_id == null) {
            failures.push(`pass ${pass.id}: профиль не создан в Sigur`);
            continue;
          }
          try {
            // Резолв точек доступа (приоритет — из decision, иначе из пропуска).
            const names = dec.access_point_names ?? pass.access_point_names ?? [];
            let resolvedIds: number[] = [];
            if (!dryRun && names.length > 0) {
              const resolved = await resolveAccessPointNamesToIds(names, connection);
              resolvedIds = resolved.accessPointIds;
              if (resolved.unmatchedNames.length > 0) {
                warnings.push(`pass ${pass.id}: точки не сопоставлены: ${resolved.unmatchedNames.join(', ')}`);
              }
            }

            if (!dryRun) {
              await updateSigurEmployee(
                pass.sigur_employee_id,
                { name: pass.holder_name, blocked: false },
                connection,
              );
              if (resolvedIds.length > 0) {
                await replaceSigurEmployeeAccessPoints(pass.sigur_employee_id, resolvedIds, connection);
              }
            }

            await withTransaction(async client => {
              await client.query(
                `UPDATE contractor_passes
                    SET status = 'applied',
                        approval_status = 'approved',
                        is_active = true,
                        access_point_names = $1::text[],
                        updated_at = now()
                  WHERE id = $2::uuid`,
                [names.length ? names : null, pass.id],
              );
              // Привязываем одобрение к открытой строке владельца.
              await client.query(
                `UPDATE contractor_pass_holders
                    SET approved_by = $1::uuid, approved_at = now()
                  WHERE pass_id = $2::uuid AND valid_until IS NULL AND approved_at IS NULL`,
                [req.user.id, pass.id],
              );
              await client.query(
                `INSERT INTO contractor_submission_decisions
                   (submission_id, pass_id, decision, decided_by, reason, access_point_names)
                 VALUES ($1::uuid, $2::uuid, 'approved', $3::uuid, $4, $5::text[])`,
                [submissionId, pass.id, req.user.id, dec.reason ?? null, names.length ? names : null],
              );
            });
            applied.push(pass.id);
          } catch (e) {
            failures.push(`pass ${pass.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          // rejected
          try {
            if (!dryRun && pass.sigur_employee_id != null) {
              try {
                await updateSigurEmployee(pass.sigur_employee_id, { blocked: true }, connection);
              } catch (sigurError) {
                warnings.push(`pass ${pass.id} block: ${sigurError instanceof Error ? sigurError.message : String(sigurError)}`);
              }
            }
            await withTransaction(async client => {
              await client.query(
                `UPDATE contractor_passes
                    SET status = 'blocked',
                        approval_status = 'rejected',
                        is_active = false,
                        updated_at = now()
                  WHERE id = $1::uuid`,
                [pass.id],
              );
              await client.query(
                `INSERT INTO contractor_submission_decisions
                   (submission_id, pass_id, decision, decided_by, reason)
                 VALUES ($1::uuid, $2::uuid, 'rejected', $3::uuid, $4)`,
                [submissionId, pass.id, req.user.id, dec.reason ?? null],
              );
            });
            rejected.push(pass.id);
          } catch (e) {
            failures.push(`pass ${pass.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_SUBMISSION_PASS_DECIDED, {
          entityType: 'contractor_pass',
          entityId: pass.id,
          details: { decision: dec.decision, submission_id: submissionId },
        });
      }

      // Переоценка агрегатного статуса заявки.
      const counts = await queryOne<{
        total: string; pending: string; approved: string; rejected: string;
      }>(
        `SELECT COUNT(*)::text AS total,
                COUNT(*) FILTER (WHERE approval_status = 'pending')::text AS pending,
                COUNT(*) FILTER (WHERE approval_status = 'approved')::text AS approved,
                COUNT(*) FILTER (WHERE approval_status = 'rejected')::text AS rejected
           FROM contractor_passes WHERE submission_id = $1::uuid`,
        [submissionId],
      );
      const total = Number(counts?.total ?? 0);
      const pending = Number(counts?.pending ?? 0);
      const approvedCount = Number(counts?.approved ?? 0);
      const rejectedCount = Number(counts?.rejected ?? 0);

      let finalStatus = sub.status;
      if (pending === 0) {
        if (rejectedCount === 0) finalStatus = 'approved';
        else if (approvedCount === 0) finalStatus = 'rejected';
        else finalStatus = 'partially_applied';
      } else if (approvedCount > 0 || rejectedCount > 0) {
        finalStatus = 'partially_applied';
      }

      const applyError = [...failures, ...warnings];
      await execute(
        `UPDATE contractor_submissions
            SET status = $1,
                reviewed_by = $2::uuid,
                reviewed_at = CASE WHEN $1 IN ('approved','rejected','partially_applied') THEN now() ELSE reviewed_at END,
                apply_error = $3
          WHERE id = $4::uuid`,
        [finalStatus, req.user.id, applyError.length ? applyError.join('; ') : null, submissionId],
      );

      void total;
      res.json({
        success: true,
        data: {
          status: finalStatus,
          applied: applied.length,
          rejected: rejected.length,
          failed: failures.length,
          errors: failures,
          warnings,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor decideSubmission error:', error);
      res.status(500).json({ success: false, error: 'Не удалось обработать решения' });
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
        // Возвращаем пропуска заявки в 'assigned' (ФИО сохраняем — подрядчик
        // может поправить и переотправить); отвязываем от заявки.
        await client.query(
          `UPDATE contractor_passes
              SET status = 'assigned',
                  approval_status = 'not_submitted',
                  submission_id = NULL,
                  updated_at = now()
            WHERE submission_id = $1::uuid AND status IN ('submitted', 'blocked')`,
          [submissionId],
        );
        // Открытые строки истории владельца — отвязываем от заявки.
        await client.query(
          `UPDATE contractor_pass_holders
              SET submission_id = NULL
            WHERE submission_id = $1::uuid AND valid_until IS NULL`,
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
