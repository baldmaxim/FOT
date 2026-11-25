import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';

/**
 * Ведомости выплаты из 1С (миграции 328, 379): загрузка файлом с предпросмотром, ведомости сотрудника и журнал всех
 * ведомостей. Суммы — «Выплаты на карту (1С)» «Расчётов», из «Суммы» вычитаются в «Остаток к выплате».
 */

/** Откуда ведомость: по API из 1С, файлом («Загрузить из 1С»), из регистра ЗУП, генератором, ведомостью бригады, «ЗП к выплате» ЗУП2. */
export type PayoutOrigin = 'api' | 'file' | 'register' | 'generator' | 'brigade_sheet' | 'to_pay';

/**
 * Перечисленное сотруднику по ведомости: месяц — месяц начисления (не дата перечисления). Одна ведомость за месяц —
 * одна строка (строки сотрудника в ней сложены).
 */
export interface IEmployeePayout1c {
  month: string;
  document_id: number;
  /** Номер ведомости ЗУП3. */
  doc_number: string;
  zup2_number: string | null;
  /** Дата ведомости YYYY-MM-DD. */
  doc_date: string;
  payment_method: string;
  /** NUMERIC строкой. */
  amount: string;
  organization_inn: string;
  origin: PayoutOrigin;
  /** «Комментарий» ведомости 1С. */
  comment: string | null;
  /** «Основание» строк сотрудника («Отпуск 16.11–29.11»), разные — через «; ». */
  basis: string | null;
}

/** Ведомость журнала «Ведомости 1С». Деньги — NUMERIC строкой. */
export interface IPayoutJournalDoc {
  id: number;
  doc_number: string;
  zup2_number: string | null;
  doc_date: string;
  /** Период регистрации, YYYY-MM. */
  period_month: string;
  organization_inn: string;
  payment_method: string;
  /** Сумма по документу 1С. */
  total_amount: string;
  /** Сумма строк в ФОТ; у отменённой — 0. */
  lines_amount: string;
  lines: number;
  employees: number;
  unmatched_lines: number;
  unmatched_amount: string;
  comment: string | null;
  origin: PayoutOrigin;
  /** cancelled — распроведена или удалена в 1С: строк нет, суммы не учитываются. */
  state: 'active' | 'cancelled';
  version: string | null;
  updated_at: string;
}

/** В списке журнала — ещё ФИО строк через « · » (поиск). */
export interface IPayoutJournalListDoc extends IPayoutJournalDoc {
  names: string;
}

export interface IPayoutJournalLine {
  line_no: number;
  /** Месяц начисления строки YYYY-MM. */
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

export interface IPayoutsCapability {
  can_import: boolean;
  /** Журнал «Ведомости 1С» — весь штат. */
  can_view_journal: boolean;
}

export interface IPayoutCandidate {
  employee_id: number;
  full_name: string;
  department: string | null;
  worked_in_month: boolean;
  by_id_all: boolean;
  brigade_match: boolean;
}

export type PayoutResolution = 'auto_id_fot' | 'auto_id_all' | 'confirmed' | 'unmatched';
export type PayoutPreviewStatus = 'new' | 'unchanged' | 'enrich' | 'changed';
export type PayoutImportAction = 'new' | 'replace' | 'enrich' | 'relink' | 'unchanged';

export interface IPayoutPreviewLine {
  fingerprint: string;
  line_no: number;
  full_name: string;
  brigade: string | null;
  amount: string;
  auto_employee_id: number | null;
  current_employee_id: number | null;
  current_resolution: PayoutResolution | null;
  candidates: IPayoutCandidate[];
}

export interface IPayoutPreview {
  format: 'zup2' | 'external';
  document: {
    doc_guid: string;
    doc_number: string;
    zup2_number: string | null;
    doc_date: string;
    period_month: string;
    payment_method: string;
    salary_project: string | null;
    total_amount: string;
  };
  status: PayoutPreviewStatus;
  expected_revision: number;
  incoming_content_hash: string;
  changes: { header: Array<{ field: string; before: string | null; after: string | null }>; added: string[]; removed: string[] } | null;
  enrich_fields: string[];
  lines: IPayoutPreviewLine[];
}

export interface IPayoutImportResult {
  action: PayoutImportAction;
  document_id: number | null;
  revision: number;
  lines_matched: number;
  lines_unmatched: number;
}

interface IApiResponse<T> { success: boolean; data: T }

export const PAYOUTS_1C_KEYS = {
  capability: ['payroll-1c-payouts', 'capability'] as const,
  months: ['payroll-1c-payouts', 'months'] as const,
  journal: (months: readonly string[]) => ['payroll-1c-payouts', 'journal', months.join(',')] as const,
  journalDoc: (id: number) => ['payroll-1c-payouts', 'journal-doc', id] as const,
  employee: (employeeId: number, from: string, to: string) => ['payroll-1c-payouts', 'employee', employeeId, from, to] as const,
};

const fileForm = (file: File): FormData => {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
};

export const payroll1cPayoutsService = {
  /** Видна ли кнопка «Загрузить из 1С» — та же проверка, что у загрузки. */
  capability: async (signal?: AbortSignal): Promise<IPayoutsCapability> =>
    (await apiClient.get<IApiResponse<IPayoutsCapability>>('/payroll/1c-payouts/capability', { signal })).data,

  /** Журнал ведомостей за месяцы (YYYY-MM), новые сверху. */
  journal: async (months: readonly string[], signal?: AbortSignal): Promise<IPayoutJournalListDoc[]> => {
    const search = new URLSearchParams({ months: months.join(',') });
    return (await apiClient.get<IApiResponse<IPayoutJournalListDoc[]>>(`/payroll/1c-payouts/documents?${search.toString()}`, { signal })).data;
  },

  /** Ведомость журнала и её строки. */
  journalDoc: async (id: number, signal?: AbortSignal): Promise<{ document: IPayoutJournalDoc; lines: IPayoutJournalLine[] }> =>
    (await apiClient.get<IApiResponse<{ document: IPayoutJournalDoc; lines: IPayoutJournalLine[] }>>(
      `/payroll/1c-payouts/documents/${id}`,
      { signal },
    )).data,

  /** xlsx журнала ровно как на экране. */
  exportJournal: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/payroll/1c-payouts/documents/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),

  /** Месяцы ведомостей в банк у штата в охвате (YYYY-MM, по возрастанию) — для выбора месяцев «Расчётов». */
  months: async (signal?: AbortSignal): Promise<string[]> =>
    (await apiClient.get<IApiResponse<string[]>>('/payroll/1c-payouts/months', { signal })).data,

  preview: async (file: File): Promise<IPayoutPreview> => {
    const res = await apiClient.post<IApiResponse<IPayoutPreview>>('/payroll/1c-payouts/preview', fileForm(file));
    return res.data;
  },

  /** choices: fingerprint строки → сотрудник; null — «Без сотрудника». */
  importFile: async (file: File, params: {
    preview: IPayoutPreview;
    confirmReplace: boolean;
    choices: Record<string, number | null>;
  }): Promise<IPayoutImportResult> => {
    const form = fileForm(file);
    form.append('incoming_content_hash', params.preview.incoming_content_hash);
    form.append('expected_revision', String(params.preview.expected_revision));
    form.append('confirm_replace', params.confirmReplace ? 'true' : 'false');
    form.append('choices', JSON.stringify(params.choices));
    const res = await apiClient.post<IApiResponse<IPayoutImportResult>>('/payroll/1c-payouts/import', form);
    return res.data;
  },

  /** Перечисленное сотруднику за месяцы начисления from — to (YYYY-MM). */
  getByEmployee: async (employeeId: number, from: string, to: string, signal?: AbortSignal): Promise<IEmployeePayout1c[]> => {
    const search = new URLSearchParams({ from, to });
    const res = await apiClient.get<IApiResponse<IEmployeePayout1c[]>>(
      `/payroll/terms/employee/${employeeId}/payouts-1c?${search.toString()}`,
      { signal },
    );
    return res.data;
  },
};
