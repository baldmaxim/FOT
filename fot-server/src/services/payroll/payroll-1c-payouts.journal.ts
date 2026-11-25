/**
 * Журнал ведомостей выплаты 1С (миграции 328, 366, 367, 379): все ведомости за месяцы, как в 1С, и состав одной
 * ведомости. В ведомости суммы всего штата организации, поэтому журнал — только при охвате всего штата (проверка —
 * canViewPayouts1cJournal в контроллере). Ведомость, отменённая в 1С (распроведена или удалена), остаётся в журнале без
 * строк с состоянием «cancelled».
 *
 * Объём: до ~400 ведомостей и ~5 тыс. строк за месяц (прод 25.11.2026) — журнал отдаёт все ведомости выбранных месяцев
 * с ФИО их строк; поиск по № и ФИО, фильтры по столбцам и выгрузка — на экране.
 */
import { query, queryOne } from '../../config/postgres.js';
import { PAYOUT_LINE_MONTH_SQL } from './payroll-1c-payouts.parser.js';
import type { PayoutResolution } from './payroll-1c-payouts.service.js';

export type PayoutOrigin = 'api' | 'file' | 'register' | 'generator' | 'brigade_sheet' | 'to_pay';
export type PayoutJournalState = 'active' | 'cancelled';

/** Сентябрь 2026 (самый тяжёлый, ведомости бригад) — 419 ведомостей и ~360 КБ JSON: за 6 месяцев — до ~2,5 МБ и ~2,5 тыс. строк. */
export const PAYOUT_JOURNAL_MAX_MONTHS = 6;

/** Ведомость журнала. Деньги — строками NUMERIC. */
export interface IPayoutJournalDoc {
  id: number;
  doc_number: string;
  zup2_number: string | null;
  doc_date: string;
  /** Период регистрации ведомости, YYYY-MM. */
  period_month: string;
  organization_inn: string;
  payment_method: string;
  /** Сумма по документу 1С (шапка). */
  total_amount: string;
  /** Сумма строк в ФОТ; у отменённой — 0. */
  lines_amount: string;
  lines: number;
  employees: number;
  unmatched_lines: number;
  unmatched_amount: string;
  comment: string | null;
  origin: PayoutOrigin;
  state: PayoutJournalState;
  /** Версия 1С у ведомостей из API. */
  version: string | null;
  updated_at: string;
}

/** Ведомость в списке журнала: ещё ФИО строк (1С и сотрудника ФОТ) через « · » — для поиска на экране. */
export interface IPayoutJournalListDoc extends IPayoutJournalDoc {
  names: string;
}

export interface IPayoutJournalLine {
  line_no: number;
  /** Месяц начисления строки YYYY-MM (у ведомости бригады строку переносят в другой месяц, миграция 367). */
  month: string;
  full_name_1c: string;
  amount: string;
  basis: string | null;
  employee_id: number | null;
  employee_name: string | null;
  resolution: PayoutResolution;
  resolution_reason: string | null;
  id_fot_1c: number | null;
}

const JOURNAL_SELECT = `d.id, d.doc_number, d.zup2_number, d.doc_date::text AS doc_date,
       to_char(d.period_month, 'YYYY-MM') AS period_month, d.organization_inn, d.payment_method,
       d.total_amount::text AS total_amount,
       COALESCE(agg.lines_amount, 0)::text AS lines_amount, COALESCE(agg.lines, 0)::int AS lines,
       COALESCE(agg.employees, 0)::int AS employees, COALESCE(agg.unmatched_lines, 0)::int AS unmatched_lines,
       COALESCE(agg.unmatched_amount, 0)::text AS unmatched_amount,
       d.comment, d.origin,
       CASE WHEN st.state = 'cancelled' THEN 'cancelled' ELSE 'active' END AS state,
       st.version::text AS version, d.updated_at::text AS updated_at`;
const JOURNAL_FROM = `payroll_1c_payout_documents d
  LEFT JOIN LATERAL (
    SELECT sum(l.amount) AS lines_amount, count(*) AS lines, count(DISTINCT l.employee_id) AS employees,
           count(*) FILTER (WHERE l.employee_id IS NULL) AS unmatched_lines,
           sum(l.amount) FILTER (WHERE l.employee_id IS NULL) AS unmatched_amount
      FROM payroll_1c_payout_lines l
     WHERE l.document_id = d.id
  ) agg ON true
  LEFT JOIN payroll_1c_payout_api_states st ON st.document_id = d.id`;

const toDoc = (row: IPayoutJournalDoc): IPayoutJournalDoc => ({ ...row, id: Number(row.id) });

/**
 * Ведомости за месяцы months (YYYY-MM): период регистрации ведомости или месяц одной из её строк — в months.
 * Новые сверху: дата, затем id.
 */
export const listPayoutJournal = async (months: readonly string[]): Promise<IPayoutJournalListDoc[]> => {
  if (months.length === 0) return [];
  const rows = await query<IPayoutJournalListDoc>(
    `SELECT ${JOURNAL_SELECT}, nm.names
       FROM ${JOURNAL_FROM}
       LEFT JOIN LATERAL (
         SELECT COALESCE(string_agg(DISTINCT v.name, ' · '), '') AS names
           FROM payroll_1c_payout_lines nl
           LEFT JOIN employees ne ON ne.id = nl.employee_id
          CROSS JOIN LATERAL (VALUES (nl.full_name_1c), (ne.full_name)) AS v(name)
          WHERE nl.document_id = d.id AND v.name IS NOT NULL
       ) nm ON true
      WHERE d.period_month = ANY($1::date[])
         OR EXISTS (SELECT 1 FROM payroll_1c_payout_lines ml WHERE ml.document_id = d.id AND ml.period_month = ANY($1::date[]))
      ORDER BY d.doc_date DESC, d.id DESC`,
    [months.map(month => `${month}-01`)],
  );
  return rows.map(row => ({ ...toDoc(row), names: row.names }));
};

/** Ведомость и её строки по порядку 1С; null — нет такой. */
export const getPayoutJournalDoc = async (
  documentId: number,
): Promise<{ document: IPayoutJournalDoc; lines: IPayoutJournalLine[] } | null> => {
  const document = await queryOne<IPayoutJournalDoc>(`SELECT ${JOURNAL_SELECT} FROM ${JOURNAL_FROM} WHERE d.id = $1`, [documentId]);
  if (!document) return null;
  const lines = await query<IPayoutJournalLine>(
    `SELECT l.line_no, to_char(${PAYOUT_LINE_MONTH_SQL}, 'YYYY-MM') AS month, l.full_name_1c, l.amount::text AS amount,
            l.basis, l.employee_id, e.full_name AS employee_name, l.resolution, l.resolution_reason, l.id_fot_1c
       FROM payroll_1c_payout_lines l
       JOIN payroll_1c_payout_documents d ON d.id = l.document_id
       LEFT JOIN employees e ON e.id = l.employee_id
      WHERE l.document_id = $1
      ORDER BY l.line_no`,
    [documentId],
  );
  return { document: toDoc(document), lines };
};
