/**
 * Откат партии автоблокировки (см. contractor-pass-idle-block.service.ts). Откат миграции людей в
 * Sigur не разблокирует, поэтому каждая автоблокировка хранит run_id. Вызывает только CLI.
 */
import { query } from '../config/postgres.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { BlacklistBlockedError, withSigurProfileGuard } from './blacklist.service.js';
import {
  errorMessage,
  IDLE_BLOCK_AUDIT_SOURCE,
  invalidateSigurCaches,
  type IIdleBlockFailure,
} from './contractor-pass-idle-block.service.js';
import { markContractorPassUnblocked } from './contractor-pass-idle.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import { sigurService } from './sigur.service.js';

export type IdleRollbackSkipReason = 'holder_changed' | 'later_action' | 'blacklisted';

export interface IIdleRollbackResult {
  runId: string;
  dryRun: boolean;
  /** Записей этой партии в журнале. */
  total: number;
  /** Снято; в dry-run — сколько было бы снято. */
  unblocked: number;
  /** Партия только дописала причину: профиль был заблокирован до неё, снимать нечего. */
  reasonOnly: number;
  skipped: Record<IdleRollbackSkipReason, string[]>;
  failed: IIdleBlockFailure[];
}

interface IRunAuditRow {
  id: string;
  sigur_employee_id: string;
  pass_id: string;
  holder_id: string;
  pass_number: string;
  mode: string | null;
}

const rollbackOne = (
  row: IRunAuditRow,
  runId: string,
  dryRun: boolean,
  connection: ConnectionType,
): Promise<'unblocked' | Exclude<IdleRollbackSkipReason, 'blacklisted'>> => {
  const sigurEmployeeId = Number(row.sigur_employee_id);
  return withSigurProfileGuard(sigurEmployeeId, async client => {
    const last = await client.query<{ id: string }>(
      `SELECT a.id::text AS id
         FROM audit_logs a
        WHERE a.entity_type = 'sigur_employee'
          AND a.entity_id = $1
          AND a.details->>'action' IN ('block', 'unblock')
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 1`,
      [row.sigur_employee_id],
    );
    if (last.rows[0]?.id !== row.id) return 'later_action';

    const holder = await client.query(
      `SELECT h.id
         FROM contractor_passes p
         JOIN contractor_pass_holders h ON h.pass_id = p.id
        WHERE p.id = $1::uuid
          AND h.id::text = $2
          AND h.valid_until IS NULL
          AND h.idle_blocked_at IS NOT NULL
          AND p.status = 'applied'
          AND NOT p.is_active
        FOR UPDATE OF p, h`,
      [row.pass_id, row.holder_id],
    );
    if (holder.rows.length !== 1) return 'holder_changed';
    if (dryRun) return 'unblocked';

    await auditService.logWithClient(client, {
      user_id: null,
      action: AUDIT_ACTIONS.UPDATE_EMPLOYEE,
      entity_type: 'sigur_employee',
      entity_id: row.sigur_employee_id,
      details: {
        action: 'unblock',
        source: 'contractor_pass_idle_rollback',
        run_id: runId,
        pass_id: row.pass_id,
        holder_id: row.holder_id,
      },
    });
    await markContractorPassUnblocked(client, sigurEmployeeId);
    await sigurService.unblockEmployee(sigurEmployeeId, connection);
    return 'unblocked';
  });
};

/**
 * Откат партии. Снимает только то, что партия заблокировала сама, и только если после неё
 * с этим профилем и держателем ничего не делали. Запись «unblock» даёт снятым новые 5 дней.
 * Повторный запуск безопасен: уже снятые попадают в later_action.
 */
export async function rollbackContractorPassIdleRun(params: {
  runId: string;
  dryRun: boolean;
  shouldAbort?: () => boolean;
}): Promise<IIdleRollbackResult> {
  const { runId, dryRun, shouldAbort } = params;
  const rows = await query<IRunAuditRow>(
    `SELECT a.id::text AS id,
            a.entity_id AS sigur_employee_id,
            a.details->>'pass_id' AS pass_id,
            a.details->>'holder_id' AS holder_id,
            a.details->>'pass_number' AS pass_number,
            a.details->>'mode' AS mode
       FROM audit_logs a
      WHERE a.entity_type = 'sigur_employee'
        AND a.details->>'action' = 'block'
        AND a.details->>'source' = $1
        AND a.details->>'run_id' = $2
      ORDER BY a.created_at, a.id`,
    [IDLE_BLOCK_AUDIT_SOURCE, runId],
  );
  const result: IIdleRollbackResult = {
    runId,
    dryRun,
    total: rows.length,
    unblocked: 0,
    reasonOnly: 0,
    skipped: { holder_changed: [], later_action: [], blacklisted: [] },
    failed: [],
  };

  const connection = await sigurService.getBackgroundConnectionType();
  try {
    for (const row of rows) {
      if (shouldAbort?.()) break;
      if (row.mode !== 'blocked') {
        result.reasonOnly += 1;
        continue;
      }
      try {
        const outcome = await rollbackOne(row, runId, dryRun, connection);
        if (outcome === 'unblocked') result.unblocked += 1;
        else result.skipped[outcome].push(row.pass_number);
      } catch (error) {
        if (error instanceof BlacklistBlockedError) {
          result.skipped.blacklisted.push(row.pass_number);
          continue;
        }
        result.failed.push({ passNumber: row.pass_number, error: errorMessage(error) });
      }
    }
  } finally {
    if (!dryRun) invalidateSigurCaches();
  }
  console.log(`[pass-idle-block] откат ${runId}: снято ${result.unblocked} из ${result.total}${dryRun ? ' (dry-run)' : ''}`);
  return result;
}
