/**
 * Контроллер подрядчика. Одна страница /contractor: ростер людей,
 * назначение пропусков, отправка пакета изменений на согласование.
 * Стиль — correction-approval.controller.ts.
 */
import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute, withTransaction } from '../config/postgres.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { auditService, AUDIT_ACTIONS } from '../services/audit.service.js';
import { resolveContractorOrgForUser } from '../services/contractor-scope.service.js';
import { syncRosterFromSigur, getRoster, getPasses } from '../services/contractor-roster.service.js';

/** Резолвит организацию подрядчика; при отсутствии — отвечает 403 и возвращает null. */
const resolveOrgOr403 = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<string | null> => {
  const orgId = await resolveContractorOrgForUser(req.user.id);
  if (!orgId) {
    res.status(403).json({ success: false, error: 'Пользователь не привязан к подрядной организации' });
    return null;
  }
  return orgId;
};

/** Есть ли у организации незакрытая (pending) заявка. */
const hasPendingSubmission = async (orgId: string): Promise<boolean> => {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM contractor_submissions
      WHERE org_department_id = $1::uuid AND status = 'pending' LIMIT 1`,
    [orgId],
  );
  return !!row;
};

export const contractorController = {
  async getMyOrg(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const org = await queryOne<{ id: string; name: string }>(
        'SELECT id, name FROM org_departments WHERE id = $1::uuid',
        [orgId],
      );
      res.json({ success: true, data: org });
    } catch (error) {
      console.error('Contractor getMyOrg error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить организацию' });
    }
  },

  async getRoster(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      try {
        await syncRosterFromSigur(orgId);
      } catch (syncError) {
        // Sigur может быть недоступен — отдаём текущий ростер из БД.
        console.error('Contractor roster sync error:', syncError);
      }
      const data = await getRoster(orgId);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor getRoster error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить список людей' });
    }
  },

  async addPerson(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const { full_name } = z.object({
        full_name: z.string().trim().min(2).max(200),
      }).parse(req.body);

      const row = await queryOne<{ id: string }>(
        `INSERT INTO contractor_roster (org_department_id, full_name, state, created_by)
         VALUES ($1::uuid, $2, 'pending_add', $3::uuid)
         RETURNING id`,
        [orgId, full_name, req.user.id],
      );
      res.json({ success: true, data: { id: row?.id } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor addPerson error:', error);
      res.status(500).json({ success: false, error: 'Не удалось добавить человека' });
    }
  },

  async markPersonRemoval(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const affected = await execute(
        `UPDATE contractor_roster
            SET state = 'pending_remove', updated_at = now()
          WHERE id = $1::uuid AND org_department_id = $2::uuid
            AND state = 'active' AND submission_id IS NULL`,
        [req.params.id, orgId],
      );
      if (affected === 0) {
        res.status(409).json({ success: false, error: 'Строка недоступна для пометки на удаление' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Contractor markPersonRemoval error:', error);
      res.status(500).json({ success: false, error: 'Не удалось пометить на удаление' });
    }
  },

  /** Откат незакоммиченной пометки: pending_add → удалить строку, pending_remove → active. */
  async unmarkPerson(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const row = await queryOne<{ id: string; state: string }>(
        `SELECT id, state FROM contractor_roster
          WHERE id = $1::uuid AND org_department_id = $2::uuid AND submission_id IS NULL`,
        [req.params.id, orgId],
      );
      if (!row) {
        res.status(409).json({ success: false, error: 'Строка недоступна для отката' });
        return;
      }
      if (row.state === 'pending_add') {
        await execute('DELETE FROM contractor_roster WHERE id = $1::uuid', [row.id]);
      } else if (row.state === 'pending_remove') {
        await execute(
          `UPDATE contractor_roster SET state = 'active', updated_at = now() WHERE id = $1::uuid`,
          [row.id],
        );
      } else {
        res.status(409).json({ success: false, error: 'Нечего откатывать' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Contractor unmarkPerson error:', error);
      res.status(500).json({ success: false, error: 'Не удалось откатить пометку' });
    }
  },

  async getPasses(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const data = await getPasses(orgId);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor getPasses error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить пропуска' });
    }
  },

  /** Назначить роста-человека на пропуск. Body: { roster_id }. */
  async assignPass(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const passId = req.params.id;
      const { roster_id } = z.object({ roster_id: z.string().uuid() }).parse(req.body);

      const pass = await queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM contractor_passes
          WHERE id = $1::uuid AND org_department_id = $2::uuid`,
        [passId, orgId],
      );
      if (!pass) {
        res.status(404).json({ success: false, error: 'Пропуск не найден' });
        return;
      }
      if (pass.status === 'applied' || pass.status === 'revoked') {
        res.status(409).json({ success: false, error: 'Пропуск уже выдан и недоступен для переназначения' });
        return;
      }
      const roster = await queryOne<{ id: string }>(
        `SELECT id FROM contractor_roster
          WHERE id = $1::uuid AND org_department_id = $2::uuid AND state <> 'removed'
            AND submission_id IS NULL`,
        [roster_id, orgId],
      );
      if (!roster) {
        res.status(409).json({ success: false, error: 'Человек недоступен для назначения' });
        return;
      }

      await withTransaction(async client => {
        // Освобождаем целевой пропуск от прежнего человека.
        await client.query(
          `UPDATE contractor_roster SET assigned_pass_id = NULL, updated_at = now()
            WHERE assigned_pass_id = $1::uuid`,
          [passId],
        );
        // Освобождаем прежний пропуск этого человека (если был 'assigned').
        const prev = await client.query<{ assigned_pass_id: string | null }>(
          `SELECT assigned_pass_id FROM contractor_roster WHERE id = $1::uuid`,
          [roster_id],
        );
        const prevPassId = prev.rows[0]?.assigned_pass_id ?? null;
        if (prevPassId && prevPassId !== passId) {
          await client.query(
            `UPDATE contractor_passes SET status = 'issued', updated_at = now()
              WHERE id = $1::uuid AND status = 'assigned'`,
            [prevPassId],
          );
        }
        await client.query(
          `UPDATE contractor_roster SET assigned_pass_id = $1::uuid, updated_at = now()
            WHERE id = $2::uuid`,
          [passId, roster_id],
        );
        await client.query(
          `UPDATE contractor_passes SET status = 'assigned', updated_at = now()
            WHERE id = $1::uuid AND status <> 'applied'`,
          [passId],
        );
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor assignPass error:', error);
      res.status(500).json({ success: false, error: 'Не удалось назначить пропуск' });
    }
  },

  /** Отправить пакет изменений на согласование. */
  async submit(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      if (await hasPendingSubmission(orgId)) {
        res.status(409).json({ success: false, error: 'Уже есть заявка на согласовании' });
        return;
      }

      const submissionId = await withTransaction(async client => {
        const created = await client.query<{ id: string }>(
          `INSERT INTO contractor_submissions (org_department_id, submitted_by, status)
           VALUES ($1::uuid, $2::uuid, 'pending') RETURNING id`,
          [orgId, req.user.id],
        );
        const subId = created.rows[0].id;
        // Привязываем staged-строки ростера к заявке.
        await client.query(
          `UPDATE contractor_roster
              SET submission_id = $1::uuid, updated_at = now()
            WHERE org_department_id = $2::uuid
              AND submission_id IS NULL
              AND (
                state IN ('pending_add', 'pending_remove')
                OR assigned_pass_id IN (
                  SELECT id FROM contractor_passes
                   WHERE org_department_id = $2::uuid AND status = 'assigned'
                )
              )`,
          [subId, orgId],
        );
        return subId;
      });

      const counts = await queryOne<{ adds: string; removes: string; assigns: string }>(
        `SELECT
            COUNT(*) FILTER (WHERE state = 'pending_add')                       AS adds,
            COUNT(*) FILTER (WHERE state = 'pending_remove')                    AS removes,
            COUNT(*) FILTER (WHERE assigned_pass_id IS NOT NULL)                AS assigns
           FROM contractor_roster
          WHERE submission_id = $1::uuid`,
        [submissionId],
      );

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_SUBMISSION_SUBMITTED, {
        entityType: 'contractor_submission',
        entityId: submissionId,
        details: { org_department_id: orgId, counts },
      });

      res.json({ success: true, data: { submission_id: submissionId, counts } });
    } catch (error) {
      console.error('Contractor submit error:', error);
      res.status(500).json({ success: false, error: 'Не удалось отправить на согласование' });
    }
  },

  async getSubmissions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const data = await query(
        `SELECT id, status, submitted_at, reviewed_at, comment, apply_error
           FROM contractor_submissions
          WHERE org_department_id = $1::uuid
          ORDER BY submitted_at DESC
          LIMIT 20`,
        [orgId],
      );
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor getSubmissions error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить заявки' });
    }
  },
};
