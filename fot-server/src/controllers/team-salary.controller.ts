/**
 * Столбец «Зарплата» в табеле руководителя (миграция 382). Гард requireTeamSalaryAccess уже проверил галочку, отделы
 * руководителя и страницу табеля; здесь — отдел из охвата, месяц и расчёт в очереди «Зарплаты».
 *
 * Месяц в запросе не принимается: сервер сам берёт прошлый (resolveReleasedSalaryMonth), другие месяцы не получить.
 * Месяц определяется уже в слоте очереди, а server_now — в момент ответа: если ответ ушёл после полуночи 10-го, фронт
 * увидит истёкший next_from и запросит заново, не показывая сумм.
 */
import type { Response } from 'express';
import { z } from 'zod';

import type { AuthenticatedRequest } from '../types/index.js';
import { payrollQueueServerTiming, runInPayrollCalcSlot } from '../services/payroll/payroll-calc-slot.js';
import {
  getRequestTeamSalaryDepartmentIds,
  resolveReleasedSalaryMonth,
} from '../services/payroll/team-salary-access.service.js';
import {
  calcTeamSalaryRows,
  loadTeamSalaryMembers,
  TEAM_SALARY_MAX_EMPLOYEES,
  type TeamSalaryRow,
} from '../services/payroll/team-salary.service.js';

const querySchema = z.object({ department_id: z.string().uuid() });

type TeamSalaryWork =
  | { kind: 'ok'; month: string; next_from: string; rows: TeamSalaryRow[] }
  | { kind: 'too_many'; count: number };

/** GET /api/payroll/team-salary?department_id — к выплате за прошлый месяц людей отдела из охвата руководителя. */
const get = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Некорректный отдел', code: 'INVALID_DEPARTMENT' });
      return;
    }
    const departmentId = parsed.data.department_id;
    const scope = await getRequestTeamSalaryDepartmentIds(req);
    if (!scope.includes(departmentId)) {
      res.status(403).json({
        success: false,
        error: 'Отдел вне охвата зарплаты руководителя',
        code: 'TEAM_SALARY_OUT_OF_SCOPE',
      });
      return;
    }

    // Столбец — последним в очереди: ждущие «Свод» и «Расчёты» идут раньше; уже идущий расчёт очередь не прерывает.
    const slot = await runInPayrollCalcSlot<TeamSalaryWork>(req, res, 'low', async () => {
      const { month, next_from } = resolveReleasedSalaryMonth(new Date());
      const memberIds = await loadTeamSalaryMembers(departmentId, month);
      if (memberIds.length > TEAM_SALARY_MAX_EMPLOYEES) return { kind: 'too_many', count: memberIds.length };
      return { kind: 'ok', month, next_from, rows: await calcTeamSalaryRows(memberIds, month, req) };
    });
    if (slot.status === 'aborted') return;
    res.setHeader('Server-Timing', payrollQueueServerTiming('low', slot));
    const work = slot.result;
    if (work.kind === 'too_many') {
      res.status(422).json({
        success: false,
        error: `В отделе ${work.count} человек — больше ${TEAM_SALARY_MAX_EMPLOYEES}, выберите подотдел`,
        code: 'TEAM_SALARY_TOO_MANY',
      });
      return;
    }
    res.json({
      success: true,
      data: { month: work.month, next_from: work.next_from, server_now: new Date().toISOString(), rows: work.rows },
    });
  } catch (err) {
    console.error('teamSalary.get error:', err);
    res.status(500).json({ success: false, error: 'Ошибка расчёта зарплаты' });
  }
};

export const teamSalaryController = { get };
