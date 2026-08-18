import { apiClient } from './client';

/**
 * Клиент модуля «KPI закрытия КС-2».
 *
 * Все денежные поля — СТРОКИ: numeric из PostgreSQL приходит строкой, и превращать
 * его в number по дороге нельзя. Считает бэкенд, фронт только показывает.
 */

export type ObjectKpiEntryStatus = 'draft' | 'signed' | 'cancelled';
export type ObjectKpiPlanStatus = 'open' | 'fixed' | 'corrected' | 'data_incomplete';

export interface IObjectKpiReportRow {
  skud_object_id: string;
  object_name: string;
  object_is_active: boolean;
  period_month: string;
  contract_id: string | null;
  contract_number: string | null;
  customer_name: string | null;
  planned_zos_date: string | null;
  actual_zos_date: string | null;
  planned_zos_date_used: string | null;
  control_date: string | null;
  is_overdue: boolean;
  contract_total: string | null;
  ks2_cumulative_before: string | null;
  ks2_cumulative_after: string | null;
  remainder: string | null;
  months_remaining: number | null;
  plan_amount: string | null;
  plan_amount_calc: string | null;
  fact_amount: string;
  fact_acts: string;
  fact_reductions: string;
  completion_pct: string | null;
  plan_source: 'snapshot' | 'calculated';
  plan_overridden: boolean;
  plan_drift: boolean;
  report_status: ObjectKpiPlanStatus;
  data_quality: 'ok' | 'no_active_contract' | 'no_base_amount' | 'no_planned_zos_date';
  over_contract: boolean;
  month_plan_id: string | null;
  managers: Array<{ employee_id: number; full_name: string | null; days: number }>;
  primary_manager_id: number | null;
  primary_manager_name: string | null;
}

export interface IObjectKpiSummary {
  total_plan: number;
  total_fact: number;
  /** Факт месяцев без плана — в total_fact не входит, иначе «Факт / План» не сойдётся. */
  total_fact_unplanned: number;
  completion_pct: number | null;
}

/**
 * Строка отчёта в ЛК — с долей руководителя. Доля считается на сервере: денежная
 * арифметика на фронте запрещена, здесь только показ готовых значений.
 */
export interface IObjectKpiMyRow extends IObjectKpiReportRow {
  my_days: number;
  total_days: number;
  my_share_pct: string | null;
  my_plan_amount: string | null;
  my_fact_amount: string | null;
  included_in_premium: boolean;
  exclusion_reason: 'not_assigned' | 'no_plan' | null;
}

export type PremiumMonthStatus =
  | 'no_scale'
  | 'not_assigned'
  | 'data_incomplete'
  | 'no_plan'
  | 'calculated';

export interface IPremiumMonthObject {
  skud_object_id: string;
  object_name: string;
  my_days: number;
  total_days: number;
  my_share_pct: string | null;
  my_plan_amount: string | null;
  my_fact_amount: string | null;
  included_in_premium: boolean;
  exclusion_reason: 'not_assigned' | 'no_plan' | null;
  data_quality: IObjectKpiReportRow['data_quality'];
}

export interface IPremiumMonth {
  period_month: string;
  status: PremiumMonthStatus;
  total_plan: string | null;
  total_fact: string | null;
  completion_pct: string | null;
  coefficient: string | null;
  interpolation: {
    lower_pct: string | null;
    lower_coef: string | null;
    upper_pct: string | null;
    upper_coef: string | null;
  } | null;
  scale_version_id: string | null;
  base_amount: string | null;
  any_assignment_days: number;
  eligible_assignment_days: number;
  days_in_month: number;
  base_prorated: string | null;
  premium_amount: string | null;
  /** Оклад за месяц, пропорционально дням закрепления. null — оклад не задан. */
  salary_amount: string | null;
  /** Премия + оклад: считает сервер, деньги на фронте не складываем. */
  total_amount: string | null;
  objects: IPremiumMonthObject[];
  incomplete_objects: Array<{ object_name: string; data_quality: IObjectKpiReportRow['data_quality'] }>;
}

export interface IPremiumPeriodTotals {
  total_plan: string;
  total_fact: string;
  completion_pct: string | null;
  total_premium: string;
}

export interface IPremiumScaleVersion {
  id: string;
  valid_from: string;
  base_amount: string;
  max_premium: string | null;
  order_reference: string | null;
  order_url: string | null;
  /** premium_amount = база × коэффициент, посчитано на сервере (деньги на фронте не считаем). */
  points: Array<{ completion_pct: string; coefficient: string; premium_amount: string }>;
}

export interface IMyObjectsResponse {
  data: IObjectKpiMyRow[];
  premium: IPremiumMonth[];
  period_totals: IPremiumPeriodTotals;
  scales: IPremiumScaleVersion[];
}

export interface IObjectKpiHeadcountRow {
  skud_object_id: string;
  period_month: string;
  person_days: number;
  weekend_person_days: number;
  norm_days: number | null;
  avg_headcount: number | null;
}

export interface IObjectKpiObject {
  id: string;
  name: string;
  is_active: boolean;
  contract_id: string | null;
  contract_number: string | null;
  customer_name: string | null;
  base_amount: string | null;
  contract_date: string | null;
  planned_zos_date: string | null;
  actual_zos_date: string | null;
  /** Первый расчётный месяц договора — от него разворачивается «Показать все месяцы». */
  plan_start_month: string | null;
  contract_version: number | null;
}

export interface IReportPremiumRow {
  employee_id: number;
  period_month: string;
  status: PremiumMonthStatus;
  completion_pct: string | null;
  coefficient: string | null;
  premium_amount: string | null;
}

export interface IObjectKpiObjectsResponse {
  data: IObjectKpiObject[];
  /** can_revise_plan — подсказка UI: право пересматривать зафиксированный план. */
  scope: { is_unrestricted: boolean; can_revise_plan: boolean };
}

export interface IObjectContract {
  id: string;
  skud_object_id: string;
  contract_number: string | null;
  contract_date: string | null;
  customer_name: string | null;
  base_amount: string;
  planned_zos_date: string | null;
  actual_zos_date: string | null;
  plan_start_month: string | null;
  planned_headcount: number | null;
  is_active: boolean;
  notes: string | null;
  version: number;
}

export interface IObjectAddendum {
  id: string;
  contract_id: string;
  addendum_number: string;
  addendum_date: string;
  effective_date: string;
  amount_delta: string;
  status: ObjectKpiEntryStatus;
  notes: string | null;
  version: number;
}

export interface IObjectKs2Entry {
  id: string;
  contract_id: string;
  skud_object_id: string;
  entry_kind: 'act' | 'reduction';
  amount: string;
  act_number: string;
  customer_signed_date: string;
  period_month: string;
  status: ObjectKpiEntryStatus;
  /** fact_adjustment — корректировка факта месяца, причина лежит в notes. */
  source: 'manual' | 'fact_adjustment';
  notes: string | null;
  version: number;
}

export interface IObjectKs6Entry {
  id: string;
  contract_id: string;
  skud_object_id: string;
  amount: string;
  doc_number: string;
  customer_signed_date: string;
  period_month: string;
  status: ObjectKpiEntryStatus;
  notes: string | null;
  version: number;
}

export interface IObjectKpiMonthPlan {
  id: string;
  period_month: string;
  revision: number;
  is_current: boolean;
  contract_total: string | null;
  remainder: string | null;
  months_remaining: number | null;
  calculated_plan_amount: string | null;
  override_plan_amount: string | null;
  plan_amount: string | null;
  status: ObjectKpiPlanStatus;
  fixed_at: string | null;
  fixed_source: 'auto' | 'manual' | 'economics_head_override' | null;
  /** Человек, зафиксировавший или пересмотревший план (fixed_source — это источник, не автор). */
  fixed_by_name: string | null;
  correction_reason: string | null;
}

export interface IObjectKpiAssignment {
  id: string;
  skud_object_id: string;
  object_name: string | null;
  employee_id: number;
  employee_name: string | null;
  role_kind: 'construction_manager' | 'object_economist';
  valid_from: string;
  valid_to: string | null;
  source: 'manual' | 'skud_import';
  /**
   * Оклад руководителя строительства за этот объект. Приходит только админу и руководителю
   * эк. отдела, остальным — null (маскирует сервер).
   */
  salary_amount: string | null;
  notes: string | null;
  version: number;
}

export interface IObjectKpiGlobalRole {
  id: string;
  employee_id: number;
  employee_name: string | null;
  role_kind: 'economics_head';
  valid_from: string;
  valid_to: string | null;
  notes: string | null;
}

export interface IObjectKpiHistoryEntry {
  id: string;
  entity_kind: string;
  action: 'create' | 'update' | 'delete';
  changed_fields: string[];
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  reason: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

export interface IObjectKpiCard {
  object_id: string;
  contract: IObjectContract | null;
  addenda: IObjectAddendum[];
  ks2: IObjectKs2Entry[];
  ks6: IObjectKs6Entry[];
  plans: IObjectKpiMonthPlan[];
  assignments: IObjectKpiAssignment[];
  report: IObjectKpiReportRow[];
  /** Окно, за которое собрана карточка (сервер считает его сам, если период не передан). */
  period: IPeriod;
  /**
   * Есть ли у объекта зафиксированные месяцы ВООБЩЕ, а не только в запрошенном окне:
   * от этого зависит, обязательно ли основание правки договора.
   */
  has_fixed_months: boolean;
}

export interface IPeriod {
  from: string;  // YYYY-MM
  to: string;    // YYYY-MM
}

const periodQuery = ({ from, to }: IPeriod): string =>
  `?${new URLSearchParams({ from, to }).toString()}`;

/**
 * Период и объект — оба необязательны. Без периода окно считает сервер: «весь расчёт
 * по объекту до текущего месяца». Границы уходят только парой — сервер отвергает
 * запрос с одной.
 */
const reportQuery = (period?: IPeriod | null, objectId?: string | null): string => {
  const params = new URLSearchParams();
  if (period) {
    params.set('from', period.from);
    params.set('to', period.to);
  }
  if (objectId) params.set('object_id', objectId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

export const objectKpiApi = {
  /** Отдаёт и список, и scope: право на правку плана берётся отсюда же. */
  async listObjects(): Promise<IObjectKpiObjectsResponse> {
    const res = await apiClient.get<IObjectKpiObjectsResponse>('/object-kpi/objects');
    return { data: res.data, scope: res.scope };
  },

  /**
   * objectId сужает выборку на сервере: чужой объект вернёт 403, а не пустой список.
   * Без периода объект обязателен — иначе сервер отдаст 400 (решётка «все объекты × 10 лет»).
   */
  async getReport(
    period: IPeriod | null | undefined,
    objectId?: string | null,
  ): Promise<{ data: IObjectKpiReportRow[]; summary: IObjectKpiSummary; period: IPeriod }> {
    return apiClient.get(`/object-kpi/report${reportQuery(period, objectId)}`);
  },

  /**
   * Премия руководителей по месяцам — вторым запросом к отчёту.
   * Считается совокупно по всем объектам руководителя (п. 3.5), даже если отчёт сужен.
   */
  async getReportPremium(
    period?: IPeriod | null,
    objectId?: string | null,
  ): Promise<{ data: IReportPremiumRow[]; period: IPeriod }> {
    return apiClient.get(`/object-kpi/report/premium${reportQuery(period, objectId)}`);
  },

  /**
   * Только сводка и использованное окно — без строк отчёта.
   * Без периода сервер считает весь расчёт; с периодом — конкретный месяц.
   */
  async getReportSummary(
    period?: IPeriod | null,
    objectId?: string | null,
  ): Promise<{ summary: IObjectKpiSummary; period: IPeriod }> {
    return apiClient.get(`/object-kpi/report/summary${reportQuery(period, objectId)}`);
  },

  async getHeadcount(period: IPeriod): Promise<IObjectKpiHeadcountRow[]> {
    const res = await apiClient.get<{ data: IObjectKpiHeadcountRow[] }>(
      `/object-kpi/report/headcount${periodQuery(period)}`,
    );
    return res.data;
  },

  /** Без периода карточка показывает весь расчёт по объекту — окно считает сервер. */
  async getCard(objectId: string, period?: IPeriod | null): Promise<IObjectKpiCard> {
    const res = await apiClient.get<{ data: IObjectKpiCard }>(
      `/object-kpi/objects/${objectId}/card${period ? periodQuery(period) : ''}`,
    );
    return res.data;
  },

  async getHistory(objectId: string): Promise<IObjectKpiHistoryEntry[]> {
    const res = await apiClient.get<{ data: IObjectKpiHistoryEntry[] }>(
      `/object-kpi/objects/${objectId}/history`,
    );
    return res.data;
  },

  /** ЛК руководителя: свои объекты, доли и предварительный расчёт премии по месяцам. */
  async getMyObjects(period: IPeriod): Promise<IMyObjectsResponse> {
    return apiClient.get(`/object-kpi/my/objects${periodQuery(period)}`);
  },

  async getFixationInfo(month: string): Promise<{
    period_month: string;
    fixation_date: string | null;
    working_day: number;
    freezer_enabled: boolean;
  }> {
    const res = await apiClient.get<{ data: {
      period_month: string; fixation_date: string | null; working_day: number; freezer_enabled: boolean;
    } }>(`/object-kpi/plans/fixation-info?month=${month}`);
    return res.data;
  },

  // ─── Договор ──────────────────────────────────────────────────────────────

  async createContract(objectId: string, payload: Record<string, unknown>): Promise<IObjectContract> {
    const res = await apiClient.post<{ data: IObjectContract }>(
      `/object-kpi/objects/${objectId}/contract`, payload,
    );
    return res.data;
  },

  /** version обязателен: сервер вернёт 409, если запись успели изменить. */
  async updateContract(contractId: string, payload: Record<string, unknown>): Promise<IObjectContract> {
    const res = await apiClient.patch<{ data: IObjectContract }>(
      `/object-kpi/contracts/${contractId}`, payload,
    );
    return res.data;
  },

  // ─── Допсоглашения ────────────────────────────────────────────────────────

  async createAddendum(contractId: string, payload: Record<string, unknown>): Promise<IObjectAddendum> {
    const res = await apiClient.post<{ data: IObjectAddendum }>(
      `/object-kpi/contracts/${contractId}/addenda`, payload,
    );
    return res.data;
  },

  async updateAddendum(id: string, payload: Record<string, unknown>): Promise<IObjectAddendum> {
    const res = await apiClient.patch<{ data: IObjectAddendum }>(`/object-kpi/addenda/${id}`, payload);
    return res.data;
  },

  async signAddendum(id: string, version: number, reason?: string): Promise<IObjectAddendum> {
    const res = await apiClient.post<{ data: IObjectAddendum }>(
      `/object-kpi/addenda/${id}/sign`, { version, reason },
    );
    return res.data;
  },

  async cancelAddendum(id: string, version: number, reason?: string): Promise<IObjectAddendum> {
    const res = await apiClient.post<{ data: IObjectAddendum }>(
      `/object-kpi/addenda/${id}/cancel`, { version, reason },
    );
    return res.data;
  },

  async deleteAddendum(id: string, version: number): Promise<void> {
    await apiClient.delete(`/object-kpi/addenda/${id}?version=${version}`);
  },

  // ─── КС-2 ─────────────────────────────────────────────────────────────────

  async createKs2(contractId: string, payload: Record<string, unknown>): Promise<IObjectKs2Entry> {
    const res = await apiClient.post<{ data: IObjectKs2Entry }>(
      `/object-kpi/contracts/${contractId}/ks2`, payload,
    );
    return res.data;
  },

  async updateKs2(id: string, payload: Record<string, unknown>): Promise<IObjectKs2Entry> {
    const res = await apiClient.patch<{ data: IObjectKs2Entry }>(`/object-kpi/ks2/${id}`, payload);
    return res.data;
  },

  async signKs2(id: string, version: number, reason?: string): Promise<IObjectKs2Entry> {
    const res = await apiClient.post<{ data: IObjectKs2Entry }>(
      `/object-kpi/ks2/${id}/sign`, { version, reason },
    );
    return res.data;
  },

  async cancelKs2(id: string, version: number, reason?: string): Promise<IObjectKs2Entry> {
    const res = await apiClient.post<{ data: IObjectKs2Entry }>(
      `/object-kpi/ks2/${id}/cancel`, { version, reason },
    );
    return res.data;
  },

  async deleteKs2(id: string, version: number): Promise<void> {
    await apiClient.delete(`/object-kpi/ks2/${id}?version=${version}`);
  },

  // ─── КС-6 (справочный реестр) ─────────────────────────────────────────────

  async listKs6(contractId: string): Promise<IObjectKs6Entry[]> {
    const res = await apiClient.get<{ data: IObjectKs6Entry[] }>(
      `/object-kpi/contracts/${contractId}/ks6`,
    );
    return res.data;
  },

  async createKs6(contractId: string, payload: Record<string, unknown>): Promise<IObjectKs6Entry> {
    const res = await apiClient.post<{ data: IObjectKs6Entry }>(
      `/object-kpi/contracts/${contractId}/ks6`, payload,
    );
    return res.data;
  },

  async updateKs6(id: string, payload: Record<string, unknown>): Promise<IObjectKs6Entry> {
    const res = await apiClient.patch<{ data: IObjectKs6Entry }>(`/object-kpi/ks6/${id}`, payload);
    return res.data;
  },

  async signKs6(id: string, version: number, reason?: string): Promise<IObjectKs6Entry> {
    const res = await apiClient.post<{ data: IObjectKs6Entry }>(
      `/object-kpi/ks6/${id}/sign`, { version, reason },
    );
    return res.data;
  },

  async cancelKs6(id: string, version: number, reason?: string): Promise<IObjectKs6Entry> {
    const res = await apiClient.post<{ data: IObjectKs6Entry }>(
      `/object-kpi/ks6/${id}/cancel`, { version, reason },
    );
    return res.data;
  },

  async deleteKs6(id: string, version: number): Promise<void> {
    await apiClient.delete(`/object-kpi/ks6/${id}?version=${version}`);
  },

  /**
   * Правка факта месяца: на сервер уходит ЦЕЛЕВАЯ сумма, он сам заводит корректирующий
   * акт КС-2 на разницу. Факт остаётся суммой подписанных актов (п. 3.1).
   */
  async adjustMonthFact(
    objectId: string,
    periodMonth: string,
    payload: { target_amount: string; reason: string },
  ): Promise<IObjectKs2Entry> {
    const res = await apiClient.post<{ data: IObjectKs2Entry }>(
      `/object-kpi/objects/${objectId}/plans/${periodMonth}/fact-adjustment`, payload,
    );
    return res.data;
  },

  // ─── План ─────────────────────────────────────────────────────────────────

  async fixPlan(objectId: string, periodMonth: string): Promise<IObjectKpiMonthPlan> {
    const res = await apiClient.post<{ data: IObjectKpiMonthPlan }>(
      `/object-kpi/objects/${objectId}/plans/${periodMonth}/fix`, {},
    );
    return res.data;
  },

  async revisePlan(
    objectId: string,
    periodMonth: string,
    payload: { reason: string; override_plan_amount?: string | null },
  ): Promise<IObjectKpiMonthPlan> {
    const res = await apiClient.patch<{ data: IObjectKpiMonthPlan }>(
      `/object-kpi/objects/${objectId}/plans/${periodMonth}`, payload,
    );
    return res.data;
  },

  // ─── Закрепления и роли ───────────────────────────────────────────────────

  /** Поиск сотрудника для модалки назначений (свой эндпоинт, без права на /admin/users). */
  async searchEmployees(term: string): Promise<Array<{ id: number; full_name: string | null }>> {
    const res = await apiClient.get<{ data: Array<{ id: number; full_name: string | null }> }>(
      `/object-kpi/employees/search?q=${encodeURIComponent(term)}`,
    );
    return res.data;
  },

  async listAssignments(objectId?: string): Promise<IObjectKpiAssignment[]> {
    const suffix = objectId ? `?object_id=${objectId}` : '';
    const res = await apiClient.get<{ data: IObjectKpiAssignment[] }>(`/object-kpi/assignments${suffix}`);
    return res.data;
  },

  async createAssignment(payload: Record<string, unknown>): Promise<IObjectKpiAssignment> {
    const res = await apiClient.post<{ data: IObjectKpiAssignment }>('/object-kpi/assignments', payload);
    return res.data;
  },

  async updateAssignment(id: string, payload: Record<string, unknown>): Promise<IObjectKpiAssignment> {
    const res = await apiClient.patch<{ data: IObjectKpiAssignment }>(
      `/object-kpi/assignments/${id}`, payload,
    );
    return res.data;
  },

  async deleteAssignment(id: string, version: number): Promise<void> {
    await apiClient.delete(`/object-kpi/assignments/${id}?version=${version}`);
  },

  async listGlobalRoles(): Promise<IObjectKpiGlobalRole[]> {
    const res = await apiClient.get<{ data: IObjectKpiGlobalRole[] }>('/object-kpi/global-roles');
    return res.data;
  },

  /** Выдаёт и снимает роль только админ — на бэкенде стоит requireAdmin. */
  async createGlobalRole(payload: Record<string, unknown>): Promise<IObjectKpiGlobalRole> {
    const res = await apiClient.post<{ data: IObjectKpiGlobalRole }>('/object-kpi/global-roles', payload);
    return res.data;
  },

  async revokeGlobalRole(id: string): Promise<void> {
    await apiClient.delete(`/object-kpi/global-roles/${id}`);
  },
};
