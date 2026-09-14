import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from '../config/postgres.js';
import { encryptionService } from './encryption.service.js';
import { msisdnHash, normalizeMsisdn } from './mts-business-cdr.service.js';
import type { ForwardingType } from './mts-forwarding.shared.js';

// Серверные операции переадресации «Моя SIM» (миграции 276, 278): включение,
// смена режима (kind=set) и отключение (kind=remove). Здесь только БД-слой.
//
// ИНВАРИАНТЫ:
//  - все переходы — атомарный UPDATE … WHERE id AND state = ANY(from) [AND аренда]
//    [AND поколение/действие] RETURNING; внешний вызов МТС делает только тот, кому
//    строка вернулась;
//  - перед внешней мутацией claimSend ставит send_started_at, аренду и следующее
//    поколение: если процесс упадёт, recoverStale переведёт строку в сверку, а не в
//    повторную отправку; запоздавший результат старого поколения переход не пройдёт;
//  - результат проверки (снимок правил, аудит) пишется в одной транзакции с
//    переходом (commit) — отклонённый переход ничего не записывает;
//  - частичный UNIQUE держит одну незавершённую операцию на номер (включая
//    unconfirmed): одновременные включение и отключение не пересекаются.

export type ForwardingOperationState =
  | 'service_reserved' | 'service_sending' | 'service_accepted' | 'service_unknown'
  | 'rule_ready' | 'rule_sending' | 'rule_verifying' | 'rule_confirmed'
  | 'rule_clear_sending' | 'rule_clear_verifying'
  | 'unconfirmed' | 'done' | 'failed' | 'cancelled' | 'expired';

export type ForwardingOperationKind = 'set' | 'remove';

/** Текущая мутация этапа правила: null — установка, 'delete:<тип>' — снятие мешающего правила. */
export type ForwardingRuleAction = `delete:${ForwardingType}` | null;

export const FINAL_OPERATION_STATES: readonly ForwardingOperationState[] = ['done', 'failed', 'cancelled', 'expired'];

/** Состояния, которые воркер берёт в работу (отправляющие разбирает recoverStale). */
export const DUE_OPERATION_STATES: readonly ForwardingOperationState[] = [
  'service_reserved', 'service_accepted', 'service_unknown',
  'rule_ready', 'rule_verifying', 'rule_confirmed', 'rule_clear_verifying', 'unconfirmed',
];

/** Аренда на внешнюю отправку: 3 ожидания 429 (до 60 с) + тайм-аут 20 с с запасом. */
export const SEND_LEASE_SECONDS = 360;

export interface IForwardingOperation {
  id: string;
  kind: ForwardingOperationKind;
  accountId: string;
  msisdnHash: string;
  employeeId: number;
  requestedBy: string;
  forwardingType: ForwardingType;
  /** Номер назначения; null — для kind=remove. */
  target: string | null;
  noReplyTimer: number | null;
  state: ForwardingOperationState;
  serviceEventId: string | null;
  ruleEventId: string | null;
  ruleAction: ForwardingRuleAction;
  ruleAttempts: number;
  sendGeneration: number;
  sendStartedAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  deadlineAt: string;
  nextCheckAt: string;
  confirmedRules: unknown;
  quotaCountedAt: string | null;
  unconfirmedFrom: ForwardingOperationState | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

interface IOperationRow {
  id: string;
  kind: ForwardingOperationKind;
  account_id: string;
  msisdn_hash: string;
  employee_id: number;
  requested_by: string;
  forwarding_type: ForwardingType;
  target_enc: string | null;
  no_reply_timer: number | null;
  state: ForwardingOperationState;
  service_event_id: string | null;
  rule_event_id: string | null;
  rule_action: ForwardingRuleAction;
  rule_attempts: number;
  send_generation: number;
  send_started_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  deadline_at: string;
  next_check_at: string;
  confirmed_rules: unknown;
  quota_counted_at: string | null;
  unconfirmed_from: ForwardingOperationState | null;
  last_error_code: string | null;
  last_error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

const mapRow = (r: IOperationRow): IForwardingOperation => ({
  id: r.id,
  kind: r.kind ?? 'set',
  accountId: r.account_id,
  msisdnHash: r.msisdn_hash,
  employeeId: Number(r.employee_id),
  requestedBy: r.requested_by,
  forwardingType: r.forwarding_type,
  target: r.target_enc ? encryptionService.decryptField(r.target_enc) : null,
  noReplyTimer: r.no_reply_timer == null ? null : Number(r.no_reply_timer),
  state: r.state,
  serviceEventId: r.service_event_id,
  ruleEventId: r.rule_event_id,
  ruleAction: r.rule_action ?? null,
  ruleAttempts: Number(r.rule_attempts),
  sendGeneration: Number(r.send_generation ?? 0),
  sendStartedAt: r.send_started_at,
  leaseOwner: r.lease_owner,
  leaseUntil: r.lease_until,
  deadlineAt: r.deadline_at,
  nextCheckAt: r.next_check_at,
  confirmedRules: r.confirmed_rules,
  quotaCountedAt: r.quota_counted_at ?? null,
  unconfirmedFrom: r.unconfirmed_from ?? null,
  lastErrorCode: r.last_error_code,
  lastErrorMessage: r.last_error_message,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

export interface IReserveInput {
  kind: ForwardingOperationKind;
  accountId: string;
  msisdn: string;
  employeeId: number;
  requestedBy: string;
  forwardingType: ForwardingType;
  target: string | null;
  noReplyTimer: number | null;
  initialState: 'service_reserved' | 'rule_ready';
  deadlineSeconds: number;
}

export interface ITransitionPatch {
  state?: ForwardingOperationState;
  serviceEventId?: string;
  ruleEventId?: string | null;
  ruleAction?: ForwardingRuleAction;
  /** rule_attempts = 0 — переход к следующему действию этапа правила. */
  resetRuleAttempts?: boolean;
  /** Взять аренду (owner + секунды) или снять (null). */
  lease?: { owner: string; seconds: number } | null;
  deadlineSeconds?: number;
  nextCheckSeconds?: number;
  confirmedRules?: unknown;
  unconfirmedFrom?: ForwardingOperationState | null;
  error?: { code: string | null; message: string | null } | null;
}

/** Условия перехода сверх состояния: аренда владельца и поколение/действие отправки. */
export interface ITransitionGuard {
  owner?: string;
  expect?: { generation: number; action: ForwardingRuleAction };
}

export interface INumberBinding {
  msisdn: string | null;
  employeeId: number | null;
  accountId: string | null;
}

type Executor = (sql: string, params: unknown[]) => Promise<IOperationRow | null>;

const ACTIVE_FILTER = `state NOT IN ('done', 'failed', 'cancelled', 'expired')`;

/** Совпадает ли запрос с операцией: вид, тип, нормализованный адрес, таймер (для CFNRY). */
export const sameForwardingParams = (
  op: Pick<IForwardingOperation, 'kind' | 'forwardingType' | 'target' | 'noReplyTimer'>,
  input: { kind: ForwardingOperationKind; forwardingType: ForwardingType; target: string | null; noReplyTimer: number | null },
): boolean => {
  if (op.kind !== input.kind) return false;
  if (op.kind === 'remove') return true;
  return op.forwardingType === input.forwardingType
    && normalizeMsisdn(op.target ?? '') === normalizeMsisdn(input.target ?? '')
    && (op.forwardingType !== 'CFNRY' || op.noReplyTimer === input.noReplyTimer);
};

export const isOperationFinal = (state: ForwardingOperationState): boolean => FINAL_OPERATION_STATES.includes(state);

const buildTransition = (
  id: string,
  from: readonly ForwardingOperationState[],
  patch: ITransitionPatch,
  guard: ITransitionGuard,
): { sql: string; params: unknown[] } => {
  const sets: string[] = ['updated_at = NOW()'];
  const params: unknown[] = [id, from];
  const add = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (patch.state) {
    sets.push(`state = ${add(patch.state)}::text`);
    if (isOperationFinal(patch.state)) sets.push('finished_at = NOW()');
  }
  if (patch.serviceEventId !== undefined) sets.push(`service_event_id = ${add(patch.serviceEventId)}::text`);
  if (patch.ruleEventId !== undefined) sets.push(`rule_event_id = ${add(patch.ruleEventId)}::text`);
  if (patch.ruleAction !== undefined) sets.push(`rule_action = ${add(patch.ruleAction)}::text`);
  if (patch.resetRuleAttempts) sets.push('rule_attempts = 0');
  if (patch.lease === null) {
    sets.push('lease_owner = NULL', 'lease_until = NULL');
  } else if (patch.lease) {
    sets.push(`lease_owner = ${add(patch.lease.owner)}::text`, `lease_until = NOW() + make_interval(secs => ${add(patch.lease.seconds)})`);
  }
  if (patch.deadlineSeconds !== undefined) sets.push(`deadline_at = NOW() + make_interval(secs => ${add(patch.deadlineSeconds)})`);
  if (patch.nextCheckSeconds !== undefined) sets.push(`next_check_at = NOW() + make_interval(secs => ${add(patch.nextCheckSeconds)})`);
  if (patch.confirmedRules !== undefined) sets.push(`confirmed_rules = ${add(JSON.stringify(patch.confirmedRules))}::jsonb`);
  if (patch.unconfirmedFrom !== undefined) sets.push(`unconfirmed_from = ${add(patch.unconfirmedFrom)}::text`);
  if (patch.error === null) {
    sets.push('last_error_code = NULL', 'last_error_message = NULL');
  } else if (patch.error) {
    sets.push(`last_error_code = ${add(patch.error.code)}::text`, `last_error_message = ${add(patch.error.message)}::text`);
  }

  const where = ['id = $1', 'state = ANY($2::text[])'];
  if (guard.owner) where.push(`lease_owner = ${add(guard.owner)}::text`);
  if (guard.expect) {
    where.push(`send_generation = ${add(guard.expect.generation)}::int`);
    where.push(`rule_action IS NOT DISTINCT FROM ${add(guard.expect.action)}::text`);
  }
  return {
    sql: `UPDATE mts_forwarding_operations SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`,
    params,
  };
};

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
           (kind, account_id, msisdn_hash, employee_id, requested_by, forwarding_type, target_enc, no_reply_timer,
            state, deadline_at, next_check_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + make_interval(secs => $10), NOW() + INTERVAL '30 seconds')
         ON CONFLICT (account_id, msisdn_hash) WHERE ${ACTIVE_FILTER} DO NOTHING
         RETURNING *`,
        [
          input.kind, input.accountId, hash, input.employeeId, input.requestedBy, input.forwardingType,
          input.target ? encryptionService.encrypt(input.target) : null, input.noReplyTimer,
          input.initialState, input.deadlineSeconds,
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
   * и прошла guard (аренда, поколение/действие). null — переход проиграл.
   */
  async transition(
    id: string,
    from: readonly ForwardingOperationState[],
    patch: ITransitionPatch,
    guard: ITransitionGuard = {},
  ): Promise<IForwardingOperation | null> {
    const { sql, params } = buildTransition(id, from, patch, guard);
    const row = await queryOne<IOperationRow>(sql, params);
    return row ? mapRow(row) : null;
  }

  /**
   * Переход + записи результата (снимок, аудит, журнал) одной транзакцией:
   * writes выполняется только если переход прошёл; упадут записи — откатится и переход.
   */
  async commit(
    id: string,
    from: readonly ForwardingOperationState[],
    patch: ITransitionPatch,
    guard: ITransitionGuard,
    writes: (client: PoolClient, op: IForwardingOperation) => Promise<void>,
  ): Promise<IForwardingOperation | null> {
    return withTransaction(async client => {
      const { sql, params } = buildTransition(id, from, patch, guard);
      const exec: Executor = async (s, p) => (await client.query<IOperationRow>(s, p)).rows[0] ?? null;
      const row = await exec(sql, params);
      if (!row) return null;
      const op = mapRow(row);
      await writes(client, op);
      return op;
    });
  }

  /**
   * Право на внешнюю отправку: переход from → to с маркером отправки, арендой и
   * следующим поколением. Аренда должна быть свободна или у этого владельца.
   * rule_attempts растёт на отправках этапа правила (счётчик текущего действия).
   */
  async claimSend(
    id: string,
    from: ForwardingOperationState,
    to: 'service_sending' | 'rule_sending' | 'rule_clear_sending',
    owner: string,
    action: ForwardingRuleAction = null,
  ): Promise<IForwardingOperation | null> {
    const row = await queryOne<IOperationRow>(
      `UPDATE mts_forwarding_operations
          SET state = $3::text, send_started_at = NOW(), lease_owner = $4::text,
              lease_until = NOW() + make_interval(secs => $5), updated_at = NOW(),
              rule_attempts = rule_attempts + $6::int,
              rule_action = $7::text,
              send_generation = send_generation + 1
        WHERE id = $1 AND state = $2::text
          AND (lease_until IS NULL OR lease_until < NOW() OR lease_owner = $4::text)
        RETURNING *`,
      [id, from, to, owner, SEND_LEASE_SECONDS, to === 'service_sending' ? 0 : 1, action],
    );
    return row ? mapRow(row) : null;
  }

  /**
   * Квота изменений пользователя (общая на включение, смену режима и отключение):
   * засчитывает операцию один раз, перед первой реальной мутацией. true — можно
   * отправлять (в т.ч. уже засчитана), false — квота исчерпана.
   */
  async consumeQuota(id: string, userId: string, max: number, windowSeconds: number): Promise<boolean> {
    return withTransaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('mts_fwd_quota:' || $1::text))`, [userId]);
      const own = await client.query<{ counted: boolean }>(
        `SELECT quota_counted_at IS NOT NULL AS counted FROM mts_forwarding_operations WHERE id = $1`,
        [id],
      );
      if (!own.rows[0]) return false;
      if (own.rows[0].counted) return true;
      const used = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM mts_forwarding_operations
          WHERE requested_by = $1 AND quota_counted_at > NOW() - make_interval(secs => $2)`,
        [userId, windowSeconds],
      );
      if (Number(used.rows[0]?.n ?? 0) >= max) return false;
      await client.query(
        `UPDATE mts_forwarding_operations SET quota_counted_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND quota_counted_at IS NULL`,
        [id],
      );
      return true;
    });
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
   * факта, повторной отправки нет. Поколение и действие не меняются.
   */
  async recoverStale(): Promise<number> {
    const rows = await query<{ id: string }>(
      `UPDATE mts_forwarding_operations
          SET state = CASE state
                WHEN 'service_sending' THEN 'service_unknown'
                WHEN 'rule_clear_sending' THEN 'rule_clear_verifying'
                ELSE 'rule_verifying' END,
              lease_owner = NULL, lease_until = NULL, next_check_at = NOW(), updated_at = NOW()
        WHERE state IN ('service_sending', 'rule_sending', 'rule_clear_sending') AND lease_until < NOW()
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
