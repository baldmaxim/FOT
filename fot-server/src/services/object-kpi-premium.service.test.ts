/**
 * Склейка расчёта премии: порядок запросов, снимок транзакции, выбор версии шкалы,
 * сборка входа для чистой математики. САМИ ФОРМУЛЫ здесь не проверяются — они живут
 * в SQL и покрыты object-kpi-premium.sql.test.ts на настоящем PostgreSQL. Мок вернул бы
 * ровно те числа, которые ему подложили, и «проверка» интерполяции была бы фикцией.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PoolClient } from 'pg';

vi.mock('../config/postgres.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

import { withTransaction } from '../config/postgres.js';
import {
  fetchManagerPremium,
  pickScaleVersion,
  type PremiumScaleVersion,
} from './object-kpi-premium.service.js';

const scale = (id: string, validFrom: string, base = '200000.00'): PremiumScaleVersion => ({
  id,
  valid_from: validFrom,
  base_amount: base,
  max_premium: '300000.00',
  order_reference: null,
  order_url: null,
  points: [
    { completion_pct: '80.00', coefficient: '0.00', premium_amount: '0' },
    { completion_pct: '110.00', coefficient: '1.50', premium_amount: '300000' },
  ],
});

describe('pickScaleVersion', () => {
  const scales = [scale('v1', '2026-01-01'), scale('v2', '2026-08-01', '250000.00')];

  it('берёт последнюю версию, начавшуюся не позже месяца', () => {
    expect(pickScaleVersion(scales, '2026-07-01')?.id).toBe('v1');
    expect(pickScaleVersion(scales, '2026-08-01')?.id).toBe('v2');
    expect(pickScaleVersion(scales, '2026-12-01')?.id).toBe('v2');
  });

  it('месяц до первой версии остаётся без шкалы — обратной силы у приказа нет', () => {
    expect(pickScaleVersion(scales, '2025-12-01')).toBeNull();
    expect(pickScaleVersion([], '2026-08-01')).toBeNull();
  });
});

describe('fetchManagerPremium', () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params: params ?? [] });

      if (sql.startsWith('SET TRANSACTION')) return { rows: [] };
      if (sql.includes('kpi_premium_scale_versions')) {
        return { rows: [{ ...scale('v1', '2026-08-01'), points: scale('v1', '2026-08-01').points }] };
      }
      if (sql.includes('WITH report AS')) {
        return {
          rows: [
            {
              skud_object_id: 'obj-1',
              object_name: 'База Химки',
              period_month: '2026-08-01',
              plan_amount: '100.00',
              fact_amount: '107.00',
              data_quality: 'ok',
              my_days: 31,
              total_days: 31,
              my_share_pct: '100.00',
              my_plan_amount: '100.00',
              my_fact_amount: '107.00',
              my_plan_exact: '100.00',
              my_fact_exact: '107.00',
              included_in_premium: true,
              exclusion_reason: null,
            },
          ],
        };
      }
      if (sql.includes('FROM object_kpi_assignments')) {
        return { rows: [{ skud_object_id: 'obj-1', valid_from: '2026-08-01', valid_to: null }] };
      }
      if (sql.includes('WITH months AS')) {
        return {
          rows: [{
            period_month: '2026-08-01',
            days_in_month: 31,
            any_assignment_days: 31,
            eligible_assignment_days: 31,
          }],
        };
      }
      // Чистая математика — её ответ подменяется, формулы проверяет sql-тест.
      return {
        rows: [{
          period_month: '2026-08-01',
          status: 'calculated',
          total_plan: '100.00',
          total_fact: '107.00',
          completion_pct: '107.00',
          coefficient: '1.35',
          lower_pct: '105.00',
          lower_coef: '1.25',
          upper_pct: '110.00',
          upper_coef: '1.50',
          scale_version_id: 'v1',
          base_amount: '200000.00',
          any_assignment_days: 31,
          eligible_assignment_days: 31,
          days_in_month: 31,
          base_prorated: '200000.00',
          premium_amount: '270000',
          period_total_plan: '100.00',
          period_total_fact: '107.00',
          period_total_premium: '270000',
          period_completion_pct: '107.00',
        }],
      };
    }),
  } as unknown as PoolClient;

  beforeEach(() => {
    queries.length = 0;
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client));
  });

  const params = {
    employeeId: 1428,
    objectIds: ['obj-1'],
    monthFrom: '2026-08-01',
    monthTo: '2026-08-01',
  };

  it('открывает снимок REPEATABLE READ READ ONLY до первого чтения', async () => {
    await fetchManagerPremium(params);
    expect(queries[0].sql).toContain('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  });

  it('доли и премия считаются по одному и тому же набору строк', async () => {
    const result = await fetchManagerPremium(params);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].my_share_pct).toBe('100.00');
    // Служебные неокруглённые поля наружу не уходят.
    expect(result.rows[0]).not.toHaveProperty('my_plan_exact');

    expect(result.premium).toHaveLength(1);
    expect(result.premium[0].premium_amount).toBe('270000');
    expect(result.premium[0].objects[0].object_name).toBe('База Химки');
    expect(result.period_totals.total_premium).toBe('270000');
  });

  it('в математику уходят неокруглённые доли и точки выбранной версии шкалы', async () => {
    await fetchManagerPremium(params);

    const math = queries.find((q) => q.sql.includes('WITH meta AS'));
    expect(math).toBeDefined();

    const meta = JSON.parse(math!.params[0] as string);
    expect(meta[0]).toMatchObject({
      period_month: '2026-08-01',
      any_days: 31,
      eligible_days: 31,
      days_in_month: 31,
      has_incomplete: false,
      scale_version_id: 'v1',
      base_amount: '200000.00',
    });

    const shares = JSON.parse(math!.params[1] as string);
    expect(shares).toEqual([
      { period_month: '2026-08-01', plan_exact: '100.00', fact_exact: '107.00' },
    ]);

    const points = JSON.parse(math!.params[2] as string);
    expect(points.every((p: { version_id: string }) => p.version_id === 'v1')).toBe(true);
  });

  it('наружу отдаются только реально применённые версии шкалы', async () => {
    const result = await fetchManagerPremium(params);
    expect(result.scales.map((s) => s.id)).toEqual(['v1']);
  });

  it('премия точки шкалы считается в SQL, а не собирается из фикстуры', async () => {
    // Фикстура вернёт premium_amount в любом случае, поэтому проверяется сам запрос:
    // без этого поля в SQL таблица шкалы на фронте молча осталась бы без колонки премии,
    // а посчитать base × K на клиенте нельзя — деньги считает PostgreSQL.
    await fetchManagerPremium(params);

    const scaleQuery = queries.find((q) => q.sql.includes('kpi_premium_scale_versions'));
    expect(scaleQuery).toBeDefined();
    expect(scaleQuery!.sql).toContain("'premium_amount'");
    expect(scaleQuery!.sql).toContain('ROUND(p.coefficient * v.base_amount)');
  });
});
