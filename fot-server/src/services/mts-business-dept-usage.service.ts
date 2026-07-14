import { query } from '../config/postgres.js';
import {
  groupOfCategorySql,
  USAGE_GROUP_ORDER,
  type IUsageGroupTotal,
  type UsageGroupKey,
} from './mts-business-statement-rows.service.js';

// Использование связи по сотрудникам отдела — вкладка «МТС» на дашборде
// руководителя. Отдельный сервис (а не метод в statement-rows): там всё считается
// на ОДИН msisdn_hash, здесь — на набор номеров с группировкой по сотруднику.

/**
 * Группа использования БЕЗ денег. Начисления (₽) руководителю отдела не
 * показываем, поэтому `amount` вырезан на уровне типа: попытка отдать его
 * наружу — ошибка компиляции, а не недосмотр ревью.
 */
export type IUsageGroupUsage = Omit<IUsageGroupTotal, 'amount'>;

export interface IDeptEmployeeUsage {
  employeeId: number;
  fullName: string;
  tabNumber: string | null;
  /** Всегда 4 группы в порядке USAGE_GROUP_ORDER (отсутствующие — нулями). */
  groups: IUsageGroupUsage[];
}

export interface IDeptUsageResult {
  totals: IUsageGroupUsage[];
  employees: IDeptEmployeeUsage[];
  /** Сколько сотрудников отдела вообще имеют SIM — знаменатель KPI. */
  employeesWithSim: number;
  /**
   * Когда последний раз подтягивали строки выписки по этому отделу
   * (MAX(synced_at) строк периода) — подпись «данные на …». Без неё руководитель
   * решит, что трафика не было, хотя выписку за текущий месяц просто не докачали.
   * Считаем по statement_rows, а не по number_map.statement_synced_at: та колонка
   * появляется только в миграции 220, которая на проде ещё не применена.
   */
  syncedAt: string | null;
}

const emptyUsageGroup = (key: UsageGroupKey): IUsageGroupUsage => ({
  key, count: 0, seconds: 0, bytes: 0, inCount: 0, inSeconds: 0, outCount: 0, outSeconds: 0,
});

interface IUsageAggRow {
  employee_id: string;
  full_name: string;
  tab_number: string | null;
  grp: string;
  count: string;
  seconds: string;
  bytes: string;
  in_count: string;
  in_seconds: string;
  out_count: string;
  out_seconds: string;
  last_sync: string | Date | null;
}

class MtsBusinessDeptUsageService {
  /**
   * Сводка использования за период по сотрудникам отдела.
   * Цепочка: строки выписки → номер → сотрудник → отдел.
   *
   * INNER JOIN сознательный: непривязанные номера (employee_id IS NULL) и номера
   * сотрудников других отделов в выборку не попадают — руководитель видит только
   * трафик своих людей. Номера (msisdn_enc) и собеседники (peer_enc) не читаются
   * вовсе, `amount` не выбирается — деньги на дашборде не показываем.
   *
   * @param deptIds отдел + все дочерние (collectDeptIds)
   * @param allowedEmployeeIds сужение объектного view-скоупа; null — без сужения
   */
  async getDepartmentUsageByEmployee(
    deptIds: string[],
    dateFrom: string,
    dateTo: string,
    allowedEmployeeIds: number[] | null,
  ): Promise<IDeptUsageResult> {
    const empty: IDeptUsageResult = {
      totals: USAGE_GROUP_ORDER.map(emptyUsageGroup),
      employees: [],
      employeesWithSim: 0,
      syncedAt: null,
    };
    if (deptIds.length === 0) return empty;

    const [usageRows, simRows] = await Promise.all([
      query<IUsageAggRow>(
        `SELECT e.id::text AS employee_id,
                e.full_name,
                e.tab_number,
                ${groupOfCategorySql('r.category')} AS grp,
                COUNT(*)::text AS count,
                COALESCE(SUM(r.units) FILTER (WHERE r.unit_code = 'SECOND'), 0)::text AS seconds,
                COALESCE(SUM(r.units) FILTER (WHERE r.unit_code = 'BYTE'), 0)::text   AS bytes,
                COUNT(*) FILTER (WHERE r.direction = 'in')::text  AS in_count,
                COALESCE(SUM(r.units) FILTER (WHERE r.direction = 'in'  AND r.unit_code = 'SECOND'), 0)::text AS in_seconds,
                COUNT(*) FILTER (WHERE r.direction = 'out')::text AS out_count,
                COALESCE(SUM(r.units) FILTER (WHERE r.direction = 'out' AND r.unit_code = 'SECOND'), 0)::text AS out_seconds,
                MAX(r.synced_at) AS last_sync
           FROM mts_business_statement_rows r
           JOIN mts_business_number_map m ON m.msisdn_hash = r.msisdn_hash
           JOIN employees e               ON e.id = m.employee_id
          WHERE e.org_department_id = ANY($1::uuid[])
            AND e.is_archived = false
            AND e.employment_status = 'active'
            AND r.usage_date BETWEEN $2::date AND $3::date
            AND ($4::bigint[] IS NULL OR e.id = ANY($4::bigint[]))
          GROUP BY 1, 2, 3, 4`,
        [deptIds, dateFrom, dateTo, allowedEmployeeIds],
      ),
      query<{ employees_with_sim: string }>(
        `SELECT COUNT(DISTINCT e.id)::text AS employees_with_sim
           FROM mts_business_number_map m
           JOIN employees e ON e.id = m.employee_id
          WHERE e.org_department_id = ANY($1::uuid[])
            AND e.is_archived = false
            AND e.employment_status = 'active'
            AND ($2::bigint[] IS NULL OR e.id = ANY($2::bigint[]))`,
        [deptIds, allowedEmployeeIds],
      ),
    ]);

    // Раскладка «сотрудник × группа» → сотрудник с полным набором из 4 групп,
    // параллельно суммируем итог по отделу.
    const byEmployee = new Map<number, IDeptEmployeeUsage>();
    const totals = new Map<UsageGroupKey, IUsageGroupUsage>(
      USAGE_GROUP_ORDER.map(k => [k, emptyUsageGroup(k)]),
    );
    let lastSync = 0;

    for (const r of usageRows) {
      if (r.last_sync != null) {
        lastSync = Math.max(lastSync, new Date(r.last_sync).getTime());
      }
      const employeeId = Number(r.employee_id);
      let employee = byEmployee.get(employeeId);
      if (!employee) {
        employee = {
          employeeId,
          fullName: r.full_name,
          tabNumber: r.tab_number,
          groups: USAGE_GROUP_ORDER.map(emptyUsageGroup),
        };
        byEmployee.set(employeeId, employee);
      }
      const key = r.grp as UsageGroupKey;
      const group = employee.groups.find(g => g.key === key);
      const total = totals.get(key);
      if (!group || !total) continue;

      // У сотрудника может быть несколько номеров — их строки складываем.
      const add = (target: IUsageGroupUsage): void => {
        target.count += Number(r.count);
        target.seconds += Number(r.seconds);
        target.bytes += Number(r.bytes);
        target.inCount += Number(r.in_count);
        target.inSeconds += Number(r.in_seconds);
        target.outCount += Number(r.out_count);
        target.outSeconds += Number(r.out_seconds);
      };
      add(group);
      add(total);
    }

    const sim = simRows[0];
    return {
      totals: USAGE_GROUP_ORDER.map(k => totals.get(k) ?? emptyUsageGroup(k)),
      employees: [...byEmployee.values()],
      employeesWithSim: sim ? Number(sim.employees_with_sim) : 0,
      syncedAt: lastSync > 0 ? new Date(lastSync).toISOString() : null,
    };
  }
}

export const mtsBusinessDeptUsageService = new MtsBusinessDeptUsageService();
