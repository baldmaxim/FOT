import { query, type DbExecutor } from '../config/postgres.js';
import { notificationService, type ICreateNotification, type INotification } from './notification.service.js';
import { pushService } from './push.service.js';
import { emitDomainChange } from './realtime-broadcast.service.js';
import { listVisibleApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import {
  countPendingDecisionsForApproval,
  type IPendingApprovalRef,
} from './timesheet-pending-decisions.service.js';
import { formatTimesheetRangeLabel } from './timesheet-range.service.js';
import { listTimesheetWorkflowRecipientIds } from './timesheet-workflow-recipients.service.js';

/**
 * Переход поданного табеля «ждёт согласования выходных» → «готов к утверждению».
 *
 * Каждая мутация, меняющая нерешённые выходные (решение дня, заявление «Работа в
 * выходной»), идёт одной транзакцией под месячными advisory-локами вызывающего:
 * затронутые поданные табели FOR UPDATE → число нерешённых «до» → мутация → «после» →
 * уведомление о переходе до > 0 && после = 0 пишется в той же транзакции. Поэтому
 * повтор запроса, гонка двух последних решений и цикл «готов → новое заявление →
 * снова готов» дают ровно одно уведомление на каждый реальный переход. Realtime и
 * push — после коммита, best effort.
 */

const MAX_DEPARTMENT_DEPTH = 32;
const READY_NOTIFICATION_TYPE = 'timesheet_approval_ready';
const READY_TITLE = 'Табель готов к утверждению';

/** Сотрудник и любая дата месяца, в котором меняются его нерешённые выходные. */
export interface ITrackedEmployeeMonth {
  employeeId: number;
  workDate: string;
}

export interface IAffectedApproval extends IPendingApprovalRef {
  submitted_by: string | null;
}

interface IReadyPush {
  recipients: string[];
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export interface IPendingDecisionEffects {
  affected: IAffectedApproval[];
  notifications: INotification[];
  pushes: IReadyPush[];
}

export const NO_PENDING_DECISION_EFFECTS: IPendingDecisionEffects = Object.freeze({
  affected: [],
  notifications: [],
  pushes: [],
}) as IPendingDecisionEffects;

function monthBounds(workDate: string): { start: string; end: string } {
  const year = Number(workDate.slice(0, 4));
  const month = Number(workDate.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { start: `${year}-${mm}-01`, end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * ВСЕ поданные табели (включая временно открытые), в чей состав может входить сотрудник
 * в этом месяце: персональные — по снимку, отделовые — по отделу сотрудника и его
 * предкам (текущий отдел, назначения, отдел увольнения). Надмножество скоупа
 * listPendingDecisionFacts: лишний табель лишь пересчитается, пропущенный потерял бы
 * переход. Строки блокируются FOR UPDATE по id — порядок общий для всех мутаций.
 */
export async function lockAffectedSubmittedApprovals(
  exec: DbExecutor,
  employeeMonths: readonly ITrackedEmployeeMonth[],
): Promise<IAffectedApproval[]> {
  const pairs = new Map<string, { employeeId: number; start: string; end: string }>();
  for (const item of employeeMonths) {
    const employeeId = Number(item.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0 || !/^\d{4}-\d{2}/.test(String(item.workDate))) continue;
    const bounds = monthBounds(String(item.workDate));
    pairs.set(`${employeeId}|${bounds.start}`, { employeeId, ...bounds });
  }
  if (pairs.size === 0) return [];
  const list = [...pairs.values()];

  const result = await exec.query<{
    id: number | string;
    department_id: string | null;
    manager_employee_id: number | string | null;
    start_date: string;
    end_date: string;
    submitted_by: string | null;
  }>(
    `WITH RECURSIVE p AS (
       SELECT DISTINCT u.employee_id, u.m_start, u.m_end
         FROM unnest($1::int[], $2::date[], $3::date[]) AS u(employee_id, m_start, m_end)
     ),
     emp_depts AS (
       SELECT ea.employee_id, ea.org_department_id AS dept_id
         FROM employee_assignments ea
        WHERE ea.employee_id IN (SELECT employee_id FROM p)
          AND ea.org_department_id IS NOT NULL
       UNION
       SELECT de.employee_id, de.from_department_id
         FROM employee_dismissal_events de
        WHERE de.employee_id IN (SELECT employee_id FROM p)
          AND de.from_department_id IS NOT NULL
          AND de.cancelled = false
       UNION
       SELECT e.id, e.org_department_id
         FROM employees e
        WHERE e.id IN (SELECT employee_id FROM p)
          AND e.org_department_id IS NOT NULL
     ),
     chain AS (
       SELECT ed.employee_id, d.id AS dept_id, d.parent_id, 1 AS depth
         FROM emp_depts ed
         JOIN org_departments d ON d.id = ed.dept_id
       UNION
       SELECT c.employee_id, d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     ),
     candidates AS (
       SELECT a.id
         FROM p
         JOIN timesheet_approvals a
           ON a.status = 'submitted'
          AND a.start_date <= p.m_end
          AND a.end_date >= p.m_start
        WHERE EXISTS (
                SELECT 1 FROM timesheet_approval_employees s
                 WHERE s.approval_id = a.id AND s.employee_id = p.employee_id
              )
           OR (a.department_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM chain c
                 WHERE c.employee_id = p.employee_id AND c.dept_id = a.department_id
              ))
     )
     SELECT a.id, a.department_id, a.manager_employee_id,
            a.start_date::text AS start_date, a.end_date::text AS end_date, a.submitted_by
       FROM timesheet_approvals a
      WHERE a.id IN (SELECT id FROM candidates)
        AND a.status = 'submitted'
      ORDER BY a.id
        FOR UPDATE OF a`,
    [list.map(p => p.employeeId), list.map(p => p.start), list.map(p => p.end)],
  );

  return result.rows.map(row => ({
    id: Number(row.id),
    department_id: row.department_id ?? null,
    manager_employee_id: row.manager_employee_id == null ? null : Number(row.manager_employee_id),
    start_date: String(row.start_date).slice(0, 10),
    end_date: String(row.end_date).slice(0, 10),
    submitted_by: row.submitted_by ?? null,
  }));
}

/**
 * Получатели «Табели HR» по подаче: отделовая — по её отделу; персональная — по отделам
 * сотрудников видимого снимка (department_id у неё NULL).
 */
async function listApprovalHrRecipientIds(
  approval: IAffectedApproval,
  exec?: DbExecutor,
): Promise<string[]> {
  let departmentIds: string[];
  if (approval.department_id) {
    departmentIds = [approval.department_id];
  } else {
    const snapshot = await listVisibleApprovalEmployees(approval, exec);
    const employeeIds = snapshot.map(row => Number(row.employee_id));
    if (employeeIds.length === 0) return [];
    const sql = `SELECT DISTINCT org_department_id FROM employees
                  WHERE id = ANY($1::int[]) AND org_department_id IS NOT NULL`;
    const rows = exec
      ? (await exec.query<{ org_department_id: string }>(sql, [employeeIds])).rows
      : await query<{ org_department_id: string }>(sql, [employeeIds]);
    departmentIds = rows.map(row => String(row.org_department_id));
  }
  const lists = await Promise.all(
    departmentIds.map(departmentId => listTimesheetWorkflowRecipientIds(departmentId, ['review', 'monitor'])),
  );
  return [...new Set(lists.flat())];
}

async function buildReadyText(approval: IAffectedApproval, exec: DbExecutor): Promise<string> {
  const rangeLabel = formatTimesheetRangeLabel(approval.start_date, approval.end_date);
  if (approval.manager_employee_id != null) {
    const row = (await exec.query<{ full_name: string | null }>(
      'SELECT full_name FROM employees WHERE id = $1',
      [approval.manager_employee_id],
    )).rows[0];
    return `Персональная подача (${row?.full_name || 'руководитель'}): табель за ${rangeLabel} — выходные согласованы, можно утверждать.`;
  }
  const row = (await exec.query<{ name: string | null }>(
    'SELECT name FROM org_departments WHERE id = $1',
    [approval.department_id],
  )).rows[0];
  return `Отдел ${row?.name || approval.department_id}: табель за ${rangeLabel} — выходные согласованы, можно утверждать.`;
}

async function insertReadyNotifications(
  exec: DbExecutor,
  ready: IAffectedApproval[],
): Promise<Pick<IPendingDecisionEffects, 'notifications' | 'pushes'>> {
  const items: ICreateNotification[] = [];
  const pushes: IReadyPush[] = [];
  for (const approval of ready) {
    const recipients = await listApprovalHrRecipientIds(approval, exec);
    if (recipients.length === 0) continue;
    const body = await buildReadyText(approval, exec);
    const path = `/timesheet-hr?from=${approval.start_date}&to=${approval.end_date}`;
    const metadata = {
      approvalId: approval.id,
      departmentId: approval.department_id,
      managerEmployeeId: approval.manager_employee_id,
      start_date: approval.start_date,
      end_date: approval.end_date,
      path,
    };
    for (const userId of recipients) {
      items.push({ userId, type: READY_NOTIFICATION_TYPE, title: READY_TITLE, body, metadata });
    }
    // tag только схлопывает push в шторке; идемпотентность обеспечивает переход в транзакции.
    pushes.push({
      recipients,
      title: READY_TITLE,
      body,
      data: { path, start_date: approval.start_date, end_date: approval.end_date, tag: `timesheet-ready:${approval.id}` },
    });
  }
  const notifications = await notificationService.insertManyTx(exec, items);
  return { notifications, pushes };
}

/**
 * Обёртка мутации — см. комментарий модуля. Вызывать ВНУТРИ транзакции, уже под
 * месячными advisory-локами затронутых сотрудников и ДО проверки замка периода: строки
 * табелей блокируются первыми, поэтому параллельное HR-утверждение либо закончится до
 * проверки замка (и та его увидит), либо дождётся коммита мутации.
 *
 * mutate возвращает changed = false, если ничего не записала (уже обработано, замок) —
 * тогда ни «после», ни уведомлений.
 */
export async function withPendingDecisionTracking<T>(
  exec: DbExecutor,
  employeeMonths: readonly ITrackedEmployeeMonth[],
  mutate: () => Promise<{ value: T; changed: boolean }>,
): Promise<{ value: T; effects: IPendingDecisionEffects }> {
  const affected = await lockAffectedSubmittedApprovals(exec, employeeMonths);
  const before = new Map<number, number>();
  for (const approval of affected) {
    before.set(approval.id, await countPendingDecisionsForApproval(approval, exec));
  }

  const { value, changed } = await mutate();
  if (!changed || affected.length === 0) return { value, effects: NO_PENDING_DECISION_EFFECTS };

  // HR-утверждение идёт в REPEATABLE READ и блокирует строку табеля FOR UPDATE: без
  // записи в неё оно дождалось бы нашего коммита со старым снимком и не увидело бы новое
  // заявление. Новая версия строки даёт ему 40001 → повтор со свежим снимком.
  await exec.query(
    'UPDATE timesheet_approvals SET updated_at = updated_at WHERE id = ANY($1::bigint[])',
    [affected.map(approval => approval.id)],
  );

  const ready: IAffectedApproval[] = [];
  for (const approval of affected) {
    if ((before.get(approval.id) ?? 0) === 0) continue;
    if (await countPendingDecisionsForApproval(approval, exec) === 0) ready.push(approval);
  }
  const { notifications, pushes } = await insertReadyNotifications(exec, ready);
  return { value, effects: { affected, notifications, pushes } };
}

/** После коммита: realtime подавшему и кадрам, socket и push по уведомлениям «готов». */
export async function publishPendingDecisionEffects(effects: IPendingDecisionEffects): Promise<void> {
  try {
    for (const approval of effects.affected) {
      const recipients = new Set(await listApprovalHrRecipientIds(approval));
      if (approval.submitted_by) recipients.add(approval.submitted_by);
      if (recipients.size === 0) continue;
      emitDomainChange({
        event: 'timesheet_approval:changed',
        targetUserIds: [...recipients],
        payload: { entityId: approval.id, action: 'pending_decisions' },
      });
    }
    await notificationService.emitInserted(effects.notifications);
    for (const push of effects.pushes) {
      await pushService.sendGenericNotification(push.recipients, push.title, push.body, push.data);
    }
  } catch (err) {
    console.error('[timesheet-pending-decisions] publish effects error:', err);
  }
}
