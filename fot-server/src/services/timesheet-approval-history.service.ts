import { supabase } from '../config/database.js';
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
  department_id: string;
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

  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, full_name, position_type, system_role_id')
    .in('id', userIds);

  if (error) {
    throw error;
  }

  return new Map((data || []).map(profile => [
    profile.id as string,
    {
      id: profile.id as string,
      full_name: (profile.full_name as string | null) ?? null,
      position_type: (profile.position_type as string | null) ?? null,
      system_role_id: (profile.system_role_id as string | null) ?? null,
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
    departmentId: string;
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
    const { error } = await supabase
      .from('timesheet_approval_events')
      .insert({
        approval_id: input.approvalId,
        department_id: input.departmentId,
        start_date: input.startDate,
        end_date: input.endDate,
        action: input.action,
        from_status: input.fromStatus,
        to_status: input.toStatus,
        actor_user_id: input.actorUserId,
        comment: input.comment ?? null,
        metadata: input.metadata ?? {},
        created_at: input.createdAt ?? new Date().toISOString(),
      });

    if (error) {
      throw error;
    }
  },

  async listByApprovalId(approvalId: number): Promise<TimesheetApprovalEvent[]> {
    const { data, error } = await supabase
      .from('timesheet_approval_events')
      .select('id, approval_id, department_id, start_date, end_date, action, from_status, to_status, actor_user_id, comment, metadata, created_at')
      .eq('approval_id', approvalId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false });

    if (error) {
      throw error;
    }

    const rows = (data || []) as IApprovalEventRow[];
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
