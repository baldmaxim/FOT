/**
 * Проверки физлиц через newdb.net: РКЛ (реестр контролируемых лиц) и патент.
 *
 * ЕДИНСТВЕННОЕ место, где живёт знание о странностях API newdb: имена методов,
 * форматы дат, парсинг документов, маппинг статусов провайдера → наш UI-статус.
 * Контроллеры/UI не знают формата newdb. Первый реальный ответ подкручивается
 * здесь, без расползания логики.
 *
 * Стоимость/безопасность:
 *  - Валидация ПД ДО запроса: не шлём мусор в платный API.
 *  - Запись newdb_checks создаётся ДО вызова (request_sent=false), затем перед
 *    вызовом request_sent=true — аудит переживает обрыв/таймаут.
 *  - Анти-даблклик гейт считает только записи с request_sent=true.
 */
import { query, queryOne, execute } from '../config/postgres.js';
import { newdbBaseService, NewdbApiError } from './newdb-base.service.js';
import { citizenshipRequiresPatent } from './contractor-docs.service.js';

export type CheckType = 'rkl' | 'patent';
export type CheckStatus = 'clean' | 'found' | 'invalid' | 'error' | 'not_applicable';

// Повторный платный запуск той же (pass, type) в пределах окна — отклоняем.
const ANTI_DOUBLE_WINDOW_MS = 30_000;

interface IPassDataRow {
  id: string;
  org_department_id: string;
  holder_name: string | null;
  birth_date: string | null;           // YYYY-MM-DD
  passport_series_number: string | null;
  passport_issue_date: string | null;  // YYYY-MM-DD
  citizenship: string | null;
  patent_number: string | null;
  patent_blank_number: string | null;
  has_residence_permit: boolean | null;
  residence_permit_number: string | null;
}

interface ICheckOutcome {
  status: CheckStatus;
  providerStatus: string | null;
  summary: string | null;
  raw: unknown;
  qid: string | null;
  balance: number | null;
  errorMessage: string | null;
  requestSent: boolean;
}

// ─── Утилиты парсинга (странности форматов — только тут) ────────────────────

/** Разбить ФИО: «Фамилия Имя Отчество…». Отчество опционально (остаток). */
export const splitFullName = (fullName: string | null | undefined): {
  lastName: string;
  firstName: string;
  secondName: string;
} => {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    lastName: parts[0] || '',
    firstName: parts[1] || '',
    secondName: parts.slice(2).join(' ') || '',
  };
};

/**
 * Разбить документ на серию и номер. РФ-паспорт: ровно 10 цифр → серия=4, номер=6.
 * Иначе fallback: буквенный/пробельный префикс = серия, хвост цифр = номер.
 */
export const splitDocSeriaNumber = (raw: string | null | undefined): { seria: string; number: string } => {
  const cleaned = (raw || '').replace(/\s+/g, '').trim();
  if (!cleaned) return { seria: '', number: '' };

  const digitsOnly = cleaned.replace(/\D/g, '');
  if (/^\d+$/.test(cleaned) && digitsOnly.length === 10) {
    return { seria: digitsOnly.slice(0, 4), number: digitsOnly.slice(4) };
  }

  const m = cleaned.match(/^(.*?)(\d+)$/);
  if (m && m[2]) {
    return { seria: m[1] || '', number: m[2] };
  }
  return { seria: '', number: cleaned };
};

/** YYYY-MM-DD → DD.MM.YYYY (для РКЛ dob_info / issue_date). */
export const toDdMmYyyy = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
};

/** Оставить YYYY-MM-DD (для патента dob). */
export const toYyyyMmDd = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};

// ─── Маппинг ответов провайдера ─────────────────────────────────────────────

const mapRklResponse = (data: any): { status: CheckStatus; providerStatus: string | null; summary: string | null } => {
  const item = data?.results?.rkl?.result?.data?.[0];
  const registryStatus: string | null = item?.registry_status ?? null;
  const title: string | null = item?.title ?? null;

  let status: CheckStatus;
  if (registryStatus === 'not_found') status = 'clean';
  else if (registryStatus === 'found') status = 'found';
  else status = 'error'; // unknown / отсутствует — не теряем сырой смысл в providerStatus

  return { status, providerStatus: registryStatus, summary: title };
};

const mapPatentResponse = (data: any): { status: CheckStatus; providerStatus: string | null; summary: string | null } => {
  const item = data?.results?.foreign_patent?.result?.data?.[0];
  const docStatus: string | null = item?.doc_status ?? null;
  const normalized = (docStatus || '').toLowerCase();

  // TODO: уточнить точные строки doc_status на первом реальном ответе.
  let status: CheckStatus;
  if (!docStatus) status = 'error';
  else if (normalized.includes('действ') || normalized.includes('оформлен')) status = 'clean';
  else if (normalized.includes('не найден') || normalized.includes('не действ') || normalized.includes('аннул')) status = 'invalid';
  else status = 'found'; // неизвестная формулировка — показываем как есть в summary

  return { status, providerStatus: docStatus, summary: docStatus };
};

// ─── Валидация + вызовы ─────────────────────────────────────────────────────

/** Пометить request_sent=true РОВНО перед внешним вызовом (аудит переживает обрыв). */
const markSent = async (checkId: string): Promise<void> => {
  await execute(`UPDATE newdb_checks SET request_sent = true WHERE id = $1::uuid`, [checkId]);
};

const runRkl = async (pass: IPassDataRow, taskId: string, checkId: string): Promise<ICheckOutcome> => {
  const { lastName, firstName, secondName } = splitFullName(pass.holder_name);
  const { seria, number } = splitDocSeriaNumber(pass.passport_series_number);
  const dob = toDdMmYyyy(pass.birth_date);
  const issueDate = toDdMmYyyy(pass.passport_issue_date);

  const missing: string[] = [];
  if (!lastName || !firstName) missing.push('ФИО');
  if (!dob) missing.push('дата рождения');
  if (!number) missing.push('номер паспорта');
  if (!issueDate) missing.push('дата выдачи паспорта');
  if (missing.length) {
    return { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestSent: false, errorMessage: `Недостаточно данных для РКЛ: ${missing.join(', ')}` };
  }

  const body = {
    params: {
      method: 'rkl',
      country: 'ru',
      lastname: lastName,
      firstname: firstName,
      secondname: secondName,
      dob_info: dob,
      issue_date: issueDate,
      id_doc_seria: seria,
      id_doc_number: number,
      taskId,
    },
  };

  await markSent(checkId);
  const data = await newdbBaseService.post<any>(body);
  const mapped = mapRklResponse(data);
  return {
    status: mapped.status,
    providerStatus: mapped.providerStatus,
    summary: mapped.summary,
    raw: data,
    qid: data?.params?.params?.newdb_qid ?? data?.params?.newdb_qid ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    errorMessage: null,
    requestSent: true,
  };
};

// taskId в теле патента не участвует (API использует requestId); принимаем для
// единообразия сигнатуры с runRkl — он пишется в newdb_task_id снаружи.
const runPatent = async (pass: IPassDataRow, _taskId: string, checkId: string): Promise<ICheckOutcome> => {
  // Патент не требуется: гражданство РФ / есть ВНЖ / непатентное гражданство.
  if (!citizenshipRequiresPatent(pass.citizenship)) {
    return { status: 'not_applicable', providerStatus: null, summary: 'Патент не требуется: гражданство РФ или непатентное', raw: null, qid: null, balance: null, requestSent: false, errorMessage: null };
  }
  if (pass.has_residence_permit) {
    return { status: 'not_applicable', providerStatus: null, summary: 'Патент не требуется: указан ВНЖ', raw: null, qid: null, balance: null, requestSent: false, errorMessage: null };
  }

  const { lastName, firstName, secondName } = splitFullName(pass.holder_name);
  const id = splitDocSeriaNumber(pass.passport_series_number);
  const doc = splitDocSeriaNumber(pass.patent_number);
  const blank = splitDocSeriaNumber(pass.patent_blank_number);
  const dob = toYyyyMmDd(pass.birth_date);

  const missing: string[] = [];
  if (!lastName || !firstName) missing.push('ФИО');
  if (!dob) missing.push('дата рождения');
  if (!id.number) missing.push('паспорт');
  if (!blank.number) missing.push('бланк патента');
  if (missing.length) {
    return { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestSent: false, errorMessage: `Недостаточно данных для патента: ${missing.join(', ')}` };
  }

  const body = {
    params: {
      method: 'foreign_patent',
      doctype: 'patent',
      firstname: firstName,
      lastname: lastName,
      secondname: secondName,
      doc_seria: doc.seria,
      doc_number: doc.number,
      id_doc_seria: id.seria,
      id_doc_number: id.number,
      blank_seria: blank.seria,
      blank_number: blank.number,
      dob,
      country: 'ru',
    },
  };

  await markSent(checkId);
  const data = await newdbBaseService.post<any>(body);
  const mapped = mapPatentResponse(data);
  return {
    status: mapped.status,
    providerStatus: mapped.providerStatus,
    summary: mapped.summary,
    raw: data,
    qid: data?.params?.newdb_qid ?? null,
    balance: typeof data?.balance === 'number' ? data.balance : null,
    errorMessage: null,
    requestSent: true,
  };
};

// ─── Публичное API сервиса ──────────────────────────────────────────────────

export interface INewdbCheckResult {
  id: string;
  check_type: CheckType;
  status: CheckStatus;
  request_sent: boolean;
  provider_status: string | null;
  result_summary: string | null;
  error_message: string | null;
  balance: number | null;
  created_at: string;
}

const getPassData = async (passId: string): Promise<IPassDataRow | null> =>
  queryOne<IPassDataRow>(
    `SELECT p.id,
            p.org_department_id,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            to_char(p.birth_date, 'YYYY-MM-DD') AS birth_date,
            p.passport_series_number,
            to_char(p.passport_issue_date, 'YYYY-MM-DD') AS passport_issue_date,
            p.citizenship,
            p.patent_number,
            p.patent_blank_number,
            p.has_residence_permit,
            p.residence_permit_number
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.id = $1::uuid`,
    [passId],
  );

/** Есть ли недавняя ОТПРАВЛЕННАЯ проверка (анти-даблклик по платным запросам). */
const hasRecentSentCheck = async (passId: string, type: CheckType): Promise<boolean> => {
  const row = await queryOne<{ created_at: string }>(
    `SELECT created_at FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid AND check_type = $2 AND request_sent = true
      ORDER BY created_at DESC LIMIT 1`,
    [passId, type],
  );
  if (!row) return false;
  return Date.now() - new Date(row.created_at).getTime() < ANTI_DOUBLE_WINDOW_MS;
};

/**
 * Запустить проверки для одного пропуска. Жизненный цикл записи:
 * INSERT (request_sent=false) → валидация/вызов → UPDATE результата.
 */
export const runChecksForPass = async (
  passId: string,
  types: CheckType[],
  userId: string,
): Promise<INewdbCheckResult[]> => {
  const pass = await getPassData(passId);
  if (!pass) throw new NewdbApiError('Пропуск не найден', 404);

  const results: INewdbCheckResult[] = [];

  for (const type of types) {
    if (await hasRecentSentCheck(passId, type)) {
      throw new NewdbApiError(`Проверка ${type} уже запускалась только что — подождите`, 429);
    }

    // 1. INSERT снимок ПД, request_sent=false
    const inserted = await queryOne<{ id: string; created_at: string }>(
      `INSERT INTO newdb_checks
         (created_by, check_type, subject_kind, contractor_pass_id, org_department_id,
          full_name, birth_date, passport_series_number, patent_number, citizenship, status)
       VALUES ($1::uuid, $2, 'contractor_pass', $3::uuid, $4::uuid,
               $5, NULLIF($6,'')::date, $7, $8, $9, 'error')
       RETURNING id, created_at`,
      [userId, type, passId, pass.org_department_id, pass.holder_name,
        pass.birth_date, pass.passport_series_number, pass.patent_number, pass.citizenship],
    );
    if (!inserted) throw new NewdbApiError('Не удалось создать запись проверки', 500);
    const checkId = inserted.id;
    const taskId = `${checkId}-${type}`;

    let outcome: ICheckOutcome;
    try {
      // Валидация внутри run; при успехе run сам метит request_sent=true
      // (markSent) ровно перед внешним вызовом — обрыв остаётся в аудите.
      const run = type === 'rkl' ? runRkl : runPatent;
      outcome = await run(pass, taskId, checkId);
    } catch (error) {
      // markSent (если дошли до вызова) уже выставил request_sent=true в БД;
      // если упали до вызова (напр. токен не задан) — там false. Не трогаем
      // request_sent в UPDATE, читаем фактическое значение через RETURNING.
      const apiErr = error instanceof NewdbApiError ? error : new NewdbApiError(error instanceof Error ? error.message : String(error), 0);
      outcome = { status: 'error', providerStatus: null, summary: null, raw: null, qid: null, balance: null, requestSent: false, errorMessage: `Ошибка newdb (${apiErr.status}): ${apiErr.message}` };
    }

    // 3. UPDATE результата (request_sent не трогаем — им владеет markSent)
    const updated = await queryOne<{ request_sent: boolean }>(
      `UPDATE newdb_checks
          SET status = $2, newdb_task_id = $3,
              provider_status = $4, result_summary = $5, raw_response = $6::jsonb,
              newdb_qid = $7, balance = $8, error_message = $9
        WHERE id = $1::uuid
      RETURNING request_sent`,
      [checkId, outcome.status, taskId, outcome.providerStatus,
        outcome.summary, outcome.raw != null ? JSON.stringify(outcome.raw) : null,
        outcome.qid, outcome.balance, outcome.errorMessage],
    );

    results.push({
      id: checkId,
      check_type: type,
      status: outcome.status,
      request_sent: updated?.request_sent ?? false,
      provider_status: outcome.providerStatus,
      result_summary: outcome.summary,
      error_message: outcome.errorMessage,
      balance: outcome.balance,
      created_at: inserted.created_at,
    });
  }

  return results;
};

export const BULK_LIMIT = 15;

export interface IBulkItemResult {
  passId: string;
  results?: INewdbCheckResult[];
  error?: string;
}

/**
 * Массовый прогон: серверная валидация passIds (не доверяем фронту),
 * последовательное выполнение (платно + rate-limit), ошибка одного пропуска
 * не роняет остальные. Лимит BULK_LIMIT против HTTP-таймаута.
 */
export const runChecksBulk = async (
  passIds: string[],
  types: CheckType[],
  userId: string,
): Promise<{ items: IBulkItemResult[]; skipped: string[] }> => {
  const unique = [...new Set(passIds)];
  if (unique.length > BULK_LIMIT) {
    throw new NewdbApiError(`Слишком много пропусков за раз (макс ${BULK_LIMIT}). Сузьте выбор.`, 400);
  }

  // Валидируем на сервере: существуют, не revoked, есть ФИО.
  const valid = await query<{ id: string }>(
    `SELECT p.id
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.id = ANY($1::uuid[])
        AND p.status <> 'revoked'
        AND NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL`,
    [unique],
  );
  const validIds = new Set(valid.map(r => r.id));
  const skipped = unique.filter(id => !validIds.has(id));

  const items: IBulkItemResult[] = [];
  for (const passId of unique) {
    if (!validIds.has(passId)) continue;
    try {
      const results = await runChecksForPass(passId, types, userId);
      items.push({ passId, results });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      items.push({ passId, error: msg });
    }
  }

  return { items, skipped };
};

interface IPassListRow {
  id: string;
  pass_number: string;
  holder_name: string | null;
  citizenship: string | null;
  passport_series_number: string | null;
  patent_number: string | null;
  has_residence_permit: boolean | null;
  last_rkl_status: CheckStatus | null;
  last_rkl_at: string | null;
  last_rkl_summary: string | null;
  last_patent_status: CheckStatus | null;
  last_patent_at: string | null;
  last_patent_summary: string | null;
}

/** Пропуска отдела (со вложенными subtree) + раздельные последние статусы. */
export const listPassesForDepartment = async (orgDepartmentId: string): Promise<IPassListRow[]> =>
  query<IPassListRow>(
    `WITH subtree AS (
       SELECT id FROM public.get_descendant_department_ids(ARRAY[$1::uuid])
     )
     SELECT p.id,
            p.pass_number,
            COALESCE(h.holder_name, p.holder_name) AS holder_name,
            p.citizenship,
            p.passport_series_number,
            p.patent_number,
            p.has_residence_permit,
            rkl.status  AS last_rkl_status,
            rkl.created_at AS last_rkl_at,
            rkl.result_summary AS last_rkl_summary,
            pat.status  AS last_patent_status,
            pat.created_at AS last_patent_at,
            pat.result_summary AS last_patent_summary
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
       LEFT JOIN LATERAL (
         SELECT status, created_at, result_summary FROM newdb_checks c
          WHERE c.contractor_pass_id = p.id AND c.check_type = 'rkl'
          ORDER BY c.created_at DESC LIMIT 1
       ) rkl ON true
       LEFT JOIN LATERAL (
         SELECT status, created_at, result_summary FROM newdb_checks c
          WHERE c.contractor_pass_id = p.id AND c.check_type = 'patent'
          ORDER BY c.created_at DESC LIMIT 1
       ) pat ON true
      WHERE p.org_department_id IN (SELECT id FROM subtree)
        AND p.status <> 'revoked'
        AND NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
      ORDER BY p.pass_number ASC`,
    [orgDepartmentId],
  );

export interface IContractorOrg {
  id: string;
  name: string;
  with_fio: number;
  total: number;
}

/**
 * Подрядные организации с ≥1 сотрудником с ФИО (для селектора вкладки «Проверки»).
 * Скоуп — ветка «Подрядные организации» (get_descendant_department_ids от неё);
 * если узел не найден — фолбэк на все org с contractor_passes (не отдать пусто).
 */
export const listContractorOrgs = async (): Promise<IContractorOrg[]> =>
  query<IContractorOrg>(
    `WITH contractor_root AS (
       SELECT id FROM public.org_departments
        WHERE name = 'Подрядные организации' AND parent_id IS NOT NULL
        LIMIT 1
     ),
     scope AS (
       SELECT id FROM public.get_descendant_department_ids(
         ARRAY(SELECT id FROM contractor_root)::uuid[]
       )
     )
     SELECT od.id, od.name,
            count(DISTINCT p.id) FILTER (
              WHERE NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
            )::int AS with_fio,
            count(DISTINCT p.id)::int AS total
       FROM contractor_passes p
       JOIN org_departments od ON od.id = p.org_department_id
       LEFT JOIN contractor_pass_holders h ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.status <> 'revoked'
        AND (
          NOT EXISTS (SELECT 1 FROM contractor_root)   -- фолбэк: узел не найден
          OR p.org_department_id IN (SELECT id FROM scope)
        )
      GROUP BY od.id, od.name
     HAVING count(DISTINCT p.id) FILTER (
              WHERE NULLIF(trim(COALESCE(h.holder_name, p.holder_name)), '') IS NOT NULL
            ) > 0
      ORDER BY with_fio DESC, od.name ASC`,
  );

/** История проверок пропуска (без raw_response). */
export const getResultsForPass = async (passId: string): Promise<INewdbCheckResult[]> =>
  query<INewdbCheckResult>(
    `SELECT id, check_type, status, request_sent, provider_status,
            result_summary, error_message, balance, created_at
       FROM newdb_checks
      WHERE contractor_pass_id = $1::uuid
      ORDER BY created_at DESC LIMIT 100`,
    [passId],
  );

/** Сырой ответ одной проверки (ПДн — только edit-доступ). */
export const getRawResponse = async (checkId: string): Promise<unknown | null> => {
  const row = await queryOne<{ raw_response: unknown }>(
    `SELECT raw_response FROM newdb_checks WHERE id = $1::uuid`,
    [checkId],
  );
  return row?.raw_response ?? null;
};
