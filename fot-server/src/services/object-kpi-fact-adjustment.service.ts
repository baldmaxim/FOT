import type { PoolClient } from 'pg';

import { failWith } from './object-kpi-errors.js';
import type { ObjectKpiActor } from './object-kpi-history.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  createKs2Entry,
  getContractByObject,
  setKs2Status,
  type ObjectKs2Row,
} from './object-kpi.service.js';

/**
 * Корректировка факта месяца.
 *
 * Факт по приказу — сумма подписанных КС-2 (п. 3.1), поэтому «правка факта» в интерфейсе
 * не переписывает число, а заводит корректирующую запись на разницу: иначе отчёт перестал
 * бы сверяться с первичкой, а премия — быть проверяемой.
 *
 * Всё происходит в одной транзакции вызывающего: создание черновика и его подписание
 * нераздельны, иначе при сбое на втором шаге в реестре остался бы висячий черновик,
 * который ничего не меняет и выглядит как забытая запись.
 */

export interface FactAdjustmentParams {
  objectId: string;
  /** YYYY-MM-01 */
  periodMonth: string;
  targetAmount: string | number;
  reason: string;
}

export async function adjustMonthFact(
  client: PoolClient,
  actor: ObjectKpiActor,
  params: FactAdjustmentParams,
): Promise<ObjectKs2Row> {
  const currentMonth = moscowTodayIso().slice(0, 7);
  if (params.periodMonth.slice(0, 7) > currentMonth) {
    failWith({
      http: 400,
      code: 'future_month',
      message: 'Факт будущего месяца корректировать нельзя',
    });
  }

  const contract = await getContractByObject(params.objectId);
  if (!contract) {
    failWith({ http: 404, code: 'not_found', message: 'У объекта нет активного договора' });
  }

  // Разница считается в PostgreSQL на numeric: вычитание миллиардов в JS-числах
  // с плавающей точкой оставляет копеечный мусор, который тут же уедет в акт.
  const deltaResult = await client.query<{ delta: string }>(
    `SELECT ($2::numeric - COALESCE(SUM(amount), 0))::text AS delta
       FROM object_ks2_entries
      WHERE skud_object_id = $1
        AND status = 'signed'
        AND period_month = $3::date`,
    [params.objectId, String(params.targetAmount), params.periodMonth],
  );
  const delta = Number(deltaResult.rows[0]?.delta ?? 0);

  if (delta === 0) {
    failWith({
      http: 400,
      code: 'fact_unchanged',
      message: 'Факт месяца уже равен указанной сумме',
    });
  }

  const created = await createKs2Entry(client, actor, contract!.id, {
    entry_kind: delta > 0 ? 'act' : 'reduction',
    amount: Math.abs(delta),
    // Месяцем, а не датой: дату подписания выводит сам createKs2Entry (последний день
    // месяца, для текущего — сегодня), и правило остаётся в одном месте.
    period_month: params.periodMonth,
    source: 'fact_adjustment',
    notes: params.reason,
  });

  // Подписание тем же клиентом и с той же причиной: черновик факт не двигает, а reason
  // нужен requireReasonIfMonthFixed, если месяц уже зафиксирован (п. 2.8).
  return setKs2Status(client, actor, created.id, 'signed', created.version, params.reason);
}
