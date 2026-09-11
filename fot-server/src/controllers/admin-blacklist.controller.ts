import type { Response } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { auditService } from '../services/audit.service.js';
import { loadUserFullName } from '../services/audit-context.helpers.js';
import { escapeLike } from '../utils/search.utils.js';
import {
  addEntryIn,
  applyAccountLock,
  insertTargetsIn,
  removeEntryIn,
  resolveAffectedProfiles,
  resolveSigurTargets,
  normalizeEmailForMatch,
  normalizeSnilsForMatch,
  type IBlacklistTargetCandidate,
} from '../services/blacklist.service.js';
import { disconnectUserSockets } from '../socket/io-instance.js';
import { kickBlacklistSigur } from '../services/blacklist-sigur.scheduler.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Чёрный список: вкладка «Система» → «Пользователи» → «Чёрный список».
 *
 * Данные записи формирует СЕРВЕР: клиент присылает ref_id выбранного человека,
 * а ФИО/СНИЛС/почта/паспорт перечитываются из БД. Так исключены опечатки и
 * подмена идентификаторов с клиента.
 */

const addEntrySchema = z.object({
  // Выбор из поиска: сервер сам достанет данные по ref_id.
  person: z.object({
    kind: z.enum(['employee', 'contractor_pass']),
    ref_id: z.string().min(1),
  }).optional(),
  // Ручной ввод (человека в базе нет вообще).
  manual: z.object({
    full_name: z.string().trim().min(2).max(255),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    snils: z.string().trim().max(50).nullable().optional(),
    email: z.string().trim().max(255).nullable().optional(),
    passport_series_number: z.string().trim().max(100).nullable().optional(),
  }).optional(),
  // Дополнения к выбранному человеку: паспорт/ДР можно вписать руками.
  extra: z.object({
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    snils: z.string().trim().max(50).nullable().optional(),
    passport_series_number: z.string().trim().max(100).nullable().optional(),
  }).optional(),
  reason: z.string().trim().min(3).max(1000),
  /** Подтверждённые администратором weak-цели (strong сервер добавляет сам). */
  confirmed_weak_sigur_ids: z.array(z.number().int().positive()).max(100).optional(),
});

const removeEntrySchema = z.object({
  reason: z.string().trim().min(3).max(1000),
});

interface IPersonSource {
  full_name: string;
  birth_date: string | null;
  snils: string | null;
  email: string | null;
  passport_series_number: string | null;
  employee_id: number | null;
  user_profile_id: string | null;
  /** Откуда подтянуты документы — показывается в форме под заполненными полями. */
  source_note: string | null;
}

const passNote = (passNumber: string | null, orgName: string | null): string =>
  `из пропуска №${passNumber ?? '—'}${orgName ? ` · ${orgName}` : ''}`;

/**
 * Паспорт и дата рождения штатного сотрудника из его подрядного пропуска.
 *
 * В карточке сотрудника паспорта нет вообще, а даты рождения нет у 97% — зато
 * держатели пропусков продублированы как сотрудники с тем же профилем Sigur.
 * Совпадение ФИО текущего держателя обязательно: профиль пропуска
 * переиспользуется из пула и может хранить паспорт ПРЕЖНЕГО держателя.
 * Нашлось больше одного пропуска — не угадываем.
 */
async function loadDocsFromLinkedPass(
  sigurEmployeeId: number,
  fullName: string,
): Promise<{ birth_date: string | null; passport_series_number: string; note: string } | null> {
  const rows = await query<{
    birth_date: string | null; passport_series_number: string;
    pass_number: string | null; org_name: string | null;
  }>(
    `SELECT p.birth_date::text AS birth_date, p.passport_series_number,
            p.pass_number, od.name AS org_name
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
       LEFT JOIN org_departments od ON od.id = p.org_department_id
      WHERE p.sigur_employee_id = $1
        AND p.passport_series_number IS NOT NULL
        AND p.status IN ('assigned','submitted','applied','blocked')
        AND public.norm_person_name(COALESCE(h.holder_name, p.holder_name)) = public.norm_person_name($2)
      LIMIT 2`,
    [sigurEmployeeId, fullName],
  );
  if (!rows || rows.length !== 1) return null;
  const row = rows[0];
  return {
    birth_date: row.birth_date,
    passport_series_number: row.passport_series_number,
    note: passNote(row.pass_number, row.org_name),
  };
}

/** Читает данные выбранного человека из БД (клиенту доверяем только ref_id). */
async function loadPersonSource(
  kind: 'employee' | 'contractor_pass',
  refId: string,
): Promise<IPersonSource | null> {
  if (kind === 'employee') {
    const employeeId = Number(refId);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return null;
    const row = await queryOne<{
      full_name: string; birth_date: string | null; pension_number: string | null;
      email: string | null; id: number; profile_id: string | null;
      sigur_employee_id: number | null;
    }>(
      `SELECT e.id, e.full_name, e.birth_date::text AS birth_date, e.pension_number,
              e.email, e.sigur_employee_id, up.id AS profile_id
         FROM employees e
         LEFT JOIN user_profiles up ON up.employee_id = e.id
        WHERE e.id = $1`,
      [employeeId],
    );
    if (!row) return null;

    const source: IPersonSource = {
      full_name: row.full_name,
      birth_date: row.birth_date,
      snils: row.pension_number,
      email: row.email,
      passport_series_number: null,
      employee_id: row.id,
      user_profile_id: row.profile_id,
      source_note: 'из карточки сотрудника',
    };

    // Паспорта в карточке не бывает, поэтому пропуск смотрим всегда, когда есть
    // профиль Sigur. Значения карточки приоритетнее: пропуск только дополняет.
    if (row.sigur_employee_id != null) {
      const docs = await loadDocsFromLinkedPass(Number(row.sigur_employee_id), row.full_name);
      if (docs) {
        source.passport_series_number = docs.passport_series_number;
        source.birth_date = source.birth_date ?? docs.birth_date;
        source.source_note = docs.note;
      }
    }
    return source;
  }

  const row = await queryOne<{
    holder_name: string | null; birth_date: string | null;
    passport_series_number: string | null;
    pass_number: string | null; org_name: string | null;
  }>(
    `SELECT COALESCE(h.holder_name, p.holder_name) AS holder_name,
            p.birth_date::text AS birth_date, p.passport_series_number,
            p.pass_number, od.name AS org_name
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
       LEFT JOIN org_departments od ON od.id = p.org_department_id
      WHERE p.id = $1::uuid`,
    [refId],
  );
  if (!row || !row.holder_name) return null;
  return {
    full_name: row.holder_name,
    birth_date: row.birth_date,
    snils: null,
    email: null,
    passport_series_number: row.passport_series_number,
    employee_id: null,
    user_profile_id: null,
    source_note: passNote(row.pass_number, row.org_name),
  };
}

/** Находит учётку по email — нужна, чтобы отключить вход внесённому пользователю. */
async function findProfileIdByEmail(email: string | null): Promise<string | null> {
  const normalized = normalizeEmailForMatch(email);
  if (!normalized) return null;
  const row = await queryOne<{ id: string }>(
    'SELECT id FROM app_auth.users WHERE lower(email) = $1 LIMIT 1',
    [normalized],
  );
  return row?.id ?? null;
}

export const adminBlacklistController = {
  /** GET /api/admin/users/blacklist */
  async listBlacklist(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const includeRemoved = req.query.include_removed === '1' || req.query.include_removed === 'true';
      const rows = await query<Record<string, unknown>>(
        `SELECT b.id, b.full_name, b.birth_date::text AS birth_date, b.snils, b.email,
                b.passport_series_number, b.employee_id, b.user_profile_id,
                b.reason, b.created_by_name, b.created_at::text AS created_at,
                b.removed_at::text AS removed_at, b.removed_by_name, b.removal_reason,
                b.source,
                COALESCE(t.total, 0)   AS targets_total,
                COALESCE(t.done, 0)    AS targets_done,
                COALESCE(t.pending, 0) AS targets_pending,
                COALESCE(t.failed, 0)  AS targets_failed
           FROM public.person_blacklist b
           LEFT JOIN (
             SELECT blacklist_id,
                    count(*)                                    AS total,
                    count(*) FILTER (WHERE state = 'done')       AS done,
                    count(*) FILTER (WHERE state IN ('pending','running')) AS pending,
                    count(*) FILTER (WHERE state = 'failed')     AS failed
               FROM public.person_blacklist_targets
              GROUP BY blacklist_id
           ) t ON t.blacklist_id = b.id
          WHERE ($1::boolean OR b.removed_at IS NULL)
          ORDER BY b.removed_at IS NOT NULL, b.created_at DESC
          LIMIT 500`,
        [includeRemoved],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('listBlacklist error:', error);
      res.status(500).json({ success: false, error: 'Не удалось загрузить чёрный список' });
    }
  },

  /**
   * GET /api/admin/users/blacklist/persons?q=
   * Поиск человека для внесения. Два источника, LIMIT в каждой ветке — иначе
   * сотрудники вытеснили бы держателей пропусков. Сырые СНИЛС/паспорт/почту
   * в браузер не отдаём: только признаки наличия, значения возьмём по ref_id.
   */
  async searchPersons(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const q = ((req.query.q as string) || '').trim();
      if (q.length < 2) {
        res.json({ success: true, data: [] });
        return;
      }
      const pattern = `%${escapeLike(q)}%`;
      const rows = await query<Record<string, unknown>>(
        `(SELECT 'employee' AS kind, e.id::text AS ref_id, e.full_name,
                 e.birth_date::text AS birth_date,
                 nullif(regexp_replace(coalesce(e.pension_number,''),'\\D','','g'),'') IS NOT NULL AS has_snils,
                 nullif(btrim(coalesce(e.email,'')),'') IS NOT NULL AS has_email,
                 false AS has_passport,
                 NULL::text AS pass_number, NULL::text AS org_name,
                 e.employment_status AS extra
            FROM employees e
           WHERE e.full_name ILIKE $1 ESCAPE '\\'
           ORDER BY e.full_name
           LIMIT 20)
         UNION ALL
         (SELECT 'contractor_pass', p.id::text,
                 COALESCE(h.holder_name, p.holder_name),
                 p.birth_date::text,
                 false, false,
                 p.passport_series_number IS NOT NULL,
                 p.pass_number, od.name, p.status
            FROM contractor_passes p
            LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
            LEFT JOIN org_departments od ON od.id = p.org_department_id
           WHERE COALESCE(h.holder_name, p.holder_name) ILIKE $1 ESCAPE '\\'
             AND p.status IN ('assigned','submitted','applied','blocked','provisioning')
           ORDER BY p.pass_number
           LIMIT 20)`,
        [pattern],
      );
      res.json({ success: true, data: rows });
    } catch (error) {
      console.error('searchPersons error:', error);
      res.status(500).json({ success: false, error: 'Не удалось выполнить поиск' });
    }
  },

  /**
   * POST /api/admin/users/blacklist/resolve
   * Показывает, что именно будет заблокировано, до создания записи.
   */
  async resolveTargets(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = addEntrySchema.partial({ reason: true }).parse(req.body);
      const source = await resolveEntrySource(body);
      if (!source) {
        res.status(400).json({ success: false, error: 'Не указан человек' });
        return;
      }
      const targets = await resolveSigurTargets({
        employeeId: source.employee_id,
        snils: source.snils,
        email: source.email,
        passport: source.passport_series_number,
        fullName: source.full_name,
        birthDate: source.birth_date,
      });
      res.json({ success: true, data: { person: source, ...targets } });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('resolveTargets error:', error);
      res.status(500).json({ success: false, error: 'Не удалось определить цели блокировки' });
    }
  },

  /** POST /api/admin/users/blacklist */
  async addEntry(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const body = addEntrySchema.parse(req.body);
      const source = await resolveEntrySource(body);
      if (!source) {
        res.status(400).json({ success: false, error: 'Не указан человек' });
        return;
      }

      // Требование заказчика: ФИО + причина + хотя бы один идентификатор.
      const hasIdentifier = source.employee_id !== null
        || normalizeSnilsForMatch(source.snils) !== null
        || normalizeEmailForMatch(source.email) !== null
        || !!source.passport_series_number
        || !!source.birth_date;
      if (!hasIdentifier) {
        res.status(400).json({
          success: false,
          error: 'Нужен хотя бы один идентификатор: СНИЛС, почта, паспорт или дата рождения',
        });
        return;
      }

      const actorName = (await loadUserFullName(req.user.id)) ?? 'Администратор';
      const targets = await resolveSigurTargets({
        employeeId: source.employee_id,
        snils: source.snils,
        email: source.email,
        passport: source.passport_series_number,
        fullName: source.full_name,
        birthDate: source.birth_date,
      });

      // Strong-цели сервер добавляет всегда сам; из weak берём только те, что
      // администратор подтвердил И которые есть в свежем серверном резолве.
      const confirmed = new Set(body.confirmed_weak_sigur_ids ?? []);
      const selected: IBlacklistTargetCandidate[] = [
        ...targets.strong,
        ...targets.weak.filter(t => confirmed.has(t.sigur_employee_id)),
      ];

      const profileIdByEmail = await findProfileIdByEmail(source.email);
      const userProfileId = source.user_profile_id ?? profileIdByEmail;

      const result = await withTransaction(async (client) => {
        const added = await addEntryIn(client, {
          fullName: source.full_name,
          reason: body.reason,
          birthDate: source.birth_date,
          snils: source.snils,
          email: source.email,
          passport: source.passport_series_number,
          employeeId: source.employee_id,
          userProfileId,
          source: body.person ? 'person_pick' : 'manual',
          createdBy: req.user.id,
          createdByName: actorName,
        });

        if (!added.created) {
          return { entry: added.entry, created: false, transitions: [], targetsInserted: 0 };
        }

        const targetsInserted = await insertTargetsIn(client, added.entry.id, selected);

        const affected = await resolveAffectedProfiles(client, {
          emailLower: normalizeEmailForMatch(source.email),
          employeeId: source.employee_id,
          userProfileId,
        });
        const transitions = await applyAccountLock(client, affected);

        await auditService.logFromRequestWithClient(client, req, req.user.id, 'BLACKLIST_ADDED', {
          entityType: 'person_blacklist',
          entityId: added.entry.id,
          details: {
            full_name: source.full_name,
            email_lower: normalizeEmailForMatch(source.email),
            has_snils: normalizeSnilsForMatch(source.snils) !== null,
            has_passport: !!source.passport_series_number,
            employee_id: source.employee_id,
            targets: targetsInserted,
            source: body.person ? 'person_pick' : 'manual',
          },
        });

        return { entry: added.entry, created: true, transitions, targetsInserted };
      });

      if (result.created) {
        // Вход закрыт — рвём живые сокеты: handshake проверяет статус, а уже
        // открытое соединение его не перепроверяет.
        for (const transition of result.transitions) {
          if (!transition.was && transition.now) await disconnectUserSockets(transition.userProfileId);
        }
        kickBlacklistSigur();
      }

      res.json({
        success: true,
        created: result.created,
        data: result.entry,
        targets: result.targetsInserted,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('addEntry error:', error);
      res.status(500).json({ success: false, error: 'Не удалось добавить в чёрный список' });
    }
  },

  /** POST /api/admin/users/blacklist/:entryId/remove */
  async removeEntry(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { reason } = removeEntrySchema.parse(req.body);
      const entryId = z.string().uuid().parse(req.params.entryId);
      const actorName = (await loadUserFullName(req.user.id)) ?? 'Администратор';

      const result = await withTransaction(async (client) => {
        const removed = await removeEntryIn(client, entryId, { id: req.user.id, name: actorName }, reason);
        if (!removed.changed || !removed.entry) return { ...removed, transitions: [] };

        const affected = await resolveAffectedProfiles(client, {
          emailLower: normalizeEmailForMatch(removed.entry.email),
          employeeId: removed.entry.employee_id,
          userProfileId: removed.entry.user_profile_id,
        });
        const transitions = await applyAccountLock(client, affected);

        await auditService.logFromRequestWithClient(client, req, req.user.id, 'BLACKLIST_REMOVED', {
          entityType: 'person_blacklist',
          entityId: entryId,
          details: { full_name: removed.entry.full_name, reason },
        });

        return { ...removed, transitions };
      });

      if (!result.entry) {
        res.status(404).json({ success: false, error: 'Запись не найдена' });
        return;
      }

      res.json({ success: true, changed: result.changed, data: result.entry });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('removeEntry error:', error);
      res.status(500).json({ success: false, error: 'Не удалось снять из чёрного списка' });
    }
  },

  /** POST /api/admin/users/blacklist/:entryId/retry-sigur */
  async retrySigur(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const entryId = z.string().uuid().parse(req.params.entryId);
      // Только активная запись: снятую заново блокировать нельзя.
      const updated = await withTransaction(async (client) => {
        const res2 = await client.query(
          `UPDATE public.person_blacklist_targets t
              SET state = 'pending', attempts = 0, last_error = NULL,
                  lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE t.blacklist_id = $1::uuid AND t.state = 'failed'
              AND EXISTS (SELECT 1 FROM public.person_blacklist b
                           WHERE b.id = t.blacklist_id AND b.removed_at IS NULL)`,
          [entryId],
        );
        return res2.rowCount ?? 0;
      });

      if (updated > 0) kickBlacklistSigur();
      res.json({ success: true, requeued: updated });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный идентификатор записи' });
        return;
      }
      console.error('retrySigur error:', error);
      res.status(500).json({ success: false, error: 'Не удалось повторить блокировку' });
    }
  },
};

/** Собирает данные человека: из справочника по ref_id либо из ручного ввода. */
async function resolveEntrySource(
  body: z.infer<typeof addEntrySchema> | Partial<z.infer<typeof addEntrySchema>>,
): Promise<IPersonSource | null> {
  let source: IPersonSource | null = null;

  if (body.person) {
    source = await loadPersonSource(body.person.kind, body.person.ref_id);
    if (!source) return null;
  } else if (body.manual) {
    source = {
      full_name: body.manual.full_name,
      birth_date: body.manual.birth_date ?? null,
      snils: body.manual.snils ?? null,
      email: body.manual.email ?? null,
      passport_series_number: body.manual.passport_series_number ?? null,
      employee_id: null,
      user_profile_id: null,
      source_note: null,
    };
  }

  if (!source) return null;

  // Ручные дополнения не перебивают данные из БД, а заполняют пустые поля:
  // источник истины — справочник, клавиатура лишь дополняет.
  if (body.extra) {
    source.birth_date = source.birth_date ?? body.extra.birth_date ?? null;
    source.snils = source.snils ?? body.extra.snils ?? null;
    source.passport_series_number = source.passport_series_number
      ?? body.extra.passport_series_number ?? null;
  }

  return source;
}
