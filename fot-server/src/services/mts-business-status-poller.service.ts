import * as Sentry from '@sentry/node';
import { env } from '../config/env.js';
import { query, execute, queryOne } from '../config/postgres.js';
import { mtsBusinessDataService } from './mts-business-data.service.js';
import { mtsBusinessActionsService } from './mts-business-actions.service.js';
import { mtsBusinessCatalogService } from './mts-business-catalog.service.js';
import { mtsBusinessBudgetService } from './mts-business-budget.service.js';
import { mtsBusinessMetricsStoreService } from './mts-business-metrics-store.service.js';
import { MtsBusinessApiError } from './mts-business-base.service.js';
import { encryptionService } from './encryption.service.js';
import {
  tryAcquireSigurRuntimeLease,
  releaseSigurRuntimeLease,
  getSigurRuntimeOwner,
} from './sigur-runtime-state.service.js';
import { runWithCronMonitor, type CronRunStatus } from '../utils/sentry-cron.js';

// Фоновый поллер статусов «висящих» заявок детализации МТС Бизнес. Документ
// приходит на email (файл через API не скачать), поэтому здесь только опрашиваем
// статус заявки (Completed/InProgress/Faulted) и обновляем его в БД — чтобы в UI
// было видно, готов ли заказанный отчёт. Сам XML загружается в модуль вручную.
//
// Lease через sigur_runtime_state (общая инфраструктура), ключ
// 'mts_business_status_polling'. При нескольких инстансах PM2 поллит только один.

const LEASE_KEY = 'mts_business_status_polling';
const LEASE_TTL_SECONDS = 180;
const STARTUP_DELAY_MS = 45_000;
const MAX_PER_TICK = 20;

let timer: NodeJS.Timeout | null = null;
let stopped = false;

/**
 * Опрос заявок на управляющие действия (услуги/блокировки/правила бюджета) —
 * тот же тик, что и детализация, но отдельный источник статуса: у услуг/
 * блокировок — Product/CheckRequestStatus (mts-business-catalog.service.ts),
 * у правил бюджета — Operations/GetStatus (mts-business-budget.service.ts).
 * При завершении — обновляем кэш каталога/бюджета этого номера, чтобы
 * таблицы на вкладке «Финансы»/«Администрирование» сразу показали новое
 * состояние без ручного рефреша.
 */
async function pollActionRequests(): Promise<{ pending: number; updated: number }> {
  const pending = await mtsBusinessActionsService.getPending(MAX_PER_TICK);
  let updated = 0;
  for (const row of pending) {
    try {
      const msisdn = row.msisdnEnc ? encryptionService.decryptField(row.msisdnEnc) : null;
      const isBudget = row.actionType === 'budget_rule_add' || row.actionType === 'budget_rule_remove';

      const { status } = isBudget
        ? await mtsBusinessBudgetService.checkOperationStatus(row.accountId, row.eventId)
        : msisdn
          ? await mtsBusinessCatalogService.checkModifyProductStatus(row.accountId, msisdn, row.eventId)
          : { status: 'unknown' as const };

      await mtsBusinessActionsService.updateStatus(row.eventId, status);
      updated++;

      if (status === 'completed' && msisdn) {
        if (row.actionType === 'service_add' || row.actionType === 'service_remove') {
          const services = await mtsBusinessCatalogService.getProductInfo(row.accountId, msisdn);
          await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId: row.accountId, scope: 'msisdn', msisdn, metric: 'product_services', payload: services });
        } else if (isBudget) {
          const rules = await mtsBusinessBudgetService.getProvidedRulesByMsisdn(row.accountId, msisdn);
          await mtsBusinessMetricsStoreService.upsertSnapshot({ accountId: row.accountId, scope: 'msisdn', msisdn, metric: 'budget_rules', payload: rules });
        }
      }
    } catch (error) {
      if (error instanceof MtsBusinessApiError) {
        console.error(`[mts-biz-status] action check failed http=${error.status} code=${error.code ?? '-'}`);
      } else {
        console.error('[mts-biz-status] action check failed:', error instanceof Error ? error.message : 'unknown');
      }
    }
  }
  return { pending: pending.length, updated };
}

async function tick(owner: string): Promise<void> {
  // Модуль не настроен (нет активных аккаунтов) — тихо выходим.
  const acct = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM mts_business_accounts WHERE is_active = true`,
  );
  if (!acct || Number(acct.n) === 0) return;

  const acq = await tryAcquireSigurRuntimeLease({
    key: LEASE_KEY,
    owner,
    ttlSeconds: LEASE_TTL_SECONDS,
    meta: { tickedAt: new Date().toISOString() },
  });
  if (!acq.acquired) return;

  let cronStatus: CronRunStatus = 'ok';
  const intervalMin = Math.max(1, Math.round((Number.parseInt(env.MTS_BUSINESS_STATUS_POLL_MS, 10) || 300_000) / 60_000));
  try {
    await runWithCronMonitor(
      'mts-business-status-poller',
      async () => {
        try {
          const pending = await query<{ message_id: string; account_id: string | null }>(
            `SELECT message_id, account_id
               FROM mts_business_detalization_requests
              WHERE status IN ('in_progress', 'unknown')
                AND account_id IS NOT NULL
                AND requested_at > NOW() - INTERVAL '7 days'
              ORDER BY requested_at ASC
              LIMIT $1`,
            [MAX_PER_TICK],
          );
          let updated = 0;
          for (const row of pending) {
            if (!row.account_id) continue;
            try {
              const { status } = await mtsBusinessDataService.checkRequestStatus(row.account_id, row.message_id);
              await execute(
                `UPDATE mts_business_detalization_requests
                    SET status = $2, checked_at = NOW()
                  WHERE message_id = $1`,
                [row.message_id, status],
              );
              updated++;
            } catch (error) {
              // Единичная заявка не должна валить весь тик.
              if (error instanceof MtsBusinessApiError) {
                console.error(`[mts-biz-status] check failed http=${error.status} code=${error.code ?? '-'}`);
              } else {
                console.error('[mts-biz-status] check failed:', error instanceof Error ? error.message : 'unknown');
              }
            }
          }
          console.log(`[mts-biz-status] tick: pending=${pending.length} updated=${updated}`);

          const actions = await pollActionRequests();
          console.log(`[mts-biz-status] actions tick: pending=${actions.pending} updated=${actions.updated}`);
        } catch (error) {
          cronStatus = 'error';
          console.error('[mts-biz-status] tick failed:', error instanceof Error ? error.message : 'unknown');
          Sentry.captureException(error);
        }
        return cronStatus;
      },
      {
        schedule: { type: 'interval', value: intervalMin, unit: 'minute' },
        checkinMargin: 5,
        maxRuntime: 8,
      },
    );
  } finally {
    await releaseSigurRuntimeLease({ key: LEASE_KEY, owner }).catch(err =>
      console.error('[mts-biz-status] release lease failed:', (err as Error).message),
    );
  }
}

export function startMtsBusinessStatusPoller(): void {
  if (timer) return;
  stopped = false;
  const intervalMs = Math.max(60_000, Number.parseInt(env.MTS_BUSINESS_STATUS_POLL_MS, 10) || 300_000);
  const owner = getSigurRuntimeOwner('mts_business_status_polling');

  console.log(`[mts-biz-status] starting (interval=${Math.round(intervalMs / 1000)}s, owner=${owner})`);

  const run = (): void => {
    if (stopped) return;
    void tick(owner);
  };

  setTimeout(run, STARTUP_DELAY_MS);
  timer = setInterval(run, intervalMs);
}

export function stopMtsBusinessStatusPoller(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
