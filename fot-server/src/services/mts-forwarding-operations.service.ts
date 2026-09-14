import { query, queryOne } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { msisdnHash, normalizeMsisdn } from './mts-business-cdr.service.js';
import type { ForwardingType } from './mts-forwarding.shared.js';

// Серверные операции самостоятельного включения переадресации («Моя SIM»),
// таблица mts_forwarding_operations (миграция 276). Здесь только БД-слой.
//
// ИНВАРИАНТЫ:
//  - все переходы — одиночный атомарный UPDATE … WHERE id AND state = ANY(from)
//    RETURNING; внешний вызов МТС делает только тот, кому строка вернулась;
//  - перед внешней мутацией ставится send_started_at и аренда: если процесс
//    упадёт, recoverStale переведёт строку в сверку факта, а не в повторную отправку;
//  - частичный UNIQUE держит одну незавершённую операцию на номер (включая
//    unconfirmed), поэтому новое нажатие не создаёт дубль внешней мутации.

export type ForwardingOperationState =
  | 'service_reserved' | 'service_sending' | 'service_accepted' | 'service_unknown'
  | 'rule_ready' | 'rule_sending' | 'rule_verifying' | 'rule_confirmed'
  | 'unconfirmed' | 'done' | 'failed' | 'cancelled' | 'expired';

export const FINAL_OPERATION_STATES: readonly ForwardingOperationState[] = ['done', 'failed', 'cancelled', 'expired'];

/** Состояния, которые воркер берёт в работу (отправляющие разбирает recoverStale). */
export const DUE_OPERATION_STATES: readonly ForwardingOperationState[] = [
  'service_reserved', 'service_accepted', 'service_unknown',
  'rule_ready', 'rule_verifying', 'rule_confirmed', 'unconfirmed',
];

/** Аренда на внешнюю отправку: 3 ожидания 429 (до 60 с) + тайм-аут 20 с с запасом. */
export const SEND_LEASE_SECONDS = 360;

export interface IForwardingOperation {
  id: string;
  accountId: string;
  msisdnHash: string;
  employeeId: number;
  requestedBy: string;
  forwardingType: ForwardingType;
  target: string;
  noReplyTimer: number | null;
  state: ForwardingOperationState;
  serviceEventId: string | null;
  ruleEventId: string | null;
  ruleAttempts: number;
  sendStartedAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  deadlineAt: string;
  nextCheckAt: string;
  confirmedRules: unknown;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface IOperationRow {
  id: string;
  account_id: string;
  msisdn_hash: string;
  employee_id: number;
  requested_by: string;
  forwarding_type: ForwardingType;
  target_enc: string;
  no_reply_timer: number | null;
  state: ForwardingOperationState;
  service_event_id: string | null;
  rule_event_id: string | null;
  rule_attempts: number;
  send_started_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  deadline_at: string;
  next_check_at: string;
  confirmed_rules: unknown;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const mapRow = (r: IOperationRow): IForwardingOperation => ({
  id: r.id,
  accountId: r.account_id,
  msisdnHash: r.msisdn_hash,
  employeeId: Number(r.employee_id),
  requestedBy: r.requested_by,
  forwardingType: r.forwarding_type,
  target: encryptionService.decryptField(r.target_enc) ?? '',
  noReplyTimer: r.no_reply_timer == null ? null : Number(r.no_reply_timer),
  state: r.state,
  serviceEventId: r.service_event_id,
  ruleEventId: r.rule_event_id,
  ruleAttempts: Number(r.rule_attempts),
  sendStartedAt: r.send_started_at,
  leaseOwner: r.lease_owner,
  leaseUntil: r.lease_until,
  deadlineAt: r.deadline_at,
  nextCheckAt: r.next_check_at,
  confirmedRules: r.confirmed_rules,
  lastErrorCode: r.last_error_code,
  lastErrorMessage: r.last_error_message,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

export interface IReserveInput {
  accountId: string;
  msisdn: string;
  employeeId: number;
  requestedBy: string;
  forwardingType: ForwardingType;
  target: string;
  noReplyTimer: number | null;
  initialState: 'service_reserved' | 'rule_ready';
  deadlineSeconds: number;
}

export interface ITransitionPatch {
  state?: ForwardingOperationState;
  serviceEventId?: string;
  ruleEventId?: string | null;
  incrementRuleAttempts?: boolean;
  /** send_started_at = NOW() — маркер начала внешней отправки. */
  markSendStarted?: boolean;
  /** Взять аренду (owner + секунды) или снять (null). */
  lease?: { owner: string; seconds: number } | null;
  deadlineSeconds?: number;
  nextCheckSeconds?: number;
  confirmedRules?: unknown;
  error?: { code: string | null; message: string | null } | null;
}

export interface INumberBinding {
  msisdn: string | null;
  employeeId: number | null;
  accountId: string | null;
}

const ACTIVE_FILTER = `state NOT IN ('done', 'failed', 'cancelled', 'expired')`;

/** Совпадают ли параметры запроса: тип, нормализованный адрес, таймер (для CFNRY). */
export const sameForwardingParams = (
  op: Pick<IForwardingOperation, 'forwardingType' | 'target' | 'noReplyTimer'>,
  input: { forwardingType: ForwardingType; target: string; noReplyTimer: number | null },
): boolean =>
  op.forwardingType === input.forwardingType
  && normalizeMsisdn(op.target) === normalizeMsisdn(input.target)
  && (op.forwardingType !== 'CFNRY' || op.noReplyTimer === input.noReplyTimer);

export const isOperationFinal = (state: ForwardingOperationState): boolean => FINAL_OPERATION_STATES.includes(state);

class MtsForwardingOperationsService {
  /**
   * Резерв операции до любого внешнего вызова. created=true — строку создал
   * этот вызов, и только он вправе отправлять мутацию; created=false —
   * у номера уже есть незавершённая операция (её и возвращаем).
   */
  async reserve(input: IReserveInput): Promise<{ operation: IForwardingOperation; created: boolean }> {
    const hash = msisdnHash(input.msisdn);
    if (!hash) throw new Error('Некорректный номер для операции переадресации');
    // Две попытки: между конфликтом вставки и чтением активная операция могла завершиться.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await queryOne<IOperationRow>(
        `INSERT INTO mts_forwarding_operations
           (account_id, msisdn_hash, employee_id, requested_by, forwarding_type, target_enc, no_reply_timer,
            state, deadline_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + make_interval(secs => $9), NOW() + INTERVAL '30 seconds')
         ON CONFLICT (account_id, msisdn_hash) WHERE ${ACTIVE_FILTER} DO NOTHING
         RETURNING *`,
        [
          input.accountId, hash, input.employeeId, input.requestedBy, input.forwardingType,
          encryptionService.encrypt(input.target), input.noReplyTimer, input.initialState, input.deadlineSeconds,
        ],
      );
      if (inserted) return { operation: mapRow(inserted), created: true };
      const active = await this.getActive(input.accountId, hash);
      if (active) return { operation: active, created: false };
    }
    throw new Error('Не удалось зарезервировать операцию переадресации');
  }

  async getById(id: string): Promise<IForwardingOperation | null> {
    const row = await queryOne<IOperationRow>(`SELECT * FROM mts_forwarding_operations WHERE id = $1`, [id]);
    return row ? mapRow(row) : null;
  }

  async getActive(accountId: string, hash: string): Promise<IForwardingOperation | null> {
    const row = await queryOne<IOperationRow>(
      `SELECT * FROM mts_forwarding_operations
        WHERE account_id = $1 AND msisdn_hash = $2 AND ${ACTIVE_FILTER}
        LIMIT 1`,
      [accountId, hash],
    );
    return row ? mapRow(row) : null;
  }

  /** Незавершённая операция по номеру на любом ЛС — для запрета отключения. */
  async getActiveByMsisdn(msisdn: string): Promise<IForwardingOperation | null> {
    const hash = msisdnHash(msisdn);
    if (!hash) return null;
    const row = await queryOne<IOperationRow>(
      `SELECT * FROM mts_forwarding_operations WHERE msisdn_hash = $1 AND ${ACTIVE_FILTER} LIMIT 1`,
      [hash],
    );
    return row ? mapRow(row) : null;
  }

  /** Для UI: незавершённая либо последняя за 24 ч операция номера. */
  async getActiveOrRecent(msisdn: string): Promise<IForwardingOperation | null> {
    const hash = msisdnHash(msisdn);
    if (!hash) return null;
    const row = await queryOne<IOperationRow>(
      `SELECT * FROM mts_forwarding_operations
        WHERE msisdn_hash = $1
          AND (${ACTIVE_FILTER} OR created_at > NOW() - INTERVAL '24 hours')
        ORDER BY (${ACTIVE_FILTER}) DESC, created_at DESC
        LIMIT 1`,
      [hash],
    );
    return row ? mapRow(row) : null;
  }

  /**
   * Атомарный переход. Возвращает строку, только если она была в одном из from
   * (и, при requireOwner, аренда у этого владельца). null — переход проиграл:
   * внешний вызов делать нельзя.
   */
  async transition(
    id: string,
    from: readonly ForwardingOperationState[],
    patch: ITransitionPatch,
    requireOwner?: string,
  ): Promise<IForwardingOperation | null> {
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [id, from];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (patch.state) {
      sets.push(`state = ${add(patch.state)}`);
      if (isOperationFinal(patch.state)) sets.push('finished_at = NOW()');
    }
    if (patch.serviceEventId !== undefined) sets.push(`service_event_id = ${add(patch.serviceEventId)}`);
    if (patch.ruleEventId !== undefined) sets.push(`rule_event_id = ${add(patch.ruleEventId)}`);
    if (patch.incrementRuleAttempts) sets.push('rule_attempts = rule_attempts + 1');
    if (patch.markSendStarted) sets.push('send_started_at = NOW()');
    if (patch.lease === null) {
      sets.push('lease_owner = NULL', 'lease_until = NULL');
    } else if (patch.lease) {
      sets.push(`lease_owner = ${add(patch.lease.owner)}`, `lease_until = NOW() + make_interval(secs => ${add(patch.lease.seconds)})`);
    }
    if (patch.deadlineSeconds !== undefined) sets.push(`deadline_at = NOW() + make_interval(secs => ${add(patch.deadlineSeconds)})`);
    if (patch.nextCheckSeconds !== undefined) sets.push(`next_check_at = NOW() + make_interval(secs => ${add(patch.nextCheckSeconds)})`);
    if (patch.confirmedRules !== undefined) sets.push(`confirmed_rules = ${add(JSON.stringify(patch.confirmedRules))}::jsonb`);
    if (patch.error === null) {
      sets.push('last_error_code = NULL', 'last_error_message = NULL');
    } else if (patch.error) {
      sets.push(`last_error_code = ${add(patch.error.code)}`, `last_error_message = ${add(patch.error.message)}`);
    }

    const ownerClause = requireOwner ? ` AND lease_owner = ${add(requireOwner)}` : '';
    const row = await queryOne<IOperationRow>(
      `UPDATE mts_forwarding_operations SET ${sets.join(', ')}
        WHERE id = $1 AND state = ANY($2::text[])${ownerClause}
        RETURNING *`,
      params,
    );
    return row ? mapRow(row) : null;
  }

  /**
   * Право на внешнюю отправку: переход from → to с маркером отправки и арендой.
   * Аренда должна быть свободна или уже принадлежать этому владельцу.
   */
  async claimSend(
    id: string,
    from: ForwardingOperationState,
    to: 'service_sending' | 'rule_sending',
    owner: string,
  ): Promise<IForwardingOperation | null> {
    const row = await queryOne<IOperationRow>(
      `UPDATE mts_forwarding_operations
          SET state = $3::text, send_started_at = NOW(), lease_owner = $4::text,
              lease_until = NOW() + make_interval(secs => $5), updated_at = NOW(),
              rule_attempts = rule_attempts + $6::int
        WHERE id = $1 AND state = $2::text
          AND (lease_until IS NULL OR lease_until < NOW() OR lease_owner = $4::text)
        RETURNING *`,
      [id, from, to, owner, SEND_LEASE_SECONDS, to === 'rule_sending' ? 1 : 0],
    );
    return row ? mapRow(row) : null;
  }

  /** Выбор и закрепление работы воркера одним оператором (SKIP LOCKED + аренда). */
  async claimDue(owner: string, limit: number, leaseSeconds: number): Promise<IForwardingOperation[]> {
    const rows = await query<IOperationRow>(
      `UPDATE mts_forwarding_operations
          SET lease_owner = $1, lease_until = NOW() + make_interval(secs => $3), updated_at = NOW()
        WHERE id IN (
          SELECT id FROM mts_forwarding_operations
           WHERE state = ANY($2::text[])
             AND next_check_at <= NOW()
             AND (lease_until IS NULL OR lease_until < NOW())
           ORDER BY next_check_at
           LIMIT $4
           FOR UPDATE SKIP LOCKED
        )
        RETURNING *`,
      [owner, DUE_OPERATION_STATES, leaseSeconds, limit],
    );
    return rows.map(mapRow);
  }

  /**
   * Отправка зависла (процесс упал/аренда истекла): POST мог уйти — только сверка
   * факта, повторной отправки нет.
   */
  async recoverStale(): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE mts_forwarding_operations
          SET state = CASE state WHEN 'service_sending' THEN 'service_unknown' ELSE 'rule_verifying' END,
              lease_owner = NULL, lease_until = NULL, next_check_at = NOW(), updated_at = NOW()
        WHERE state IN ('service_sending', 'rule_sending') AND lease_until < NOW()
        RETURNING id`,
    );
    return rows.length;
  }

  /** Текущая привязка номера: расшифрованный msisdn, сотрудник и ЛС. */
  async getNumberBinding(hash: string): Promise<INumberBinding | null> {
    const row = await queryOne<{ msisdn_enc: string | null; employee_id: number | null; account_id: string | null }>(
      `SELECT msisdn_enc, employee_id, account_id FROM mts_business_number_map WHERE msisdn_hash = $1`,
      [hash],
    );
    if (!row) return null;
    return {
      msisdn: encryptionService.decryptField(row.msisdn_enc),
      employeeId: row.employee_id == null ? null : Number(row.employee_id),
      accountId: row.account_id,
    };
  }
}

export const mtsForwardingOperationsService = new MtsForwardingOperationsService();
