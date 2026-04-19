import { supabase } from '../config/database.js';
import type { ChatInboundMode } from '../types/index.js';
import { getRoleById } from './roles-cache.service.js';

export type ChatAvailability = 'direct' | 'request' | 'forbidden';
export type ChatRequestStatus = 'incoming_pending' | 'outgoing_pending' | null;

export interface IChatUserContext {
  id: string;
  full_name: string | null;
  role_code: string;
  is_admin: boolean;
  supervisor_id: string | null;
  employee_id: number | null;
  department_id: string | null;
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

const sameDepartment = (left: IChatUserContext, right: IChatUserContext): boolean => {
  return !!left.department_id && left.department_id === right.department_id;
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

    const { data: profiles, error: profileError } = await supabase
      .from('user_profiles')
      .select('id, full_name, system_role_id, supervisor_id, employee_id, chat_inbound_mode, is_approved')
      .in('id', uniqueIds);

    if (profileError) {
      throw new Error(`Failed to load chat user contexts: ${profileError.message}`);
    }

    const employeeIds = (profiles || [])
      .map(profile => profile.employee_id)
      .filter((id): id is number => typeof id === 'number');

    const employeeDeptMap = new Map<number, string | null>();
    if (employeeIds.length > 0) {
      const { data: employees, error: employeeError } = await supabase
        .from('employees')
        .select('id, org_department_id')
        .in('id', employeeIds);

      if (employeeError) {
        throw new Error(`Failed to load chat departments: ${employeeError.message}`);
      }

      (employees || []).forEach(employee => {
        employeeDeptMap.set(employee.id, employee.org_department_id || null);
      });
    }

    const result = new Map<string, IChatUserContext>();
    for (const profile of profiles || []) {
      const role = await getRoleById(profile.system_role_id);
      result.set(profile.id, {
        id: profile.id,
        full_name: profile.full_name,
        role_code: role?.code ?? '',
        is_admin: !!role?.is_admin,
        supervisor_id: profile.supervisor_id,
        employee_id: profile.employee_id,
        department_id: profile.employee_id ? (employeeDeptMap.get(profile.employee_id) ?? null) : null,
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

    const [leftRows, rightRows] = await Promise.all([
      supabase
        .from('chat_contact_grants')
        .select('user_a_id, user_b_id, expires_at')
        .eq('user_a_id', currentUserId)
        .in('user_b_id', uniqueIds),
      supabase
        .from('chat_contact_grants')
        .select('user_a_id, user_b_id, expires_at')
        .eq('user_b_id', currentUserId)
        .in('user_a_id', uniqueIds),
    ]);

    const errors = [leftRows.error, rightRows.error].filter(Boolean);
    if (errors.length > 0) {
      throw new Error(`Failed to load chat grants: ${errors[0]?.message}`);
    }

    [...(leftRows.data || []), ...(rightRows.data || [])].forEach(row => {
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

    const [outgoingRows, incomingRows] = await Promise.all([
      supabase
        .from('chat_contact_requests')
        .select('target_user_id')
        .eq('requester_id', currentUserId)
        .eq('status', 'pending')
        .in('target_user_id', uniqueIds),
      supabase
        .from('chat_contact_requests')
        .select('requester_id')
        .eq('target_user_id', currentUserId)
        .eq('status', 'pending')
        .in('requester_id', uniqueIds),
    ]);

    const errors = [outgoingRows.error, incomingRows.error].filter(Boolean);
    if (errors.length > 0) {
      throw new Error(`Failed to load chat requests: ${errors[0]?.message}`);
    }

    (outgoingRows.data || []).forEach(row => result.set(row.target_user_id, 'outgoing_pending'));
    (incomingRows.data || []).forEach(row => {
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

    if (sameDepartment(currentUser, targetUser)) {
      return buildDecision('direct', 'direct_same_department', 'Прямой чат доступен внутри одного подразделения', requestStatus);
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
