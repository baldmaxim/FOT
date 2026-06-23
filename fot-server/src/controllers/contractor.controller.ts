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
import { sigurService } from '../services/sigur.service.js';
import { isContractorSigurDryRun } from '../config/contractor.js';
import { updateSigurEmployee } from '../services/sigur-live-employees-crud.service.js';
import {
  deleteOrgDocument,
  getOrgDocumentDownloadUrl,
  listOrgDocuments,
  uploadOrgDocument,
} from '../services/contractor-documents.service.js';
import { decodeMulterFilename } from '../utils/multer-filename.utils.js';

interface IMulterRequest extends AuthenticatedRequest {
  file?: Express.Multer.File;
}

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
            SET state = 'pending_remove', removal_requested_at = now(), updated_at = now()
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
          `UPDATE contractor_roster
              SET state = 'active', removal_requested_at = NULL, updated_at = now()
            WHERE id = $1::uuid`,
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

  /**
   * Первичное вписание ФИО держателя пропуска. Body: { full_name } (null/'' — очистить).
   * Доступно только для status='assigned' и submission_id IS NULL (пропуск ещё
   * не в заявке). Параллельно создаёт/обновляет открытую строку истории владельцев
   * (contractor_pass_holders, valid_until IS NULL). Для смены владельца уже
   * применённого пропуска — отдельный эндпоинт changeHolder.
   */
  async setPassHolder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const { full_name } = z.object({
        full_name: z.string().trim().max(200).nullable(),
      }).parse(req.body);
      const holder = full_name && full_name.length >= 2 ? full_name : null;
      const passId = req.params.id;

      const pass = await queryOne<{ id: string; status: string; submission_id: string | null }>(
        `SELECT id, status, submission_id FROM contractor_passes
          WHERE id = $1::uuid AND org_department_id = $2::uuid`,
        [passId, orgId],
      );
      if (!pass) {
        res.status(404).json({ success: false, error: 'Пропуск не найден' });
        return;
      }
      if (pass.status !== 'assigned' || pass.submission_id !== null) {
        res.status(409).json({ success: false, error: 'Пропуск недоступен для редактирования' });
        return;
      }

      await withTransaction(async client => {
        await client.query(
          `UPDATE contractor_passes
              SET holder_name = $1, approval_status = 'not_submitted', updated_at = now()
            WHERE id = $2::uuid`,
          [holder, passId],
        );

        // История: если был открытый владелец — обновляем его, иначе вставляем новый.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM contractor_pass_holders
            WHERE pass_id = $1::uuid AND valid_until IS NULL`,
          [passId],
        );
        if (holder) {
          if (existing.rows[0]) {
            await client.query(
              `UPDATE contractor_pass_holders
                  SET holder_name = $1, changed_by = $2::uuid
                WHERE id = $3::uuid`,
              [holder, req.user.id, existing.rows[0].id],
            );
          } else {
            await client.query(
              `INSERT INTO contractor_pass_holders (pass_id, holder_name, valid_from, changed_by)
               VALUES ($1::uuid, $2, CURRENT_DATE, $3::uuid)`,
              [passId, holder, req.user.id],
            );
          }
        } else if (existing.rows[0]) {
          // Очистка ФИО: удаляем открытую строку истории (ещё не подавалась).
          await client.query(
            `DELETE FROM contractor_pass_holders WHERE id = $1::uuid AND submission_id IS NULL`,
            [existing.rows[0].id],
          );
        }
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor setPassHolder error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить ФИО' });
    }
  },

  /**
   * Смена владельца уже применённого пропуска. Body: { new_holder_name, valid_from }.
   * Закрывает текущую открытую строку истории (valid_until = valid_from - 1d) и
   * создаёт новую. Меняет status пропуска на 'blocked', approval_status='pending'.
   * В Sigur — блокируем профиль до повторного одобрения админом. Эндпоинт сам
   * создаёт contractor_submissions (если нет открытой) или присоединяет к ней.
   */
  async changeHolder(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const passId = req.params.id;
      const { new_holder_name, valid_from } = z.object({
        new_holder_name: z.string().trim().min(2).max(200),
        valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }).parse(req.body);

      const pass = await queryOne<{
        id: string; status: string; sigur_employee_id: number | null;
      }>(
        `SELECT id, status, sigur_employee_id FROM contractor_passes
          WHERE id = $1::uuid AND org_department_id = $2::uuid`,
        [passId, orgId],
      );
      if (!pass) {
        res.status(404).json({ success: false, error: 'Пропуск не найден' });
        return;
      }
      if (pass.status !== 'applied' && pass.status !== 'blocked' && pass.status !== 'assigned') {
        res.status(409).json({ success: false, error: 'Смена владельца недоступна для этого пропуска' });
        return;
      }

      const dryRun = isContractorSigurDryRun();
      if (!dryRun && pass.sigur_employee_id) {
        try {
          const connection = await sigurService.getBackgroundConnectionType();
          await updateSigurEmployee(pass.sigur_employee_id, { blocked: true }, connection);
        } catch (sigurError) {
          console.error('Contractor changeHolder Sigur block error:', sigurError);
          // Не падаем: пропуск всё равно переходит в blocked в БД и попадёт в заявку.
        }
      }

      const submissionId = await withTransaction(async client => {
        // Закрываем текущую открытую строку владельца (valid_until = valid_from - 1 day).
        await client.query(
          `UPDATE contractor_pass_holders
              SET valid_until = ($1::date - INTERVAL '1 day')::date
            WHERE pass_id = $2::uuid AND valid_until IS NULL`,
          [valid_from, passId],
        );

        // Создаём заявку (если нет открытой) или присоединяемся к существующей.
        let sub = await client.query<{ id: string }>(
          `SELECT id FROM contractor_submissions
            WHERE org_department_id = $1::uuid AND status = 'pending' LIMIT 1`,
          [orgId],
        );
        let subId: string;
        if (sub.rows[0]) {
          subId = sub.rows[0].id;
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO contractor_submissions (org_department_id, submitted_by, status)
             VALUES ($1::uuid, $2::uuid, 'pending') RETURNING id`,
            [orgId, req.user.id],
          );
          subId = created.rows[0].id;
        }

        // Новая строка истории.
        await client.query(
          `INSERT INTO contractor_pass_holders
             (pass_id, holder_name, valid_from, changed_by, submission_id)
           VALUES ($1::uuid, $2, $3::date, $4::uuid, $5::uuid)`,
          [passId, new_holder_name, valid_from, req.user.id, subId],
        );

        // Пропуск → blocked + pending, привязка к заявке, обновление denormalized holder_name.
        await client.query(
          `UPDATE contractor_passes
              SET status = 'blocked',
                  approval_status = 'pending',
                  is_active = false,
                  holder_name = $1,
                  submission_id = $2::uuid,
                  updated_at = now()
            WHERE id = $3::uuid`,
          [new_holder_name, subId, passId],
        );

        return subId;
      });

      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_PASS_HOLDER_CHANGED, {
        entityType: 'contractor_pass',
        entityId: passId,
        details: { new_holder_name, valid_from, submission_id: submissionId },
      });

      res.json({ success: true, data: { submission_id: submissionId } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor changeHolder error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сменить владельца' });
    }
  },

  /** История ФИО и решений по пропуску (для timeline в ЛК). */
  async getPassHistory(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const passId = req.params.id;

      // Проверка scope: пропуск принадлежит организации подрядчика.
      const pass = await queryOne<{ id: string }>(
        `SELECT id FROM contractor_passes
          WHERE id = $1::uuid AND org_department_id = $2::uuid`,
        [passId, orgId],
      );
      if (!pass) {
        res.status(404).json({ success: false, error: 'Пропуск не найден' });
        return;
      }

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
      console.error('Contractor getPassHistory error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить историю' });
    }
  },

  /**
   * Сохранить персональные документы держателя пропуска (паспорт, патент).
   * Body: { passport_series_number, passport_issue_date, patent_number, patent_issue_date }.
   * Все поля необязательны (пустые → NULL). Доступно для любого пропуска организации.
   */
  async savePassDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const passId = req.params.id;

      const dateField = z.preprocess(
        v => (typeof v === 'string' && v.trim() === '' ? null : v),
        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      );
      const parsed = z.object({
        passport_series_number: z.string().trim().max(50).nullable().optional(),
        passport_issue_date: dateField,
        birth_date: dateField,
        patent_number: z.string().trim().max(50).nullable().optional(),
        patent_issue_date: dateField,
        patent_blank_number: z.string().trim().max(50).nullable().optional(),
      }).parse(req.body);

      const pass = await queryOne<{ id: string }>(
        `SELECT id FROM contractor_passes
          WHERE id = $1::uuid AND org_department_id = $2::uuid`,
        [passId, orgId],
      );
      if (!pass) {
        res.status(404).json({ success: false, error: 'Пропуск не найден' });
        return;
      }

      const norm = (v: string | null | undefined): string | null => {
        const s = (v ?? '').trim();
        return s.length > 0 ? s : null;
      };

      await execute(
        `UPDATE contractor_passes
            SET passport_series_number = $1,
                passport_issue_date = $2,
                birth_date = $3,
                patent_number = $4,
                patent_issue_date = $5,
                patent_blank_number = $6,
                updated_at = now()
          WHERE id = $7::uuid`,
        [
          norm(parsed.passport_series_number),
          parsed.passport_issue_date ?? null,
          parsed.birth_date ?? null,
          norm(parsed.patent_number),
          parsed.patent_issue_date ?? null,
          norm(parsed.patent_blank_number),
          passId,
        ],
      );

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Contractor savePassDocuments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось сохранить документы' });
    }
  },

  /** Назначить роста-человека на пропуск. Body: { roster_id }. (legacy) */
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
          WHERE id = $1::uuid AND org_department_id = $2::uuid
            AND state IN ('active', 'pending_add')
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
          // Legacy: освобождение прежнего пропуска от ростер-человека. В новой
          // модели статус-машина не меняется — связь хранится через assigned_pass_id.
          await client.query(
            `UPDATE contractor_passes SET updated_at = now()
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

  /** Отправить пропуска с вписанным ФИО на согласование админу. */
  async submit(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      if (await hasPendingSubmission(orgId)) {
        res.status(409).json({ success: false, error: 'Уже есть заявка на согласовании' });
        return;
      }

      const eligible = await queryOne<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM contractor_passes
          WHERE org_department_id = $1::uuid AND submission_id IS NULL
            AND status = 'assigned' AND holder_name IS NOT NULL`,
        [orgId],
      );
      const passes = Number(eligible?.n ?? 0);
      if (passes === 0) {
        res.status(409).json({ success: false, error: 'Нет пропусков с заполненным ФИО' });
        return;
      }

      const submissionId = await withTransaction(async client => {
        const created = await client.query<{ id: string }>(
          `INSERT INTO contractor_submissions (org_department_id, submitted_by, status)
           VALUES ($1::uuid, $2::uuid, 'pending') RETURNING id`,
          [orgId, req.user.id],
        );
        const subId = created.rows[0].id;
        // Привязываем пропуска с вписанным ФИО к заявке, status='submitted'.
        await client.query(
          `UPDATE contractor_passes
              SET submission_id = $1::uuid,
                  status = 'submitted',
                  approval_status = 'pending',
                  updated_at = now()
            WHERE org_department_id = $2::uuid AND submission_id IS NULL
              AND status = 'assigned' AND holder_name IS NOT NULL`,
          [subId, orgId],
        );
        // Привязываем открытые строки истории владельцев к этой заявке.
        await client.query(
          `UPDATE contractor_pass_holders
              SET submission_id = $1::uuid
            WHERE valid_until IS NULL AND submission_id IS NULL
              AND pass_id IN (
                SELECT id FROM contractor_passes
                 WHERE submission_id = $1::uuid
              )`,
          [subId],
        );
        return subId;
      });

      const counts = { passes };

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

  /** GET /contractor/documents — список документов организации подрядчика. */
  async getDocuments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const data = await listOrgDocuments(orgId);
      res.json({ success: true, data });
    } catch (error) {
      console.error('Contractor getDocuments error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить документы' });
    }
  },

  /** POST /contractor/documents (multipart/form-data, поле "file"). */
  async uploadDocument(req: IMulterRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      if (!req.file) {
        res.status(400).json({ success: false, error: 'Файл обязателен' });
        return;
      }
      const doc = await uploadOrgDocument({
        orgId,
        fileName: decodeMulterFilename(req.file.originalname),
        buffer: req.file.buffer,
        mimeType: req.file.mimetype || 'application/octet-stream',
        uploadedBy: req.user.id,
      });
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_DOCUMENT_UPLOADED, {
        entityType: 'contractor_document',
        entityId: doc.id,
        details: { org_department_id: orgId, file_name: doc.file_name, file_size: doc.file_size },
      });
      res.json({ success: true, data: doc });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Не удалось загрузить файл';
      const status = /R2|не настроено|Недопустимый|больше|лимит/i.test(msg) ? 400 : 500;
      if (status === 500) console.error('Contractor uploadDocument error:', error);
      res.status(status).json({ success: false, error: msg });
    }
  },

  /** DELETE /contractor/documents/:id. */
  async deleteDocument(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const docId = z.string().uuid().parse(req.params.id);
      try {
        await deleteOrgDocument(orgId, docId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Не удалось удалить';
        res.status(404).json({ success: false, error: msg });
        return;
      }
      await auditService.logFromRequest(req, req.user.id, AUDIT_ACTIONS.CONTRACTOR_DOCUMENT_DELETED, {
        entityType: 'contractor_document',
        entityId: docId,
        details: { org_department_id: orgId },
      });
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id' });
        return;
      }
      console.error('Contractor deleteDocument error:', error);
      res.status(500).json({ success: false, error: 'Не удалось удалить документ' });
    }
  },

  /** GET /contractor/documents/:id/download — pre-signed URL. */
  async getDocumentDownloadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const orgId = await resolveOrgOr403(req, res);
      if (!orgId) return;
      const docId = z.string().uuid().parse(req.params.id);
      const out = await getOrgDocumentDownloadUrl(docId, orgId);
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
      console.error('Contractor getDocumentDownloadUrl error:', error);
      res.status(500).json({ success: false, error: 'Не удалось получить ссылку' });
    }
  },
};
