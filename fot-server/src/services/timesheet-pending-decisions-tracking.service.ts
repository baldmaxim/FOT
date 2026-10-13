import { query, type DbExecutor } from '../config/postgres.js';
import { notificationService, type ICreateNotification, type INotification } from './notification.service.js';
import { pushService } from './push.service.js';
import { emitDomainChange } from './realtime-broadcast.service.js';
import { collectDeptIds } from './skud-shared.service.js';
import { listVisibleApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import {
  countPendingDecisionDays,
  countPendingDecisionsForApproval,
  listPendingDecisionFacts,
  type IPendingApprovalRef,
} from './timesheet-pending-decisions.service.js';
import { isRangeWithinCompletedPeriods } from './timesheet-period.service.js';
import { formatTimesheetRangeLabel } from './timesheet-range.service.js';
import {
  listTimesheetWorkflowRecipientIds,
  type WorkflowRecipientKind,
} from './timesheet-workflow-recipients.service.js';

/**
 * Переход табеля «ждёт согласования выходных» → «выходные согласованы», о котором узнают кадры:
 *  - поданный табель → «готов к утверждению»;
 *  - утверждённый, но открытый для правок → «можно закрыть» (закрыть его с нерешёнными
 *    выходными нельзя — решение осталось бы за замком, а часы не дошли бы до 1С);
 *  - неподанный табель завершённого месяца → «можно закрыть»: выгрузка «Единый файл
 *    для 1С» такой табель не закрывает, пока выходные не решены.
 *
 * Каждая мутация, меняющая нерешённые выходные (решение дня, заявление «Работа в
 * выходной»), идёт одной транзакцией под месячными advisory-локами вызывающего:
 * затронутые табели FOR UPDATE → число нерешённых «до» → мутация → «после» →
 * уведомление о переходе до > 0 && после = 0 пишется в той же транзакции. Поэтому
 * повтор запроса, гонка двух последних решений и цикл «готов → новое заявление →
 * снова готов» дают ровно одно уведомление на каждый реальный переход. Realtime и
 * push — после коммита, best effort.
 */

const MAX_DEPARTMENT_DEPTH = 32;
const READY_NOTIFICATION_TYPE = 'timesheet_approval_ready';
const READY_TITLE = 'Табель готов к утверждению';
const CLOSE_READY_NOTIFICATION_TYPE = 'timesheet_close_ready';
const CLOSE_READY_TITLE = 'Табель можно закрыть';
/** «Готов к утверждению» видят и наблюдатели; realtime-обновление статуса — тоже. */
const HR_RECIPIENT_KINDS: WorkflowRecipientKind[] = ['review', 'monitor'];
/** «Можно закрыть» — только тем, кто закрывает: правка «Табели HR» (админ, кадровый админ). */
const CLOSE_RECIPIENT_KINDS: WorkflowRecipientKind[] = ['review'];

/** Сотрудник и любая дата месяца, в котором меняются его нерешённые выходные. */
export interface ITrackedEmployeeMonth {
  employeeId: number;
  workDate: string;
}

export interface IAffectedApproval extends IPendingApprovalRef {
  /** approved — утверждён, но открыт для правок (unlocked_at задан). */
  status: 'submitted' | 'approved';
  submitted_by: string | null;
}

/** Неподанный табель отдела за завершённый месяц. */
export interface IOpenDepartmentMonth {
  department_id: string;
  /** Месяц целиком — в нём считаются нерешённые выходные. */
  month_start: string;
  month_end: string;
  /** Неподанная часть месяца (полупериод или весь месяц) — период в тексте уведомления. */
  start_date: string;
  end_date: string;
  /** Диапазоны уже закрытых табелей месяца: их дни закрытию остального не мешают. */
  closed_ranges: Array<{ start: string; end: string }>;
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

interface IEmployeeMonthBounds {
  employeeId: number;
  start: string;
  end: string;
}

function toEmployeeMonthBounds(employeeMonths: readonly ITrackedEmployeeMonth[]): IEmployeeMonthBounds[] {
  const pairs = new Map<string, IEmployeeMonthBounds>();
  for (const item of employeeMonths) {
    const employeeId = Number(item.employeeId);
    if (!Number.isInteger(employeeId) || employeeId <= 0 || !/^\d{4}-\d{2}/.test(String(item.workDate))) continue;
    const bounds = monthBounds(String(item.workDate));
    pairs.set(`${employeeId}|${bounds.start}`, { employeeId, ...bounds });
  }
  return [...pairs.values()];
}

/**
 * ВСЕ табели, ждущие решения по выходным, в чей состав может входить сотрудник в этом
 * месяце: поданные (включая временно открытые) и утверждённые, открытые для правок.
 * Персональные — по снимку, отделовые — по отделу сотрудника и его предкам (текущий
 * отдел, назначения, отдел увольнения). Надмножество скоупа listPendingDecisionFacts:
 * лишний табель лишь пересчитается, пропущенный потерял бы переход. Строки блокируются
 * FOR UPDATE по id — порядок общий для всех мутаций.
 */
export async function lockAffectedApprovals(
  exec: DbExecutor,
  employeeMonths: readonly ITrackedEmployeeMonth[],
): Promise<IAffectedApproval[]> {
  const list = toEmployeeMonthBounds(employeeMonths);
  if (list.length === 0) return [];

  const result = await exec.query<{
    id: number | string;
    department_id: string | null;
    manager_employee_id: number | string | null;
    start_date: string;
    end_date: string;
    status: IAffectedApproval['status'];
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
           ON (a.status = 'submitted' OR (a.status = 'approved' AND a.unlocked_at IS NOT NULL))
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
            a.start_date::text AS start_date, a.end_date::text AS end_date, a.status, a.submitted_by
       FROM timesheet_approvals a
      WHERE a.id IN (SELECT id FROM candidates)
        AND (a.status = 'submitted' OR (a.status = 'approved' AND a.unlocked_at IS NOT NULL))
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
    status: row.status,
    submitted_by: row.submitted_by ?? null,
  }));
}

/** Нерешённые выходные месяца, кроме дней уже закрытых табелей. */
async function countOpenMonthPending(unit: IOpenDepartmentMonth, exec: DbExecutor): Promise<number> {
  const facts = await listPendingDecisionFacts(
    { kind: 'department', departmentId: unit.department_id },
    { startDate: unit.month_start, endDate: unit.month_end },
    exec,
  );
  const open = (day: { work_date: string }): boolean =>
    !unit.closed_ranges.some(range => day.work_date >= range.start && day.work_date <= range.end);
  return countPendingDecisionDays({ days: facts.days.filter(open), requests: facts.requests.filter(open) });
}

/**
 * Неподанные табели завершённых месяцев, где у отдела сотрудника ЕСТЬ нерешённые выходные:
 * именно их выгрузка «Единый файл для 1С» пропускает с причиной «Ждёт согласования
 * выходных». Правила те же, что у закрытия месяца (closeDepartmentHalf): только отдел
 * без подотделов; полупериод «не подан», если его не пересекает поданная или утверждённая
 * подача отдела, возвращённая подача нестандартного диапазона (её закрывают вручную) и
 * действующая подача вышестоящего отдела.
 *
 * Критерий — месячный: выгрузка и закрытие идут за весь месяц, поэтому «можно закрыть»
 * уходит, когда в месяце не осталось ни одного нерешённого выходного, а не в полупериоде.
 * Месяц должен быть завершён: раньше закрытие недоступно, а выходные, решённые до его
 * конца, закрытию не мешают — сообщать не о чем.
 *
 * Строки подачи здесь нет, блокировать FOR UPDATE нечего — мутации одного отдела за месяц
 * сериализует advisory-лок (отдел, месяц): без него два параллельных «последних» решения
 * по разным сотрудникам не увидели бы друг друга и переход потерялся бы.
 */
async function lockOpenDepartmentMonths(
  exec: DbExecutor,
  employeeMonths: readonly ITrackedEmployeeMonth[],
): Promise<IOpenDepartmentMonth[]> {
  const list = toEmployeeMonthBounds(employeeMonths)
    .filter(item => isRangeWithinCompletedPeriods(item.start, item.end));
  if (list.length === 0) return [];

  // Отделы, в состав которых сотрудник может входить в этом месяце — те же источники, что
  // у listEmployeeMembershipsForDepartmentPeriod: назначения, отдел увольнения, текущий отдел.
  const candidates = (await exec.query<{ department_id: string; m_start: string; m_end: string }>(
    `WITH p AS (
       SELECT DISTINCT u.employee_id, u.m_start, u.m_end
         FROM unnest($1::int[], $2::date[], $3::date[]) AS u(employee_id, m_start, m_end)
     )
     SELECT DISTINCT d.dept_id::text AS department_id, p.m_start::text AS m_start, p.m_end::text AS m_end
       FROM p
       CROSS JOIN LATERAL (
         SELECT ea.org_department_id AS dept_id
           FROM employee_assignments ea
          WHERE ea.employee_id = p.employee_id
            AND ea.org_department_id IS NOT NULL
            AND ea.effective_from <= p.m_end
            AND (ea.effective_to IS NULL OR ea.effective_to >= p.m_start)
         UNION
         SELECT de.from_department_id
           FROM employee_dismissal_events de
          WHERE de.employee_id = p.employee_id
            AND de.from_department_id IS NOT NULL
            AND de.dismissal_date >= p.m_start
            AND de.cancelled = false
         UNION
         SELECT e.org_department_id
           FROM employees e
          WHERE e.id = p.employee_id
            AND e.org_department_id IS NOT NULL
       ) d
      ORDER BY 1, 2`,
    [list.map(p => p.employeeId), list.map(p => p.start), list.map(p => p.end)],
  )).rows;

  const leaves: typeof candidates = [];
  for (const row of candidates) {
    if ((await collectDeptIds(row.department_id)).length === 1) leaves.push(row);
  }
  if (leaves.length === 0) return [];

  // Порядок захвата детерминированный (отдел, месяц) — как у остальных advisory-локов.
  for (const row of leaves) {
    await exec.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `timesheet:open-month:${row.department_id}:${row.m_start.slice(0, 7)}`,
    ]);
  }

  const active = (await exec.query<{
    department_id: string;
    depth: number;
    start_date: string;
    end_date: string;
    status: string;
    locked: boolean;
  }>(
    `WITH RECURSIVE chain AS (
       SELECT d.id AS dept_id, d.id AS node_id, d.parent_id, 1 AS depth
         FROM org_departments d
        WHERE d.id = ANY($1::uuid[])
       UNION
       SELECT c.dept_id, d.id, d.parent_id, c.depth + 1
         FROM chain c
         JOIN org_departments d ON d.id = c.parent_id
        WHERE c.depth < ${MAX_DEPARTMENT_DEPTH}
     )
     SELECT c.dept_id::text AS department_id, c.depth,
            a.start_date::text AS start_date, a.end_date::text AS end_date,
            a.status, (a.unlocked_at IS NULL) AS locked
       FROM chain c
       JOIN timesheet_approvals a ON a.department_id = c.node_id
      WHERE a.manager_employee_id IS NULL
        AND a.status IN ('submitted', 'approved', 'returned')
        AND a.start_date <= $3::date
        AND a.end_date >= $2::date`,
    [
      [...new Set(leaves.map(row => row.department_id))],
      leaves.reduce((min, row) => (row.m_start < min ? row.m_start : min), leaves[0].m_start),
      leaves.reduce((max, row) => (row.m_end > max ? row.m_end : max), leaves[0].m_end),
    ],
  )).rows.map(row => ({
    ...row,
    depth: Number(row.depth),
    start_date: String(row.start_date).slice(0, 10),
    end_date: String(row.end_date).slice(0, 10),
  }));

  const units: IOpenDepartmentMonth[] = [];
  for (const row of leaves) {
    const month = row.m_start.slice(0, 7);
    const inMonth = active.filter(a => a.department_id === row.department_id
      && a.start_date <= row.m_end && a.end_date >= row.m_start);
    const openHalves = [[`${month}-01`, `${month}-15`], [`${month}-16`, row.m_end]]
      .filter(([start, end]) => !inMonth.some(a => a.start_date <= end && a.end_date >= start
        // Своя возвращённая подача, покрывающая полупериод, — «не подан»: её утвердят кадры.
        && (a.depth > 1 || a.status !== 'returned' || !(a.start_date <= start && a.end_date >= end))));
    if (openHalves.length === 0) continue;

    const unit: IOpenDepartmentMonth = {
      department_id: row.department_id,
      month_start: row.m_start,
      month_end: row.m_end,
      start_date: openHalves[0][0],
      end_date: openHalves[openHalves.length - 1][1],
      closed_ranges: inMonth
        .filter(a => a.status === 'approved' && a.locked)
        .map(a => ({ start: a.start_date, end: a.end_date })),
    };
    if (await countOpenMonthPending(unit, exec) > 0) units.push(unit);
  }
  return units;
}

/**
 * Получатели «Табели HR» по подаче: отделовая — по её отделу; персональная — по отделам
 * сотрудников видимого снимка (department_id у неё NULL).
 */
async function listApprovalHrRecipientIds(
  approval: IAffectedApproval,
  kinds: WorkflowRecipientKind[],
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
    departmentIds.map(departmentId => listTimesheetWorkflowRecipientIds(departmentId, kinds)),
  );
  return [...new Set(lists.flat())];
}

async function loadDepartmentName(departmentId: string | null, exec: DbExecutor): Promise<string> {
  const row = (await exec.query<{ name: string | null }>(
    'SELECT name FROM org_departments WHERE id = $1',
    [departmentId],
  )).rows[0];
  return row?.name || String(departmentId);
}

async function buildReadyText(approval: IAffectedApproval, exec: DbExecutor): Promise<string> {
  const rangeLabel = formatTimesheetRangeLabel(approval.start_date, approval.end_date);
  // В ранее скачанном едином файле нерешённый день ушёл с нулём — файл нужен заново.
  const tail = approval.status === 'approved'
    ? 'выходные согласованы. Закройте табель и выгрузите единый файл для 1С заново.'
    : 'выходные согласованы, можно утверждать.';
  if (approval.manager_employee_id != null) {
    const row = (await exec.query<{ full_name: string | null }>(
      'SELECT full_name FROM employees WHERE id = $1',
      [approval.manager_employee_id],
    )).rows[0];
    return `Персональная подача (${row?.full_name || 'руководитель'}): табель за ${rangeLabel} — ${tail}`;
  }
  return `Отдел ${await loadDepartmentName(approval.department_id, exec)}: табель за ${rangeLabel} — ${tail}`;
}

async function insertReadyNotifications(
  exec: DbExecutor,
  ready: IAffectedApproval[],
  readyMonths: IOpenDepartmentMonth[],
): Promise<Pick<IPendingDecisionEffects, 'notifications' | 'pushes'>> {
  const items: ICreateNotification[] = [];
  const pushes: IReadyPush[] = [];
  for (const approval of ready) {
    const closeReady = approval.status === 'approved';
    const recipients = await listApprovalHrRecipientIds(
      approval, closeReady ? CLOSE_RECIPIENT_KINDS : HR_RECIPIENT_KINDS, exec,
    );
    if (recipients.length === 0) continue;
    const type = closeReady ? CLOSE_READY_NOTIFICATION_TYPE : READY_NOTIFICATION_TYPE;
    const title = closeReady ? CLOSE_READY_TITLE : READY_TITLE;
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
      items.push({ userId, type, title, body, metadata });
    }
    // tag только схлопывает push в шторке; идемпотентность обеспечивает переход в транзакции.
    pushes.push({
      recipients,
      title,
      body,
      data: {
        path,
        start_date: approval.start_date,
        end_date: approval.end_date,
        tag: `${closeReady ? 'timesheet-close-ready' : 'timesheet-ready'}:${approval.id}`,
      },
    });
  }
  for (const unit of readyMonths) {
    const recipients = await listTimesheetWorkflowRecipientIds(unit.department_id, CLOSE_RECIPIENT_KINDS);
    if (recipients.length === 0) continue;
    const rangeLabel = formatTimesheetRangeLabel(unit.start_date, unit.end_date);
    const body = `Отдел ${await loadDepartmentName(unit.department_id, exec)}: табель за ${rangeLabel} — `
      + 'выходные согласованы. Выгрузите единый файл для 1С и закройте табель.';
    const path = `/timesheet-hr?from=${unit.start_date}&to=${unit.end_date}`;
    const metadata = {
      departmentId: unit.department_id,
      start_date: unit.start_date,
      end_date: unit.end_date,
      path,
    };
    for (const userId of recipients) {
      items.push({ userId, type: CLOSE_READY_NOTIFICATION_TYPE, title: CLOSE_READY_TITLE, body, metadata });
    }
    pushes.push({
      recipients,
      title: CLOSE_READY_TITLE,
      body,
      data: {
        path,
        start_date: unit.start_date,
        end_date: unit.end_date,
        tag: `timesheet-close-ready:${unit.department_id}:${unit.month_start}`,
      },
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
  const affected = await lockAffectedApprovals(exec, employeeMonths);
  const before = new Map<number, number>();
  for (const approval of affected) {
    before.set(approval.id, await countPendingDecisionsForApproval(approval, exec));
  }
  const openMonths = await lockOpenDepartmentMonths(exec, employeeMonths);

  const { value, changed } = await mutate();
  if (!changed || (affected.length === 0 && openMonths.length === 0)) {
    return { value, effects: NO_PENDING_DECISION_EFFECTS };
  }

  // HR-утверждение и «Закрыть табель» идут в REPEATABLE READ и блокируют строку табеля
  // FOR UPDATE: без записи в неё они дождались бы нашего коммита со старым снимком и не
  // увидели бы новое заявление. Новая версия строки даёт им 40001 → повтор со свежим снимком.
  if (affected.length > 0) {
    await exec.query(
      'UPDATE timesheet_approvals SET updated_at = updated_at WHERE id = ANY($1::bigint[])',
      [affected.map(approval => approval.id)],
    );
  }

  const ready: IAffectedApproval[] = [];
  for (const approval of affected) {
    if ((before.get(approval.id) ?? 0) === 0) continue;
    if (await countPendingDecisionsForApproval(approval, exec) === 0) ready.push(approval);
  }
  const readyMonths: IOpenDepartmentMonth[] = [];
  for (const unit of openMonths) {
    if (await countOpenMonthPending(unit, exec) === 0) readyMonths.push(unit);
  }
  const { notifications, pushes } = await insertReadyNotifications(exec, ready, readyMonths);
  return { value, effects: { affected, notifications, pushes } };
}

/** После коммита: realtime подавшему и кадрам, socket и push по уведомлениям «готов». */
export async function publishPendingDecisionEffects(effects: IPendingDecisionEffects): Promise<void> {
  try {
    for (const approval of effects.affected) {
      const recipients = new Set(await listApprovalHrRecipientIds(approval, HR_RECIPIENT_KINDS));
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
