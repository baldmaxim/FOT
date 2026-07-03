import { execute, query } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { msisdnHash } from './mts-business-cdr.service.js';

// CRUD заявок на управляющие действия МТС «Бизнес» (mts_business_action_requests)
// — калька mts_business_detalization_requests. Сам HTTP-вызов к МТС делают
// mts-business-catalog.service.ts (услуги/блокировки) и mts-business-budget.service.ts
// (правила бюджета); здесь только персист заявки + статус-поллинг.

export type MtsBusinessActionType = 'service_add' | 'service_remove' | 'block_add' | 'block_remove' | 'budget_rule_add' | 'budget_rule_remove';

export interface IActionRequestCreate {
  eventId: string;
  accountId: string;
  scope: 'account' | 'msisdn';
  msisdn?: string | null;
  accountNo?: string | null;
  actionType: MtsBusinessActionType;
  payload: unknown;
  requestedBy: string;
}

export interface IActionRequestRow {
  eventId: string;
  accountId: string | null;
  scope: string;
  actionType: string;
  status: string;
  requestedAt: string;
  checkedAt: string | null;
}

export interface IPendingActionRequest {
  eventId: string;
  accountId: string;
  scope: 'account' | 'msisdn';
  msisdnEnc: string | null;
  actionType: MtsBusinessActionType;
}

class MtsBusinessActionsService {
  async create(input: IActionRequestCreate): Promise<void> {
    const hash = input.msisdn ? msisdnHash(input.msisdn) : null;
    await execute(
      `INSERT INTO mts_business_action_requests
         (event_id, account_id, scope, msisdn_hash, account_no, action_type, request_payload_enc, status, requested_by, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8, NOW())
       ON CONFLICT (event_id) DO UPDATE
         SET status = 'in_progress', checked_at = NULL`,
      [
        input.eventId, input.accountId, input.scope, hash, input.accountNo ?? null,
        input.actionType, encryptionService.encrypt(JSON.stringify(input.payload)), input.requestedBy,
      ],
    );
  }

  async list(limit = 100): Promise<IActionRequestRow[]> {
    const rows = await query<{
      event_id: string; account_id: string | null; scope: string; action_type: string;
      status: string; requested_at: string; checked_at: string | null;
    }>(
      `SELECT event_id, account_id, scope, action_type, status, requested_at, checked_at
         FROM mts_business_action_requests
        ORDER BY requested_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(r => ({
      eventId: r.event_id,
      accountId: r.account_id,
      scope: r.scope,
      actionType: r.action_type,
      status: r.status,
      requestedAt: r.requested_at,
      checkedAt: r.checked_at,
    }));
  }

  /** Заявки «в обработке» для статус-поллера — с расшифрованным номером (для повторного вызова API). */
  async getPending(limit = 20): Promise<IPendingActionRequest[]> {
    const rows = await query<{
      event_id: string; account_id: string | null; scope: string; msisdn_enc: string | null; action_type: string;
    }>(
      `SELECT ar.event_id, ar.account_id, ar.scope, nm.msisdn_enc, ar.action_type
         FROM mts_business_action_requests ar
         LEFT JOIN mts_business_number_map nm ON nm.msisdn_hash = ar.msisdn_hash
        WHERE ar.status IN ('in_progress', 'unknown')
          AND ar.account_id IS NOT NULL
          AND ar.requested_at > NOW() - INTERVAL '7 days'
        ORDER BY ar.requested_at ASC
        LIMIT $1`,
      [limit],
    );
    return rows
      .filter((r): r is typeof r & { account_id: string } => r.account_id !== null)
      .map(r => ({
        eventId: r.event_id,
        accountId: r.account_id,
        scope: r.scope as 'account' | 'msisdn',
        msisdnEnc: r.msisdn_enc,
        actionType: r.action_type as MtsBusinessActionType,
      }));
  }

  async updateStatus(eventId: string, status: string): Promise<void> {
    await execute(
      `UPDATE mts_business_action_requests SET status = $2, checked_at = NOW() WHERE event_id = $1`,
      [eventId, status],
    );
  }
}

export const mtsBusinessActionsService = new MtsBusinessActionsService();
