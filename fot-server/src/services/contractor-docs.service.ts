/**
 * Доменная логика документов держателя подрядного пропуска (паспорт/патент).
 * Нормализация номеров, проверка полноты, поиск дубля внутри организации.
 * Используется в save/submit (contractor.controller) и в детекторе дублей
 * админских заявок (contractor-admin.controller).
 */
import type { PoolClient } from 'pg';
import { z } from 'zod';

/** Коды ошибок документов (отдаются клиенту для готового toast). */
export const CONTRACTOR_DOCUMENT_DUPLICATE = 'CONTRACTOR_DOCUMENT_DUPLICATE';
export const CONTRACTOR_DOCUMENTS_INCOMPLETE = 'CONTRACTOR_DOCUMENTS_INCOMPLETE';

/**
 * Гражданства (UPPER), которым нужен патент (визово-безвизовые не-ЕАЭС).
 * Тот же набор, что PATENT_COUNTRY_PREFIXES в patent-missing-receipts.service,
 * и продублирован в SQL `documents_complete` (contractor-admin.controller) и
 * на фронте (fot-app/src/services/citizenship.ts) — держать в синхроне.
 */
export const CITIZENSHIP_PATENT_SET = new Set([
  'УЗБЕКИСТАН',
  'ТАДЖИКИСТАН',
  'УКРАИНА',
  'АЗЕРБАЙДЖАН',
  'МОЛДОВА',
  'ТУРКМЕНИСТАН',
]);

/** Нужен ли патент гражданину с данным гражданством (регистронезависимо). */
export const citizenshipRequiresPatent = (c: string | null | undefined): boolean =>
  !!c && CITIZENSHIP_PATENT_SET.has(c.trim().toUpperCase());

/**
 * Нужен ли фактически комплект патентных полей: гражданство патентное И нет ВНЖ.
 * ВНЖ (вид на жительство) отменяет требование патента — вместо него нужен номер ВНЖ.
 */
export const needsPatentDoc = (row: Partial<IDocRow> | null | undefined): boolean =>
  !!row && citizenshipRequiresPatent(row.citizenship) && !row.has_residence_permit;

/** Базовые поля комплекта (нужны всегда, независимо от гражданства). */
export const BASE_DOC_FIELDS = [
  'passport_series_number',
  'passport_issue_date',
  'birth_date',
  'citizenship',
] as const;

/** Поля патента — обязательны только для патентных гражданств без ВНЖ. */
export const PATENT_DOC_FIELDS = [
  'patent_number',
  'patent_issue_date',
  'patent_blank_number',
] as const;

/** Поля ВНЖ — заменяют патент для патентных гражданств с ВНЖ. */
export const RESIDENCE_DOC_FIELDS = ['residence_permit_number'] as const;

export type DocField =
  | (typeof BASE_DOC_FIELDS)[number]
  | (typeof PATENT_DOC_FIELDS)[number]
  | (typeof RESIDENCE_DOC_FIELDS)[number];

export interface IDocRow {
  passport_series_number: string | null;
  passport_issue_date: string | null;
  birth_date: string | null;
  citizenship: string | null;
  patent_number: string | null;
  patent_issue_date: string | null;
  patent_blank_number: string | null;
  has_residence_permit?: boolean;
  residence_permit_number?: string | null;
}

/**
 * Нормализация номера документа для сравнения: убрать пробелы/№/пунктуацию,
 * привести к нижнему регистру. Пустой результат → null.
 */
export const normalizeDocNumber = (v: string | null | undefined): string | null => {
  const s = (v ?? '').replace(/[^0-9A-Za-zА-Яа-яЁё]/g, '').toLowerCase();
  return s.length > 0 ? s : null;
};

/** SQL-выражение нормализации (то же правило, что и normalizeDocNumber). */
export const normalizeDocSql = (col: string): string =>
  `NULLIF(lower(regexp_replace(coalesce(${col},''), '[^0-9A-Za-zА-Яа-яЁё]', '', 'g')), '')`;

/**
 * Комплект полный: базовые поля заполнены всегда. Для патентных гражданств —
 * либо патент (три поля), либо ВНЖ (номер ВНЖ). ЕАЭС/«Другое» — только базовые.
 */
export const isDocsComplete = (row: Partial<IDocRow> | null | undefined): boolean => {
  if (!row) return false;
  let fields: readonly DocField[];
  if (!citizenshipRequiresPatent(row.citizenship)) {
    fields = BASE_DOC_FIELDS;
  } else if (row.has_residence_permit) {
    fields = [...BASE_DOC_FIELDS, ...RESIDENCE_DOC_FIELDS];
  } else {
    fields = [...BASE_DOC_FIELDS, ...PATENT_DOC_FIELDS];
  }
  return fields.every(f => {
    const v = (row as Record<string, unknown>)[f];
    return typeof v === 'string' ? v.trim().length > 0 : v != null;
  });
};

export interface IDocDuplicate {
  field: 'patent' | 'passport';
  holder_name: string | null;
  pass_number: string;
}

/**
 * Поиск дубля паспорта/патента внутри организации (под транзакционной блокировкой).
 * Сравнение по нормализованным номерам, среди неотозванных пропусков, кроме самого passId.
 * Возвращает первый конфликт (приоритет — патент) или null.
 */
export const findOrgDocDuplicate = async (
  client: PoolClient,
  params: {
    orgId: string;
    passId: string;
    patentNumber: string | null;
    passportNumber: string | null;
  },
): Promise<IDocDuplicate | null> => {
  const normPatent = normalizeDocNumber(params.patentNumber);
  const normPassport = normalizeDocNumber(params.passportNumber);
  if (!normPatent && !normPassport) return null;

  const res = await client.query<{ field: 'patent' | 'passport'; holder_name: string | null; pass_number: string }>(
    `SELECT
        CASE WHEN $3::text IS NOT NULL AND ${normalizeDocSql('p.patent_number')} = $3::text
             THEN 'patent' ELSE 'passport' END AS field,
        COALESCE(h.holder_name, p.holder_name) AS holder_name,
        p.pass_number
       FROM contractor_passes p
       LEFT JOIN contractor_pass_holders h
         ON h.pass_id = p.id AND h.valid_until IS NULL
      WHERE p.org_department_id = $1::uuid
        AND p.status <> 'revoked'
        AND p.id <> $2::uuid
        AND (
          ($3::text IS NOT NULL AND ${normalizeDocSql('p.patent_number')} = $3::text)
          OR ($4::text IS NOT NULL AND ${normalizeDocSql('p.passport_series_number')} = $4::text)
        )
      ORDER BY (CASE WHEN $3::text IS NOT NULL AND ${normalizeDocSql('p.patent_number')} = $3::text THEN 0 ELSE 1 END),
               p.pass_number
      LIMIT 1`,
    [params.orgId, params.passId, normPatent, normPassport],
  );
  return res.rows[0] ?? null;
};

/** Текст ошибки дубля для пользователя. */
export const duplicateMessage = (dup: IDocDuplicate): string => {
  const who = dup.holder_name?.trim() || 'другой держатель';
  const what = dup.field === 'patent' ? 'Номер патента' : 'Номер паспорта';
  return `${what} уже указан у ${who} (пропуск №${dup.pass_number})`;
};

// ------------------------------------------------------------------
// Разбор/нормализация тела запроса сохранения документов.
// Общая точка для подрядного savePassDocuments и админского
// updatePassDocumentsAdmin — чтобы правила не разъезжались.
// ------------------------------------------------------------------

const docsDateField = z.preprocess(
  v => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
);

export const docsBodySchema = z.object({
  passport_series_number: z.string().trim().max(50).nullable().optional(),
  passport_issue_date: docsDateField,
  birth_date: docsDateField,
  citizenship: z.string().trim().max(50).nullable().optional(),
  patent_number: z.string().trim().max(50).nullable().optional(),
  patent_issue_date: docsDateField,
  patent_blank_number: z.string().trim().max(50).nullable().optional(),
  has_residence_permit: z.boolean().optional(),
  residence_permit_number: z.string().trim().max(50).nullable().optional(),
});

export type IDocsBody = z.infer<typeof docsBodySchema>;

/** Полный нормализованный комплект документов (то, что пишется в contractor_passes). */
export interface IDocPayload extends IDocRow {
  has_residence_permit: boolean;
  residence_permit_number: string | null;
}

/**
 * Нормализация разобранного тела: trim→null; ВНЖ имеет смысл только для
 * патентной страны; патент и ВНЖ взаимоисключающие (при ВНЖ поля патента
 * обнуляются, иначе — номер ВНЖ), чтобы не копились устаревшие значения.
 */
export const normalizeDocsPayload = (parsed: IDocsBody): IDocPayload => {
  const norm = (v: string | null | undefined): string | null => {
    const s = (v ?? '').trim();
    return s.length > 0 ? s : null;
  };
  const citizenship = norm(parsed.citizenship);
  const effHasVnzh = citizenshipRequiresPatent(citizenship) && !!parsed.has_residence_permit;
  return {
    passport_series_number: norm(parsed.passport_series_number),
    passport_issue_date: parsed.passport_issue_date ?? null,
    birth_date: parsed.birth_date ?? null,
    citizenship,
    patent_number: effHasVnzh ? null : norm(parsed.patent_number),
    patent_issue_date: effHasVnzh ? null : (parsed.patent_issue_date ?? null),
    patent_blank_number: effHasVnzh ? null : norm(parsed.patent_blank_number),
    has_residence_permit: effHasVnzh,
    residence_permit_number: effHasVnzh ? norm(parsed.residence_permit_number) : null,
  };
};

// ------------------------------------------------------------------
// История изменений документов (contractor_pass_document_history).
// ------------------------------------------------------------------

/** Все поля комплекта, участвующие в diff/снапшоте истории. */
export const DOC_HISTORY_FIELDS = [
  ...BASE_DOC_FIELDS,
  ...PATENT_DOC_FIELDS,
  'has_residence_permit',
  'residence_permit_number',
] as const;

export type DocHistoryField = (typeof DOC_HISTORY_FIELDS)[number];

/** Строка пропуска с текущими документами — вход recordDocHistoryIfChanged. */
export interface IDocHistoryPass extends IDocPayload {
  id: string;
  pass_number: string;
  org_department_id: string | null;
  holder_name: string | null;
}

export type DocHistorySource = 'admin' | 'contractor' | 'clear_holder';

/** Дата из pg (Date | ISO-строка) → 'YYYY-MM-DD' для сравнения. */
const comparableDate = (v: unknown): string | null => {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'string' && v.trim().length > 0) return v.slice(0, 10);
  return null;
};

const DATE_FIELDS: ReadonlySet<string> = new Set(['passport_issue_date', 'birth_date', 'patent_issue_date']);

const comparable = (field: DocHistoryField, v: unknown): string | boolean | null => {
  if (field === 'has_residence_permit') return !!v;
  if (DATE_FIELDS.has(field)) return comparableDate(v);
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  return s.length > 0 ? s : null;
};

/**
 * Diff prev/next по полям комплекта и снапшот ПРЕЖНИХ значений в
 * contractor_pass_document_history, если что-то изменилось.
 * Первичное заполнение с нуля (все prev-поля пустые) историю не создаёт.
 * changed_by_name берётся подзапросом из user_profiles (в req.user ФИО нет).
 * Возвращает список изменённых полей ([] — записи не было и изменений нет).
 */
export const recordDocHistoryIfChanged = async (
  client: PoolClient,
  pass: IDocHistoryPass,
  next: IDocPayload,
  actor: { userId: string | null; source: DocHistorySource },
): Promise<DocHistoryField[]> => {
  const prevRec = pass as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;
  const changed = DOC_HISTORY_FIELDS.filter(f => comparable(f, prevRec[f]) !== comparable(f, nextRec[f]));
  if (changed.length === 0) return [];

  const prevHasData = DOC_HISTORY_FIELDS.some(f => {
    const v = comparable(f, prevRec[f]);
    return f === 'has_residence_permit' ? v === true : v !== null;
  });
  if (!prevHasData) return changed;

  await client.query(
    `INSERT INTO contractor_pass_document_history (
        pass_id, pass_number, org_department_id, holder_name,
        passport_series_number, passport_issue_date, birth_date, citizenship,
        patent_number, patent_issue_date, patent_blank_number,
        has_residence_permit, residence_permit_number,
        changed_fields, changed_by, changed_by_name, changed_source
     ) VALUES (
        $1::uuid, $2, $3::uuid, $4,
        $5, $6::date, $7::date, $8,
        $9, $10::date, $11, $12, $13,
        $14::text[], $15::uuid,
        (SELECT full_name FROM user_profiles WHERE id = $15::uuid), $16
     )`,
    [
      pass.id,
      pass.pass_number,
      pass.org_department_id,
      pass.holder_name,
      pass.passport_series_number,
      comparableDate(pass.passport_issue_date),
      comparableDate(pass.birth_date),
      pass.citizenship,
      pass.patent_number,
      comparableDate(pass.patent_issue_date),
      pass.patent_blank_number,
      !!pass.has_residence_permit,
      pass.residence_permit_number ?? null,
      changed,
      actor.userId,
      actor.source,
    ],
  );
  return changed;
};
