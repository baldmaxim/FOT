import { query } from '../config/postgres.js';
import type { ChatInboundMode } from '../types/index.js';
import { getRoleById } from './roles-cache.service.js';
import { loadEmployeeAccessMap } from './department-access.service.js';

export type ChatAvailability = 'direct' | 'request' | 'forbidden';
export type ChatRequestStatus = 'incoming_pending' | 'outgoing_pending' | null;

export interface IChatUserContext {
  id: string;
  full_name: string | null;
  role_code: string;
  is_admin: boolean;
  supervisor_id: string | null;
  employee_id: number | null;
  department_ids: string[];
  chat_inbound_mode: ChatInboundMode;
  is_approved: boolean;
}

export interface IChatPolicyDecision {
  availability: ChatAvailability;
  availability_reason_code: string;
  availability_reason: string;
  request_status: ChatRequestStatus;
}

type GrantState = {
  hasGrant: boolean;
};

const normalizePair = (left: string, right: string): [string, string] => {
  return left < right ? [left, right] : [right, left];
};

const hasDepartmentOverlap = (left: IChatUserContext, right: IChatUserContext): boolean => {
  if (left.department_ids.length === 0 || right.department_ids.length === 0) return false;
  const rightSet = new Set(right.department_ids);
  return left.department_ids.some(id => rightSet.has(id));
};

const isDirectSupervisorLink = (left: IChatUserContext, right: IChatUserContext): boolean => {
  return left.supervisor_id === right.id || right.supervisor_id === left.id;
};

const isActiveGrant = (expiresAt: string | null): boolean => {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > Date.now();
};

const buildDecision = (
  availability: ChatAvailability,
  availability_reason_code: string,
  availability_reason: string,
  request_status: ChatRequestStatus,
): IChatPolicyDecision => ({
  availability,
  availability_reason_code,
  availability_reason,
  request_status,
});

export const chatPolicyService = {
  normalizePair,

  async getUserContexts(userIds: string[]): Promise<Map<string, IChatUserContext>> {
    const uniqueIds = [...new Set(userIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    let profiles: Array<{
      id: string;
      full_name: string | null;
      system_role_id: string | null;
      supervisor_id: string | null;
      employee_id: number | null;
      chat_inbound_mode: string | null;
      is_approved: boolean | null;
    }>;
    try {
      profiles = await query(
        `SELECT id, full_name, system_role_id, supervisor_id, employee_id, chat_inbound_mode, is_approved
           FROM user_profiles
          WHERE id = ANY($1::uuid[])`,
        [uniqueIds],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load chat user contexts: ${msg}`);
    }

    const employeeIds = profiles
      .map(profile => profile.employee_id)
      .filter((id): id is number => typeof id === 'number');

    const employeeAccessMap = await loadEmployeeAccessMap(employeeIds);

    const result = new Map<string, IChatUserContext>();
    for (const profile of profiles) {
      const role = await getRoleById(profile.system_role_id);
      result.set(profile.id, {
        id: profile.id,
        full_name: profile.full_name,
        role_code: role?.code ?? '',
        is_admin: !!role?.is_admin,
        supervisor_id: profile.supervisor_id,
        employee_id: profile.employee_id,
        department_ids: profile.employee_id ? (employeeAccessMap.get(profile.employee_id) ?? []) : [],
        chat_inbound_mode: (profile.chat_inbound_mode || 'open') as ChatInboundMode,
        is_approved: !!profile.is_approved,
      });
    }

    return result;
  },

  async getGrantState(currentUserId: string, targetUserIds: string[]): Promise<Map<string, GrantState>> {
    const uniqueIds = [...new Set(targetUserIds.filter(id => id && id !== currentUserId))];
    const state = new Map<string, GrantState>();

    if (uniqueIds.length === 0) return state;

    let leftRows: Array<{ user_a_id: string; user_b_id: string; expires_at: string | null }>;
    let rightRows: Array<{ user_a_id: string; user_b_id: string; expires_at: string | null }>;
    try {
      [leftRows, rightRows] = await Promise.all([
        query<{ user_a_id: string; user_b_id: string; expires_at: string | null }>(
          `SELECT user_a_id, user_b_id, expires_at
             FROM chat_contact_grants
            WHERE user_a_id = $1 AND user_b_id = ANY($2::uuid[])`,
          [currentUserId, uniqueIds],
        ),
        query<{ user_a_id: string; user_b_id: string; expires_at: string | null }>(
          `SELECT user_a_id, user_b_id, expires_at
             FROM chat_contact_grants
            WHERE user_b_id = $1 AND user_a_id = ANY($2::uuid[])`,
          [currentUserId, uniqueIds],
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load chat grants: ${msg}`);
    }

    [...leftRows, ...rightRows].forEach(row => {
      if (!isActiveGrant(row.expires_at)) return;
      const counterpartId = row.user_a_id === currentUserId ? row.user_b_id : row.user_a_id;
      state.set(counterpartId, { hasGrant: true });
    });

    return state;
  },

  async getPendingRequestStatuses(currentUserId: string, targetUserIds: string[]): Promise<Map<string, ChatRequestStatus>> {
    const uniqueIds = [...new Set(targetUserIds.filter(id => id && id !== currentUserId))];
    const result = new Map<string, ChatRequestStatus>();

    if (uniqueIds.length === 0) return result;

    let outgoingRows: Array<{ target_user_id: string }>;
    let incomingRows: Array<{ requester_id: string }>;
    try {
      [outgoingRows, incomingRows] = await Promise.all([
        query<{ target_user_id: string }>(
          `SELECT target_user_id
             FROM chat_contact_requests
            WHERE requester_id = $1
              AND status = 'pending'
              AND target_user_id = ANY($2::uuid[])`,
          [currentUserId, uniqueIds],
        ),
        query<{ requester_id: string }>(
          `SELECT requester_id
             FROM chat_contact_requests
            WHERE target_user_id = $1
              AND status = 'pending'
              AND requester_id = ANY($2::uuid[])`,
          [currentUserId, uniqueIds],
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      throw new Error(`Failed to load chat requests: ${msg}`);
    }

    outgoingRows.forEach(row => result.set(row.target_user_id, 'outgoing_pending'));
    incomingRows.forEach(row => {
      if (!result.has(row.requester_id)) {
        result.set(row.requester_id, 'incoming_pending');
      }
    });

    return result;
  },

  async getPairDecision(
    currentUserId: string,
    targetUserId: string,
    providedContexts?: Map<string, IChatUserContext>,
  ): Promise<IChatPolicyDecision> {
    const contexts = providedContexts || await this.getUserContexts([currentUserId, targetUserId]);
    const currentUser = contexts.get(currentUserId);
    const targetUser = contexts.get(targetUserId);

    if (!currentUser || !targetUser) {
      return buildDecision('forbidden', 'user_not_found', 'Пользователь недоступен для чата', null);
    }

    const [grantState, requestStatuses] = await Promise.all([
      this.getGrantState(currentUserId, [targetUserId]),
      this.getPendingRequestStatuses(currentUserId, [targetUserId]),
    ]);

    return this.evaluatePair({
      currentUser,
      targetUser,
      hasGrant: grantState.get(targetUserId)?.hasGrant ?? false,
      requestStatus: requestStatuses.get(targetUserId) ?? null,
    });
  },

  async getDecisionsForTargets(currentUserId: string, targetUserIds: string[]): Promise<Map<string, IChatPolicyDecision>> {
    const uniqueIds = [...new Set(targetUserIds.filter(id => id && id !== currentUserId))];
    const result = new Map<string, IChatPolicyDecision>();

    if (uniqueIds.length === 0) return result;

    const [contexts, grantState, requestStatuses] = await Promise.all([
      this.getUserContexts([currentUserId, ...uniqueIds]),
      this.getGrantState(currentUserId, uniqueIds),
      this.getPendingRequestStatuses(currentUserId, uniqueIds),
    ]);

    const currentUser = contexts.get(currentUserId);
    if (!currentUser) return result;

    uniqueIds.forEach(targetUserId => {
      const targetUser = contexts.get(targetUserId);
      if (!targetUser) return;

      result.set(targetUserId, this.evaluatePair({
        currentUser,
        targetUser,
        hasGrant: grantState.get(targetUserId)?.hasGrant ?? false,
        requestStatus: requestStatuses.get(targetUserId) ?? null,
      }));
    });

    return result;
  },

  evaluatePair(params: {
    currentUser: IChatUserContext;
    targetUser: IChatUserContext;
    hasGrant: boolean;
    requestStatus: ChatRequestStatus;
  }): IChatPolicyDecision {
    const { currentUser, targetUser, hasGrant, requestStatus } = params;

    if (!targetUser.is_approved) {
      return buildDecision('forbidden', 'target_not_approved', 'Пользователь ещё не одобрен в системе', requestStatus);
    }

    if (hasGrant) {
      return buildDecision('direct', 'direct_grant', 'Контакт разрешён вручную', requestStatus);
    }

    // Админы доступны всем напрямую.
    if (currentUser.is_admin || targetUser.is_admin) {
      return buildDecision('direct', 'direct_admin', 'Чат разрешён для администраторов', requestStatus);
    }

    if (targetUser.chat_inbound_mode === 'disabled') {
      return buildDecision('forbidden', 'target_disabled', 'Пользователь не принимает новые контакты', requestStatus);
    }

    if (hasDepartmentOverlap(currentUser, targetUser)) {
      return buildDecision('direct', 'direct_same_department', 'Прямой чат доступен внутри общих подразделений', requestStatus);
    }

    if (isDirectSupervisorLink(currentUser, targetUser)) {
      return buildDecision('direct', 'direct_supervisor', 'Прямой чат доступен между руководителем и подчинённым', requestStatus);
    }

    if (targetUser.chat_inbound_mode === 'requests_only') {
      return buildDecision('request', 'request_requests_only', 'Этому пользователю нужно отправить запрос на контакт', requestStatus);
    }

    return buildDecision('forbidden', 'forbidden_cross_department', 'Новые чаты доступны только внутри отдела, по прямой иерархии или через разрешение', requestStatus);
  },
};
