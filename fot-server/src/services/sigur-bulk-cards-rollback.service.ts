/**
 * Откат массового продления карт по operationId.
 *
 * Источник истины — запись `bulk_extend_cards_started` в audit_logs: она пишется
 * ДО первого PATCH и содержит прежние сроки карт и связанных пропусков. Поэтому
 * откат работает и тогда, когда итоговой записи нет вовсе (процесс упал в середине) —
 * именно в этом случае он и нужнее всего.
 *
 * Возврат срока — CAS: карта восстанавливается, только если сейчас на ней стоит
 * ровно тот срок, который поставила эта операция. Если после неё срок правили
 * руками, откат такую карту не трогает.
 *
 * Сам откат — полноценная операция: берёт тот же lock, пишет rollback_started до
 * первой записи и rollback_completed/partial после, использует то же ядро записи.
 */
import { randomUUID } from 'crypto';
import { query, execute, withTransaction } from '../config/postgres.js';
import { auditService } from './audit.service.js';
import { sigurService } from './sigur.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  toEmployeeCardBinding,
  invalidateSigurDirectoryCaches,
  type IEmployeeCardBinding,
} from './sigur-live-admin.service.js';
import { applyCardExpirationChange } from './sigur-live-cards.service.js';
import { acquireSigurCardLease } from './sigur-card-lease.service.js';

const ROLLBACK_LEASE_TTL_SECONDS = 300;

export type RollbackCardStatus =
  | 'rollback_extended'
  | 'rollback_failed'
  | 'rollback_unknown'
  | 'changed_after_operation'
  | 'no_previous_expiration'
  | 'not_applicable';

export type RollbackLocalStatus =
  | 'local_restored'
  | 'local_changed_after_operation'
  | 'local_failed'
  | 'local_skipped';

export interface IRollbackCardResult {
  employeeId: number;
  cardId: number;
  previousExpiration: string | null;
  observedExpiration: string | null;
  status: RollbackCardStatus;
  error?: string;
  passes: Array<{ passId: string; status: RollbackLocalStatus }>;
}

export interface IRollbackResult {
  operationId: string;
  rollbackAttemptId: string;
  apply: boolean;
  /** Итоговой записи исходной операции нет — она могла оборваться на середине. */
  missingCompleted: boolean;
  candidates: number;
  restoredCards: number;
  failedCards: number;
  unknownCards: number;
  changedAfterOperation: number;
  restoredPasses: number;
  items: IRollbackCardResult[];
  warnings: string[];
}

interface IAuditRow {
  details: Record<string, unknown> | null;
}

interface IStartedPlanItem {
  employeeId: number;
  cardId: number | null;
  previousExpiration: string | null;
  startDate: string | null;
  format: string | null;
  passes?: Array<{
    passId: string;
    previousExpiresAt: string | null;
    previousCardUid: string | null;
    previousCardHexUid: string | null;
  }>;
}

interface IStartedRecord {
  connection?: ConnectionType;
  targetIso: string;
  expirationDate: string;
  plan: IStartedPlanItem[];
}

async function loadOperationAudit(operationId: string): Promise<{
  started: IStartedRecord;
  missingCompleted: boolean;
}> {
  const rows = await query<IAuditRow>(
    `SELECT details
       FROM audit_logs
      WHERE entity_type = 'sigur_card_bulk_extend' AND entity_id = $1
      ORDER BY created_at ASC`,
    [operationId],
  );

  const actionOf = (row: IAuditRow): string =>
    typeof row.details?.action === 'string' ? row.details.action : '';

  const startedRow = rows.find(row => actionOf(row) === 'bulk_extend_cards_started');
  if (!startedRow?.details) {
    throw new Error(`Операция ${operationId} не найдена в журнале`);
  }

  const details = startedRow.details as Record<string, unknown>;
  const plan = Array.isArray(details.plan) ? details.plan as IStartedPlanItem[] : [];
  const targetIso = typeof details.targetIso === 'string' ? details.targetIso : '';
  const expirationDate = typeof details.expirationDate === 'string' ? details.expirationDate : '';
  if (!targetIso || !expirationDate) {
    throw new Error(`Запись операции ${operationId} повреждена: нет целевой даты`);
  }

  const missingCompleted = !rows.some(row => {
    const action = actionOf(row);
    return action === 'bulk_extend_cards_completed' || action === 'bulk_extend_cards_partial';
  });

  return {
    started: {
      connection: details.connection === 'external' || details.connection === 'internal'
        ? details.connection
        : undefined,
      targetIso,
      expirationDate,
      plan,
    },
    missingCompleted,
  };
}

async function readBinding(
  employeeId: number,
  cardId: number,
  connection?: ConnectionType,
): Promise<IEmployeeCardBinding | null> {
  const raw = await sigurService.getCardBindings({ employeeId, cardId }, connection) as Record<string, unknown>[];
  return raw
    .map(row => toEmployeeCardBinding(row))
    .filter((row): row is IEmployeeCardBinding => !!row && row.cardId === cardId)
    .find(row => row.employeeId === employeeId) ?? null;
}

const sameInstant = (left: string | null, right: string | null): boolean => {
  if (!left || !right) return left === right;
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  return !Number.isNaN(a) && !Number.isNaN(b) && a === b;
};

/**
 * Локальный возврат срока пропуска — только после подтверждённого возврата карты
 * в Sigur и тем же строгим CAS, что при продлении.
 */
async function restoreLinkedPass(
  pass: NonNullable<IStartedPlanItem['passes']>[number],
  employeeId: number,
  targetDate: string,
): Promise<RollbackLocalStatus> {
  if (!pass.previousExpiresAt) return 'local_skipped';
  try {
    const affected = await execute(
      `UPDATE contractor_passes
          SET expires_at = $1::date, updated_at = now()
        WHERE id = $2::uuid
          AND sigur_employee_id = $3::bigint
          AND card_uid IS NOT DISTINCT FROM $4
          AND card_hex_uid IS NOT DISTINCT FROM $5
          AND expires_at = $6::date`,
      [
        pass.previousExpiresAt,
        pass.passId,
        employeeId,
        pass.previousCardUid ?? null,
        pass.previousCardHexUid ?? null,
        targetDate,
      ],
    );
    return affected > 0 ? 'local_restored' : 'local_changed_after_operation';
  } catch (error) {
    console.error(`[bulk-extend-rollback] local restore failed for pass ${pass.passId}:`, error);
    return 'local_failed';
  }
}

export async function rollbackBulkExtendOperation(params: {
  operationId: string;
  apply: boolean;
  actorUserId?: string | null;
}): Promise<IRollbackResult> {
  const { operationId, apply, actorUserId = null } = params;
  const rollbackAttemptId = randomUUID();

  const { started, missingCompleted } = await loadOperationAudit(operationId);
  const warnings: string[] = [];
  if (missingCompleted) {
    warnings.push(
      'У операции нет итоговой записи в журнале — она могла оборваться на середине. '
      + 'Проверьте отчёт особенно внимательно.',
    );
  }

  const lease = await acquireSigurCardLease({
    owner: `rollback:${operationId}:${rollbackAttemptId}`,
    ttlSeconds: ROLLBACK_LEASE_TTL_SECONDS,
    meta: { kind: 'bulk_card_extend_rollback', operationId, rollbackAttemptId },
  });

  const items: IRollbackCardResult[] = [];
  let touchedSigur = false;

  try {
    if (apply) {
      await withTransaction(async client => {
        await auditService.logWithClient(client, {
          user_id: actorUserId,
          action: 'UPDATE_EMPLOYEE',
          entity_type: 'sigur_card_bulk_extend',
          entity_id: operationId,
          details: {
            action: 'bulk_extend_cards_rollback_started',
            operationId,
            rollbackAttemptId,
            targetIso: started.targetIso,
            missingCompleted,
            cards: started.plan.length,
          },
        });
      });
    }

    for (const planItem of started.plan) {
      if (planItem.cardId == null || !planItem.startDate) continue;

      const result: IRollbackCardResult = {
        employeeId: planItem.employeeId,
        cardId: planItem.cardId,
        previousExpiration: planItem.previousExpiration,
        observedExpiration: null,
        status: 'not_applicable',
        passes: [],
      };

      if (!planItem.previousExpiration) {
        // Бессрочную привязку этой операцией не трогали и вернуть её нечем.
        result.status = 'no_previous_expiration';
        items.push(result);
        continue;
      }

      let binding: IEmployeeCardBinding | null = null;
      try {
        binding = await readBinding(planItem.employeeId, planItem.cardId, started.connection);
      } catch (error) {
        result.status = 'rollback_unknown';
        result.error = error instanceof Error ? error.message : String(error);
        items.push(result);
        continue;
      }

      result.observedExpiration = binding?.expirationDate ?? null;

      // Кандидат — только карта, на которой стоит ровно наш срок. Сюда попадают и
      // карты с неподтверждённым исходом (unknown): по факту запись прошла.
      if (!binding || !sameInstant(binding.expirationDate, started.targetIso)) {
        result.status = 'changed_after_operation';
        items.push(result);
        continue;
      }

      if (!apply) {
        result.status = 'rollback_extended';
        items.push(result);
        continue;
      }

      try {
        touchedSigur = true;
        await applyCardExpirationChange({
          sigurEmployeeId: planItem.employeeId,
          cardId: planItem.cardId,
          startDate: binding.startDate || planItem.startDate,
          expirationDate: planItem.previousExpiration,
          connection: started.connection,
          format: binding.format ?? planItem.format,
        });
        result.status = 'rollback_extended';
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        // Ретраи HTTP-клиента означают, что запись могла пройти — перечитываем.
        try {
          const verify = await readBinding(planItem.employeeId, planItem.cardId, started.connection);
          result.observedExpiration = verify?.expirationDate ?? null;
          if (verify && sameInstant(verify.expirationDate, planItem.previousExpiration)) {
            result.status = 'rollback_extended';
          } else if (verify && sameInstant(verify.expirationDate, started.targetIso)) {
            result.status = 'rollback_failed';
          } else {
            result.status = 'rollback_unknown';
          }
        } catch {
          result.status = 'rollback_unknown';
        }
      }

      if (result.status === 'rollback_extended') {
        for (const pass of planItem.passes || []) {
          const localStatus = apply
            ? await restoreLinkedPass(pass, planItem.employeeId, started.expirationDate)
            : 'local_skipped';
          result.passes.push({ passId: pass.passId, status: localStatus });
        }
      }

      items.push(result);
    }

    const counters = items.reduce((acc, item) => {
      if (item.status === 'rollback_extended') acc.restoredCards += 1;
      if (item.status === 'rollback_failed') acc.failedCards += 1;
      if (item.status === 'rollback_unknown') acc.unknownCards += 1;
      if (item.status === 'changed_after_operation') acc.changedAfterOperation += 1;
      acc.restoredPasses += item.passes.filter(pass => pass.status === 'local_restored').length;
      return acc;
    }, {
      restoredCards: 0,
      failedCards: 0,
      unknownCards: 0,
      changedAfterOperation: 0,
      restoredPasses: 0,
    });

    const result: IRollbackResult = {
      operationId,
      rollbackAttemptId,
      apply,
      missingCompleted,
      candidates: items.filter(item => item.status !== 'changed_after_operation'
        && item.status !== 'no_previous_expiration').length,
      ...counters,
      items,
      warnings,
    };

    if (apply) {
      if (touchedSigur || counters.unknownCards > 0) invalidateSigurDirectoryCaches();
      try {
        await withTransaction(async client => {
          await auditService.logWithClient(client, {
            user_id: actorUserId,
            action: 'UPDATE_EMPLOYEE',
            entity_type: 'sigur_card_bulk_extend',
            entity_id: operationId,
            details: {
              action: counters.failedCards > 0 || counters.unknownCards > 0
                ? 'bulk_extend_cards_rollback_partial'
                : 'bulk_extend_cards_rollback_completed',
              operationId,
              rollbackAttemptId,
              ...counters,
              items,
            },
          });
        });
      } catch (error) {
        console.error('[bulk-extend-rollback] final audit failed:', error);
        result.warnings.push('Откат выполнен, но итоговая запись в журнал не удалась');
      }
    }

    return result;
  } finally {
    await lease.release();
  }
}
