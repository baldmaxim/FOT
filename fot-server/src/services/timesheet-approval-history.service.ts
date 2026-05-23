import { execute, query } from '../config/postgres.js';
import type {
  TimesheetApprovalEvent,
  TimesheetApprovalEventAction,
  TimesheetApprovalStatus,
} from '../types/index.js';
import { getRoleByCode, getRoleById } from './roles-cache.service.js';

type TimesheetResolvedStatus = Exclude<TimesheetApprovalStatus, 'draft'>;

interface IApprovalEventRow {
  id: number;
  approval_id: number;
  department_id: string | null;
  start_date: string;
  end_date: string;
  action: TimesheetApprovalEventAction;
  from_status: TimesheetApprovalStatus | null;
  to_status: TimesheetResolvedStatus;
  actor_user_id: string;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface IActorProfile {
  id: string;
  full_name: string | null;
  position_type: string | null;
  system_role_id?: string | null;
}

async function loadActorProfileMap(userIds: string[]): Promise<Map<string, IActorProfile>> {
  if (userIds.length === 0) return new Map();

  const data = await query<{
    id: string;
    full_name: string | null;
    position_type: string | null;
    system_role_id: string | null;
  }>(
    'SELECT id, full_name, position_type, system_role_id FROM user_profiles WHERE id = ANY($1::uuid[])',
    [userIds],
  );

  return new Map(data.map(profile => [
    profile.id,
    {
      id: profile.id,
      full_name: profile.full_name ?? null,
      position_type: profile.position_type ?? null,
      system_role_id: profile.system_role_id ?? null,
    },
  ]));
}

async function resolveActorPositionName(profile: IActorProfile | undefined): Promise<string | null> {
  if (!profile) return null;

  const role = await getRoleById(profile.system_role_id) ?? await getRoleByCode(profile.position_type || '');
  return role?.name ?? profile.position_type ?? null;
}

export const timesheetApprovalHistoryService = {
  async appendEvent(input: {
    approvalId: number;
    departmentId: string | null;
    startDate: string;
    endDate: string;
    action: TimesheetApprovalEventAction;
    fromStatus: TimesheetApprovalStatus | null;
    toStatus: TimesheetResolvedStatus;
    actorUserId: string;
    comment?: string | null;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<void> {
    await execute(
      `INSERT INTO timesheet_approval_events
         (approval_id, department_id, start_date, end_date, action,
          from_status, to_status, actor_user_id, comment, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
      [
        input.approvalId,
        input.departmentId,
        input.startDate,
        input.endDate,
        input.action,
        input.fromStatus,
        input.toStatus,
        input.actorUserId,
        input.comment ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.createdAt ?? new Date().toISOString(),
      ],
    );
  },

  async listByApprovalId(approvalId: number): Promise<TimesheetApprovalEvent[]> {
    const rows = await query<IApprovalEventRow>(
      `SELECT id, approval_id, department_id, start_date, end_date, action,
              from_status, to_status, actor_user_id, comment, metadata, created_at
         FROM timesheet_approval_events
        WHERE approval_id = $1
        ORDER BY created_at DESC, id DESC`,
      [approvalId],
    );
    const actorProfileMap = await loadActorProfileMap([
      ...new Set(rows.map(row => row.actor_user_id).filter(Boolean)),
    ]);
    const actorPositionEntries = await Promise.all(
      [...actorProfileMap.entries()].map(async ([userId, profile]) => [
        userId,
        await resolveActorPositionName(profile),
      ] as const),
    );
    const actorPositionMap = new Map(actorPositionEntries);

    return rows.map(row => ({
      id: row.id,
      approval_id: row.approval_id,
      department_id: row.department_id,
      start_date: row.start_date,
      end_date: row.end_date,
      action: row.action,
      from_status: row.from_status,
      to_status: row.to_status,
      actor_user_id: row.actor_user_id,
      actor_full_name: actorProfileMap.get(row.actor_user_id)?.full_name ?? null,
      actor_position_name: actorPositionMap.get(row.actor_user_id) ?? null,
      comment: row.comment,
      metadata: row.metadata ?? {},
      created_at: row.created_at,
    }));
  },
};
