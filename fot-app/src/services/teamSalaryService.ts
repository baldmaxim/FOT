import { apiClient } from '../api/client';
import type { IPayrollCalcNotClosed, PayrollCalcCountedView, PayrollCalcMissing } from './payrollService';

interface IApiResponse<T> { success: boolean; data: T }

/** Расшифровка «Расчёт ФОТ» строки столбца — урезанный закрытый расчёт (без условий оплаты и служебных полей). */
export type TeamSalaryCalc = Extract<PayrollCalcCountedView, { state: 'closed' }>;

export type TeamSalaryNotClosedReason = IPayrollCalcNotClosed['reason'];

/**
 * Строка столбца «Зарплата»: ready — закрытый полный расчёт (сумма и расшифровка); not_ready — закрытый, но неполный
 * (нет отпускных/больничных из 1С, выработки…): сумм нет, только чего не хватает; not_closed — табель или бригада не
 * закрыты, не работал в месяце.
 */
export type TeamSalaryRow =
  | { employee_id: number; status: 'ready'; net: string; calc: TeamSalaryCalc }
  | { employee_id: number; status: 'not_ready'; missing: PayrollCalcMissing[] }
  | { employee_id: number; status: 'not_closed'; reason: TeamSalaryNotClosedReason };

export interface ITeamSalaryResponse {
  /** Месяц столбца, YYYY-MM — всегда прошлый (с 10-го числа МСК). */
  month: string;
  /** Когда столбец перейдёт на следующий месяц — ISO, 00:00 МСК 10-го числа. */
  next_from: string;
  /** Время сервера в момент ответа — для сдвига часов клиента и проверки истёкшего ответа. */
  server_now: string;
  rows: TeamSalaryRow[];
}

/** Столбец «Зарплата» в табеле руководителя (миграция 382): месяц выбирает сервер, только чтение. */
export const teamSalaryService = {
  get: async (departmentId: string, signal?: AbortSignal): Promise<ITeamSalaryResponse> => {
    const params = new URLSearchParams({ department_id: departmentId });
    const res = await apiClient.get<IApiResponse<ITeamSalaryResponse>>(
      `/payroll/team-salary?${params.toString()}`,
      { signal },
    );
    return res.data;
  },
};
