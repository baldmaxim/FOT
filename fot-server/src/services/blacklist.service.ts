import type { PoolClient } from 'pg';
import { query, queryOne, type DbExecutor } from '../config/postgres.js';
import { normalizeDigits, normalizeNameForHash } from './hr-crypto.service.js';

/**
 * Чёрный список физлиц (миграция 273) — единственный источник правды по
 * нормализации и сопоставлению. Все гейты ходят сюда, чтобы правила не
 * расползлись по контроллерам (как уже случилось с normalizeEmail — три копии).
 *
 * Сила совпадения:
 *  - strong (employee_id / user_profile_id / СНИЛС / email / паспорт / ФИО+ДР) —
 *    жёсткий запрет действия;
 *  - weak (только ФИО) — предупреждение без запрета: однофамильцы легальны.
 */

/** Нормализация email: канон совпадает с app_auth.users (unique-индекс lower(email)). */
export const normalizeEmailForMatch = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

/**
 * СНИЛС — ровно 11 цифр. normalizeDigits(v, 11) ОБРЕЗАЕТ лишние через slice,
 * поэтому вызываем без лимита и сами проверяем длину: иначе 12-значный ввод
 * молча превратился бы в чужой СНИЛС.
 */
export const normalizeSnilsForMatch = (value: string | null | undefined): string | null => {
  const digits = normalizeDigits(value);
  return digits && digits.length === 11 ? digits : null;
};

/** Паспорт — та же нормализация, что normalizeDocSql (contractor-docs.service.ts). */
export const normalizePassportForMatch = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[^0-9A-Za-zА-Яа-яЁё]/g, '').toLowerCase();
  return normalized || null;
};

/** ФИО — реэкспорт канона; в БД ему соответствует public.norm_person_name(). */
export const normalizeNameForMatch = normalizeNameForHash;

export type BlacklistMatchReason =
  | 'employee_id'
  | 'user_profile_id'
  | 'snils'
  | 'email'
  | 'passport'
  | 'name_birth'
  | 'name';

export interface IBlacklistEntry {
  id: string;
  full_name: string;
  birth_date: string | null;
  snils: string | null;
  email: string | null;
  passport_series_number: string | null;
  employee_id: number | null;
  user_profile_id: string | null;
  reason: string;
  created_by_name: string;
  created_at: string;
  match_reason?: BlacklistMatchReason;
}

export interface IBlacklistLookup {
  employeeId?: number | null;
  userProfileId?: string | null;
  snils?: string | null;
  email?: string | null;
  passport?: string | null;
  fullName?: string | null;
  birthDate?: string | null;
}

export interface IBlacklistMatches {
  /** Совпадения по надёжному ключу — основание для запрета. */
  strong: IBlacklistEntry[];
  /** Совпадение только по ФИО — повод предупредить, но не запрещать. */
  weak: IBlacklistEntry[];
}

/** Ошибка запрета: контроллеры превращают её в 409/422 со своим текстом. */
export class BlacklistBlockedError extends Error {
  readonly entries: IBlacklistEntry[];

  constructor(message: string, entries: IBlacklistEntry[]) {
    super(message);
    this.name = 'BlacklistBlockedError';
    this.entries = entries;
  }
}

const ENTRY_COLUMNS = `id, full_name, birth_date::text AS birth_date, snils, email,
  passport_series_number, employee_id, user_profile_id, reason, created_by_name,
  created_at::text AS created_at`;

/**
 * Ищет активные записи по всем доступным ключам сразу.
 * Возвращает strong и weak отдельно — решение принимает вызывающий гейт.
 */
export async function findActive(
  lookup: IBlacklistLookup,
  executor?: DbExecutor,
): Promise<IBlacklistMatches> {
  const employeeId = typeof lookup.employeeId === 'number' ? lookup.employeeId : null;
  const userProfileId = lookup.userProfileId || null;
  const snils = normalizeSnilsForMatch(lookup.snils);
  const email = normalizeEmailForMatch(lookup.email);
  const passport = normalizePassportForMatch(lookup.passport);
  const nameNorm = normalizeNameForMatch(lookup.fullName);
  const birthDate = lookup.birthDate || null;

  const hasAnyKey = employeeId !== null || userProfileId || snils || email || passport || nameNorm;
  if (!hasAnyKey) return { strong: [], weak: [] };

  const sql = `
    SELECT ${ENTRY_COLUMNS},
           CASE
             WHEN $1::bigint IS NOT NULL AND employee_id = $1::bigint      THEN 'employee_id'
             WHEN $2::uuid   IS NOT NULL AND user_profile_id = $2::uuid    THEN 'user_profile_id'
             WHEN $3::text   IS NOT NULL AND snils_digits = $3             THEN 'snils'
             WHEN $4::text   IS NOT NULL AND email_lower = $4              THEN 'email'
             WHEN $5::text   IS NOT NULL AND passport_norm = $5            THEN 'passport'
             WHEN $6::text   IS NOT NULL AND full_name_norm = $6
                  AND $7::date IS NOT NULL AND birth_date = $7::date       THEN 'name_birth'
             ELSE 'name'
           END AS match_reason
      FROM public.person_blacklist
     WHERE removed_at IS NULL
       AND (
            ($1::bigint IS NOT NULL AND employee_id = $1::bigint)
         OR ($2::uuid   IS NOT NULL AND user_profile_id = $2::uuid)
         OR ($3::text   IS NOT NULL AND snils_digits = $3)
         OR ($4::text   IS NOT NULL AND email_lower = $4)
         OR ($5::text   IS NOT NULL AND passport_norm = $5)
         OR ($6::text   IS NOT NULL AND full_name_norm = $6)
       )
     ORDER BY created_at DESC
     LIMIT 50`;

  const params = [employeeId, userProfileId, snils, email, passport, nameNorm, birthDate];
  const rows = executor
    ? (await executor.query<IBlacklistEntry>(sql, params)).rows
    : await query<IBlacklistEntry>(sql, params);

  const strong: IBlacklistEntry[] = [];
  const weak: IBlacklistEntry[] = [];
  for (const row of rows) {
    if (row.match_reason === 'name') weak.push(row);
    else strong.push(row);
  }
  return { strong, weak };
}

/**
 * Единый серверный guard. strict — бросает BlacklistBlockedError на strong-совпадении;
 * warn — только возвращает совпадения, решение остаётся за вызывающим.
 */
export async function assertNotBlacklisted(
  lookup: IBlacklistLookup,
  options: { mode?: 'strict' | 'warn'; message?: string; executor?: DbExecutor } = {},
): Promise<IBlacklistMatches> {
  const matches = await findActive(lookup, options.executor);
  if ((options.mode ?? 'strict') === 'strict' && matches.strong.length > 0) {
    throw new BlacklistBlockedError(
      options.message ?? 'Действие запрещено: человек в чёрном списке',
      matches.strong,
    );
  }
  return matches;
}

/** Проверка по профилю Sigur — для гейта разблокировки. */
export async function findActiveBySigurEmployeeId(
  sigurEmployeeId: number,
  executor?: DbExecutor,
): Promise<IBlacklistEntry | null> {
  const explicit = `
    SELECT b.id, b.full_name, b.birth_date::text AS birth_date, b.snils, b.email,
           b.passport_series_number, b.employee_id, b.user_profile_id, b.reason,
           b.created_by_name, b.created_at::text AS created_at
      FROM public.person_blacklist b
      JOIN public.person_blacklist_targets t ON t.blacklist_id = b.id
     WHERE b.removed_at IS NULL AND t.sigur_employee_id = $1::bigint
     LIMIT 1`;
  if (executor) {
    const res = await executor.query<IBlacklistEntry>(explicit, [sigurEmployeeId]);
    return res.rows[0] ?? null;
  }
  return queryOne<IBlacklistEntry>(explicit, [sigurEmployeeId]);
}

/**
 * Текст запрета. Причину и автора показываем только тем, у кого есть доступ к
 * самому реестру: вкладка подрядных заявок открыта и узкой роли ОТиТБ, а
 * подрядчику факт вообще не раскрываем.
 */
export function blockMessage(entries: IBlacklistEntry[], canSeeReason: boolean): string {
  if (!canSeeReason || entries.length === 0) {
    return 'Действие запрещено. Обратитесь к администратору.';
  }
  const first = entries[0];
  return `В чёрном списке: ${first.full_name} — ${first.reason} (внёс ${first.created_by_name}).`;
}

// ─── Цели блокировки в Sigur ────────────────────────────────────────────────

export interface IBlacklistTargetCandidate {
  kind: 'employee' | 'contractor_pass';
  employee_id: number | null;
  pass_id: string | null;
  sigur_employee_id: number;
  match_reason: string;
  label: string;
  org_name: string | null;
  pass_number: string | null;
}

export interface IResolvedTargets {
  strong: IBlacklistTargetCandidate[];
  weak: IBlacklistTargetCandidate[];
}

/**
 * Находит профили Sigur, которые нужно заблокировать: штатную карточку и
 * подрядные пропуска. Клиент не может прислать произвольный sigur_employee_id —
 * серверный результат работает allow-list-ом (как batch.candidates в blockDuplicate).
 */
export async function resolveSigurTargets(
  lookup: IBlacklistLookup,
  executor?: DbExecutor,
): Promise<IResolvedTargets> {
  const employeeId = typeof lookup.employeeId === 'number' ? lookup.employeeId : null;
  const snils = normalizeSnilsForMatch(lookup.snils);
  const email = normalizeEmailForMatch(lookup.email);
  const passport = normalizePassportForMatch(lookup.passport);
  const nameNorm = normalizeNameForMatch(lookup.fullName);
  const birthDate = lookup.birthDate || null;

  const runner = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
    executor ? (await executor.query(sql, params)).rows as T[] : await query(sql, params) as T[];

  // Ветка 1: штатные карточки. Фильтра по employment_status нет намеренно —
  // в ЧС вносят в том числе уже уволенных.
  const employeeRows = await runner<{
    employee_id: number; sigur_employee_id: number; full_name: string; match_reason: string;
  }>(
    `SELECT e.id AS employee_id, e.sigur_employee_id, e.full_name,
            CASE
              WHEN $1::bigint IS NOT NULL AND e.id = $1::bigint THEN 'employee_id'
              WHEN $2::text IS NOT NULL
                   AND nullif(regexp_replace(coalesce(e.pension_number,''),'\\D','','g'),'') = $2 THEN 'snils'
              WHEN $3::text IS NOT NULL AND lower(btrim(coalesce(e.email,''))) = $3 THEN 'email'
              ELSE 'name_birth'
            END AS match_reason
       FROM public.employees e
      WHERE e.sigur_employee_id IS NOT NULL
        AND (
             ($1::bigint IS NOT NULL AND e.id = $1::bigint)
          OR ($2::text IS NOT NULL
              AND nullif(regexp_replace(coalesce(e.pension_number,''),'\\D','','g'),'') = $2)
          OR ($3::text IS NOT NULL AND lower(btrim(coalesce(e.email,''))) = $3)
          OR ($4::text IS NOT NULL AND $5::date IS NOT NULL
              AND public.norm_person_name(e.full_name) = $4 AND e.birth_date = $5::date)
        )
      LIMIT 50`,
    [employeeId, snils, email, nameNorm, birthDate],
  );

  // Ветка 2: подрядные пропуска. СНИЛС и email там отсутствуют — только паспорт и ФИО+ДР.
  const passRows = await runner<{
    pass_id: string; sigur_employee_id: number; holder_name: string | null;
    pass_number: string; org_name: string | null; match_reason: string;
  }>(
    `SELECT p.id AS pass_id, p.sigur_employee_id,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            p.pass_number, od.name AS org_name,
            CASE
              WHEN $1::text IS NOT NULL
                   AND nullif(lower(regexp_replace(coalesce(p.passport_series_number,''),
                                                   '[^0-9A-Za-zА-Яа-яЁё]','','g')),'') = $1 THEN 'passport'
              ELSE 'name_birth'
            END AS match_reason
       FROM public.contractor_passes p
       LEFT JOIN public.contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
       LEFT JOIN public.org_departments od ON od.id = p.org_department_id
      WHERE p.sigur_employee_id IS NOT NULL
        AND p.status IN ('assigned','submitted','applied','blocked','provisioning')
        AND (
             ($1::text IS NOT NULL
              AND nullif(lower(regexp_replace(coalesce(p.passport_series_number,''),
                                              '[^0-9A-Za-zА-Яа-яЁё]','','g')),'') = $1)
          OR ($2::text IS NOT NULL AND $3::date IS NOT NULL
              AND public.norm_person_name(COALESCE(h.holder_name, p.holder_name)) = $2
              AND p.birth_date = $3::date)
          OR ($2::text IS NOT NULL AND $3::date IS NULL
              AND public.norm_person_name(COALESCE(h.holder_name, p.holder_name)) = $2)
        )
      LIMIT 50`,
    [passport, nameNorm, birthDate],
  );

  const strong: IBlacklistTargetCandidate[] = [];
  const weak: IBlacklistTargetCandidate[] = [];
  const seen = new Set<number>();

  for (const row of employeeRows) {
    if (seen.has(Number(row.sigur_employee_id))) continue;
    seen.add(Number(row.sigur_employee_id));
    strong.push({
      kind: 'employee',
      employee_id: Number(row.employee_id),
      pass_id: null,
      sigur_employee_id: Number(row.sigur_employee_id),
      match_reason: row.match_reason,
      label: row.full_name,
      org_name: null,
      pass_number: null,
    });
  }

  for (const row of passRows) {
    if (seen.has(Number(row.sigur_employee_id))) continue;
    seen.add(Number(row.sigur_employee_id));
    const candidate: IBlacklistTargetCandidate = {
      kind: 'contractor_pass',
      employee_id: null,
      pass_id: row.pass_id,
      sigur_employee_id: Number(row.sigur_employee_id),
      match_reason: row.match_reason,
      label: row.holder_name ?? '',
      org_name: row.org_name,
      pass_number: row.pass_number,
    };
    // ФИО без даты рождения — weak: подтверждать такую цель должен человек.
    if (row.match_reason === 'name_birth' && !birthDate) weak.push(candidate);
    else strong.push(candidate);
  }

  return { strong, weak };
}

// ─── Состояние учётной записи ───────────────────────────────────────────────

export interface IAccountLockTransition {
  userProfileId: string;
  was: boolean;
  now: boolean;
}

/**
 * Находит ВСЕ учётки, затронутые записью: по email, по карточке сотрудника и по
 * прямой ссылке. recompute работает по известным id, поэтому список нужно собрать.
 */
export async function resolveAffectedProfiles(
  client: PoolClient,
  input: { emailLower?: string | null; employeeId?: number | null; userProfileId?: string | null },
): Promise<string[]> {
  const email = input.emailLower ?? null;
  const employeeId = typeof input.employeeId === 'number' ? input.employeeId : null;
  const userProfileId = input.userProfileId ?? null;
  if (!email && employeeId === null && !userProfileId) return [];

  const res = await client.query<{ id: string }>(
    `SELECT up.id
       FROM public.user_profiles up
       LEFT JOIN app_auth.users au ON au.id = up.id
      WHERE ($1::text IS NOT NULL AND lower(au.email) = $1)
         OR ($2::bigint IS NOT NULL AND up.employee_id = $2::bigint)
         OR ($3::uuid IS NOT NULL AND up.id = $3::uuid)`,
    [email, employeeId, userProfileId],
  );
  return res.rows.map(r => r.id);
}

/**
 * Приводит is_disabled к производному значению «есть активная запись ЧС».
 * Владения флагом нет намеренно: при двух записях на одного человека владелец
 * залипал бы и вход не открылся бы никогда. Возвращает переход по каждой учётке,
 * чтобы token_version и разрыв сокетов срабатывали только на реальном изменении.
 */
export async function applyAccountLock(
  client: PoolClient,
  userProfileIds: readonly string[],
): Promise<IAccountLockTransition[]> {
  if (userProfileIds.length === 0) return [];

  const res = await client.query<{ id: string; was: boolean; now: boolean }>(
    `WITH before AS (
       SELECT id, is_disabled FROM app_auth.users WHERE id = ANY($1::uuid[]) FOR UPDATE
     ), upd AS (
       UPDATE app_auth.users au
          SET is_disabled = EXISTS (
                SELECT 1 FROM public.person_blacklist b
                 WHERE b.removed_at IS NULL AND b.user_profile_id = au.id)
        WHERE au.id = ANY($1::uuid[])
        RETURNING au.id, au.is_disabled
     )
     SELECT u.id, b.is_disabled AS was, u.is_disabled AS now
       FROM upd u JOIN before b ON b.id = u.id`,
    [[...userProfileIds]],
  );

  const transitions = res.rows.map(r => ({ userProfileId: r.id, was: r.was, now: r.now }));

  // token_version рвёт активную сессию: authenticate отдаст 401, refresh не сойдётся.
  const changed = transitions.filter(t => t.was !== t.now).map(t => t.userProfileId);
  if (changed.length > 0) {
    await client.query(
      `UPDATE public.user_profiles
          SET token_version = token_version + 1, updated_at = now()
        WHERE id = ANY($1::uuid[])`,
      [changed],
    );
  }

  return transitions;
}

// ─── Добавление и снятие (идемпотентно) ─────────────────────────────────────

export interface IAddEntryInput {
  fullName: string;
  reason: string;
  birthDate?: string | null;
  snils?: string | null;
  email?: string | null;
  passport?: string | null;
  employeeId?: number | null;
  userProfileId?: string | null;
  source: 'manual' | 'person_pick' | 'user_reject';
  createdBy: string | null;
  createdByName: string;
}

export interface IAddEntryResult {
  entry: IBlacklistEntry;
  /** false — активная запись уже была: аудит не пишем, дубль не создаём. */
  created: boolean;
}

/**
 * Advisory-локи по всем ключам человека. Порядок фиксирован (сортировка), иначе
 * два параллельных добавления с пересекающимися ключами дали бы deadlock.
 */
async function lockPersonKeys(client: PoolClient, input: IAddEntryInput): Promise<void> {
  const keys = [
    input.employeeId != null ? `blacklist:emp:${input.employeeId}` : null,
    normalizeSnilsForMatch(input.snils) ? `blacklist:snils:${normalizeSnilsForMatch(input.snils)}` : null,
    normalizeEmailForMatch(input.email) ? `blacklist:mail:${normalizeEmailForMatch(input.email)}` : null,
    normalizePassportForMatch(input.passport) ? `blacklist:pass:${normalizePassportForMatch(input.passport)}` : null,
  ].filter((k): k is string => !!k).sort();

  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }
}

/**
 * Создаёт запись ЧС внутри транзакции вызывающего.
 *
 * Идемпотентность: сначала advisory-локи по ключам, затем поиск активной записи
 * (её возвращаем с created=false), и только потом INSERT. Гонку вне локов
 * ловим по 23505 и тоже отдаём существующую запись, а не 500.
 */
export async function addEntryIn(
  client: PoolClient,
  input: IAddEntryInput,
): Promise<IAddEntryResult> {
  await lockPersonKeys(client, input);

  const existing = await findActive(
    {
      employeeId: input.employeeId ?? null,
      userProfileId: input.userProfileId ?? null,
      snils: input.snils ?? null,
      email: input.email ?? null,
      passport: input.passport ?? null,
    },
    client,
  );
  if (existing.strong.length > 0) {
    return { entry: existing.strong[0], created: false };
  }

  try {
    const res = await client.query<IBlacklistEntry>(
      `INSERT INTO public.person_blacklist
         (full_name, birth_date, snils, email, passport_series_number,
          employee_id, user_profile_id, reason, created_by, created_by_name, source)
       VALUES ($1, $2::date, $3, $4, $5, $6::bigint, $7::uuid, $8, $9::uuid, $10, $11)
       RETURNING id, full_name, birth_date::text AS birth_date, snils, email,
                 passport_series_number, employee_id, user_profile_id, reason,
                 created_by_name, created_at::text AS created_at`,
      [
        input.fullName.trim(),
        input.birthDate || null,
        input.snils || null,
        input.email || null,
        input.passport || null,
        input.employeeId ?? null,
        input.userProfileId ?? null,
        input.reason.trim(),
        input.createdBy,
        input.createdByName,
        input.source,
      ],
    );
    return { entry: res.rows[0], created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const again = await findActive(
        {
          employeeId: input.employeeId ?? null,
          snils: input.snils ?? null,
          email: input.email ?? null,
          passport: input.passport ?? null,
        },
        client,
      );
      if (again.strong.length > 0) return { entry: again.strong[0], created: false };
    }
    throw error;
  }
}

/** Записывает цели блокировки. Повтор безопасен: ON CONFLICT DO NOTHING. */
export async function insertTargetsIn(
  client: PoolClient,
  blacklistId: string,
  targets: readonly IBlacklistTargetCandidate[],
): Promise<number> {
  let inserted = 0;
  for (const target of targets) {
    const res = await client.query(
      `INSERT INTO public.person_blacklist_targets
         (blacklist_id, kind, employee_id, pass_id, sigur_employee_id, match_reason)
       VALUES ($1::uuid, $2, $3::bigint, $4::uuid, $5::bigint, $6)
       ON CONFLICT (blacklist_id, sigur_employee_id) DO NOTHING`,
      [blacklistId, target.kind, target.employee_id, target.pass_id, target.sigur_employee_id, target.match_reason],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

export interface IRemoveEntryResult {
  /** false — запись уже была снята: повторное снятие ничего не меняет. */
  changed: boolean;
  entry: IBlacklistEntry | null;
}

/**
 * Снимает запись. Повторный вызов идемпотентен: возвращает changed=false, и
 * вызывающий не пишет второй аудит. Незапущенные цели отменяются, чтобы
 * восстановившийся воркер не заблокировал уже снятого человека.
 */
export async function removeEntryIn(
  client: PoolClient,
  entryId: string,
  actor: { id: string | null; name: string },
  reason: string,
): Promise<IRemoveEntryResult> {
  const res = await client.query<IBlacklistEntry>(
    `UPDATE public.person_blacklist
        SET removed_at = now(), removed_by = $2::uuid, removed_by_name = $3,
            removal_reason = $4, updated_at = now()
      WHERE id = $1::uuid AND removed_at IS NULL
      RETURNING id, full_name, birth_date::text AS birth_date, snils, email,
                passport_series_number, employee_id, user_profile_id, reason,
                created_by_name, created_at::text AS created_at`,
    [entryId, actor.id, actor.name, reason.trim()],
  );

  if (res.rows.length === 0) {
    const current = await client.query<IBlacklistEntry>(
      `SELECT id, full_name, birth_date::text AS birth_date, snils, email,
              passport_series_number, employee_id, user_profile_id, reason,
              created_by_name, created_at::text AS created_at
         FROM public.person_blacklist WHERE id = $1::uuid`,
      [entryId],
    );
    return { changed: false, entry: current.rows[0] ?? null };
  }

  await client.query(
    `UPDATE public.person_blacklist_targets
        SET state = 'skipped', updated_at = now()
      WHERE blacklist_id = $1::uuid AND state = 'pending'`,
    [entryId],
  );

  return { changed: true, entry: res.rows[0] };
}

// ─── Сериализация блокировки и разблокировки профиля Sigur ──────────────────

/**
 * Выполняет действие над профилем Sigur под advisory-локом по этому профилю и
 * проверяет чёрный список ВНУТРИ лока.
 *
 * Зачем лок вокруг самого вызова, а не только проверка перед ним: между
 * проверкой и `blocked:false` запись ЧС могла закоммититься, и одобрение
 * разблокировало бы только что внесённого человека. Лок держится до конца
 * действия, поэтому добавление в ЧС и разблокировка не могут идти параллельно.
 *
 * Соединение пула занято на время внешнего вызова (обычно секунды) — это
 * осознанная плата за отсутствие гонки; батч одобрения идёт последовательно,
 * поэтому больше одного соединения за раз не удерживается.
 */
export async function withSigurProfileGuard<T>(
  sigurEmployeeId: number,
  action: () => Promise<T>,
  options: { skipBlacklistCheck?: boolean; canSeeReason?: boolean } = {},
): Promise<T> {
  const { withTransaction } = await import('../config/postgres.js');
  return withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`blacklist:sigur:${sigurEmployeeId}`]);

    if (!options.skipBlacklistCheck) {
      const entry = await findActiveBySigurEmployeeId(sigurEmployeeId, client);
      if (entry) {
        throw new BlacklistBlockedError(
          blockMessage([entry], options.canSeeReason !== false),
          [entry],
        );
      }
    }

    return action();
  });
}
