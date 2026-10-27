import { apiClient } from '../api/client';

/**
 * «Перечислено (1С)» (миграция 328): ведомости выплаты из 1С — загрузка с предпросмотром и история сотрудника.
 * Справочно: в расчётах ФОТ не участвует, «К выплате» по-прежнему из «Оплачено».
 */

/** Перечисленное сотруднику по ведомости: месяц — месяц начисления (не дата перечисления). */
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
}

export interface IPayoutCandidate {
  employee_id: number;
  full_name: string;
  department: string | null;
  worked_in_month: boolean;
  by_id_all: boolean;
  brigade_match: boolean;
}

export type PayoutResolution = 'auto_id_all' | 'confirmed' | 'unmatched';
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
};

const fileForm = (file: File): FormData => {
  const form = new FormData();
  form.append('file', file, file.name);
  return form;
};

export const payroll1cPayoutsService = {
  /** Видна ли кнопка «Загрузить из 1С» — та же проверка, что у загрузки. */
  capability: async (signal?: AbortSignal): Promise<boolean> => {
    const res = await apiClient.get<IApiResponse<{ can_import: boolean }>>('/payroll/1c-payouts/capability', { signal });
    return res.data.can_import;
  },

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
