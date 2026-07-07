/**
 * Доменная логика документов держателя подрядного пропуска (паспорт/патент).
 * Нормализация номеров, проверка полноты, поиск дубля внутри организации.
 * Используется в save/submit (contractor.controller) и в детекторе дублей
 * админских заявок (contractor-admin.controller).
 */
import type { PoolClient } from 'pg';

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
