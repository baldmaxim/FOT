/**
 * Логика допуска и разбора для скрипта ANALYZE — без обращения к БД.
 *
 * Скрипт делает единственную запись на production, поэтому проверяются и «можно ли»,
 * и «что именно измеряем»: «приложение ходит под владельцем партиции» — гипотеза,
 * а старый SQL легко подменить похожим, но неэквивалентным.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  evaluateMeasureReadiness,
  evaluatePreflight,
  OLD_FOLDERS_SQL,
  OLD_SEEDS_SQL,
  parseExplain,
  runApply,
  totalBuffers,
  type IPreflightRow,
  type ISqlRunner,
} from '../../scripts/analyze-skud-may-partition.js';

const NOW = Date.parse('2026-08-14T03:00:00Z');

const okRow = (over: Partial<IPreflightRow> = {}): IPreflightRow => ({
  db: 'FOT_Prod',
  current_user_name: 'Odintsov',
  in_recovery: false,
  partition_exists: true,
  is_partition: true,
  parent_relname: 'skud_events',
  partition_owner: 'Odintsov',
  is_owner: true,
  has_maintain: false,
  last_analyze: '2026-08-14T02:30:00Z',
  last_autoanalyze: '2026-05-24T04:29:36.830Z',
  correlation: 0.836,
  ...over,
});

describe('evaluatePreflight', () => {
  it('владелец партиции на проде — допуск есть', () => {
    expect(evaluatePreflight(okRow())).toEqual({ ok: true, problems: [] });
  });

  it('не владелец, но с MAINTAIN — допуск есть', () => {
    expect(evaluatePreflight(okRow({ is_owner: false, has_maintain: true })).ok).toBe(true);
  });

  it('ни владения, ни MAINTAIN — отказ с указанием роли и владельца', () => {
    const verdict = evaluatePreflight(okRow({
      current_user_name: 'mcp_readonly', is_owner: false, has_maintain: false,
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('mcp_readonly');
    expect(verdict.problems.join(' ')).toContain('MAINTAIN');
  });

  it('чужая БД — отказ даже при достаточных правах', () => {
    const verdict = evaluatePreflight(okRow({ db: 'FOT_Staging' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('FOT_Staging');
  });

  it('реплика — отказ', () => {
    expect(evaluatePreflight(okRow({ in_recovery: true })).problems.join(' ')).toContain('recovery');
  });

  it('отношения нет — отказ', () => {
    const verdict = evaluatePreflight(okRow({ partition_exists: false, partition_owner: null }));
    expect(verdict.problems.join(' ')).toContain('не найдено');
  });

  it('отношение есть, но это не партиция — отказ', () => {
    const verdict = evaluatePreflight(okRow({ is_partition: false, parent_relname: null }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('не является партицией');
  });

  it('партиция чужой таблицы — отказ (защита от опечатки в имени)', () => {
    const verdict = evaluatePreflight(okRow({ parent_relname: 'some_other_table' }));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('some_other_table');
  });

  it('несколько нарушений — перечислены все', () => {
    const verdict = evaluatePreflight(okRow({
      db: 'other', in_recovery: true, is_owner: false, has_maintain: false,
    }));
    expect(verdict.problems).toHaveLength(3);
  });

  it('пустой результат — отказ, а не молчаливый успех', () => {
    expect(evaluatePreflight(undefined).ok).toBe(false);
  });
});

describe('evaluateMeasureReadiness', () => {
  it('свежий last_analyze и правильное окружение — можно мерить', () => {
    expect(evaluateMeasureReadiness(okRow(), NOW)).toEqual({ ok: true, problems: [] });
  });

  it('прав на ANALYZE не требует: read-only роль может замерять', () => {
    const verdict = evaluateMeasureReadiness(
      okRow({ current_user_name: 'mcp_readonly', is_owner: false, has_maintain: false }), NOW,
    );
    expect(verdict.ok).toBe(true);
  });

  it('last_analyze пуст — отказ: ANALYZE ещё не выполнялся', () => {
    const verdict = evaluateMeasureReadiness(okRow({ last_analyze: null }), NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('ещё не выполнялся');
  });

  it('last_analyze устарел — отказ, чтобы не выдать замер «до» за «после»', () => {
    const verdict = evaluateMeasureReadiness(okRow({ last_analyze: '2026-05-24T04:29:36Z' }), NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('устарел');
  });

  it('окружение проверяется и здесь: чужая БД → отказ', () => {
    expect(evaluateMeasureReadiness(okRow({ db: 'other' }), NOW).ok).toBe(false);
  });
});

describe('parseExplain', () => {
  it('берёт буферы корня и Execution Time', () => {
    const res = parseExplain([
      'Append (actual rows=7287 loops=1)',
      '  Buffers: shared hit=330363',
      '        Buffers: shared hit=272842',
      'Execution Time: 28125.404 ms',
    ]);
    expect(res).toEqual({ ms: 28125.404, hit: 330363, read: 0 });
    expect(totalBuffers(res)).toBe(330363);
  });

  it('учитывает shared read наравне с hit', () => {
    const res = parseExplain([
      'Seq Scan (actual rows=1 loops=1)',
      '  Buffers: shared hit=1000 read=250',
      'Execution Time: 12.5 ms',
    ]);
    expect(res).toEqual({ ms: 12.5, hit: 1000, read: 250 });
    expect(totalBuffers(res)).toBe(1250);
  });

  it('только read, без hit', () => {
    const res = parseExplain(['  Buffers: shared read=42', 'Execution Time: 1.0 ms']);
    expect(res.hit).toBe(0);
    expect(res.read).toBe(42);
  });

  it('без нужных строк возвращает null, а не выдуманные числа', () => {
    const res = parseExplain(['Seq Scan on foo']);
    expect(res).toEqual({ ms: null, hit: null, read: null });
    expect(totalBuffers(res)).toBeNull();
  });
});

describe('старый SQL воспроизводит реальный прод-путь', () => {
  it('папки читаются отдельным запросом, а не array_agg внутри CTE', () => {
    expect(OLD_FOLDERS_SQL).toContain('timekeeper_folder_access');
    // Готовый массив приходит параметром — именно так работал прод до правки.
    expect(OLD_SEEDS_SQL).toContain('get_descendant_department_ids($2::uuid[])');
    // Регресс-гард: сборка папок внутри тяжёлого запроса даёт ДРУГОЙ план.
    expect(OLD_SEEDS_SQL).not.toContain('array_agg');
    expect(OLD_SEEDS_SQL).not.toContain('timekeeper_folder_access');
  });

  it('обе ветки present и предикат отделов сохранены дословно', () => {
    expect(OLD_SEEDS_SQL).toContain('employee_skud_object_access');
    expect(OLD_SEEDS_SQL).toContain('BTRIM(se.access_point) = BTRIM(sap.access_point_name)');
    expect(OLD_SEEDS_SQL).toContain("d.kind = 'brigade'");
    expect(OLD_SEEDS_SQL).toContain('d.id <> $3::uuid');
  });
});

describe('runApply — единственная запись скрипта', () => {
  /** Мок SQL-исполнителя: маршрутизирует по началу текста запроса. */
  function makeRunner(opts: {
    preflight: IPreflightRow | undefined;
    analyzeThrows?: boolean;
    lastAnalyzeAfter?: string | null;
  }) {
    const calls: string[] = [];
    const runner: ISqlRunner = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (sql.includes('current_database()')) return { rows: opts.preflight ? [opts.preflight] : [] };
        if (sql.startsWith('SET lock_timeout')) return { rows: [] };
        if (sql.startsWith('ANALYZE')) {
          if (opts.analyzeThrows) throw new Error('permission denied for table skud_events_2026_05');
          return { rows: [] };
        }
        return { rows: [{ last_analyze: opts.lastAnalyzeAfter ?? null }] };
      }),
    };
    return { runner, calls, didAnalyze: () => calls.some(s => s.startsWith('ANALYZE')) };
  }

  it('preflight не пройден → ANALYZE не вызывается, код 1', async () => {
    const { runner, didAnalyze } = makeRunner({
      preflight: okRow({ is_owner: false, has_maintain: false }),
    });
    expect(await runApply(runner)).toBe(1);
    expect(didAnalyze()).toBe(false);
  });

  it('пустой preflight → ANALYZE не вызывается, код 1', async () => {
    const { runner, didAnalyze } = makeRunner({ preflight: undefined });
    expect(await runApply(runner)).toBe(1);
    expect(didAnalyze()).toBe(false);
  });

  it('ANALYZE упал → код 1', async () => {
    const { runner, didAnalyze } = makeRunner({ preflight: okRow(), analyzeThrows: true });
    expect(await runApply(runner)).toBe(1);
    expect(didAnalyze()).toBe(true);
  });

  it('last_analyze не изменился → код 1, успехом это не считается', async () => {
    const before = '2026-08-14T02:30:00Z';
    const { runner } = makeRunner({
      preflight: okRow({ last_analyze: before }),
      lastAnalyzeAfter: before,
    });
    expect(await runApply(runner)).toBe(1);
  });

  it('last_analyze стал null → код 1', async () => {
    const { runner } = makeRunner({ preflight: okRow(), lastAnalyzeAfter: null });
    expect(await runApply(runner)).toBe(1);
  });

  it('успешная операция → код 0, lock_timeout выставлен до ANALYZE', async () => {
    const { runner, calls } = makeRunner({
      preflight: okRow({ last_analyze: '2026-08-14T02:30:00Z' }),
      lastAnalyzeAfter: '2026-08-14T03:05:00Z',
    });
    expect(await runApply(runner)).toBe(0);
    const lockIdx = calls.findIndex(s => s.startsWith('SET lock_timeout'));
    const analyzeIdx = calls.findIndex(s => s.startsWith('ANALYZE'));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(lockIdx).toBeLessThan(analyzeIdx);
  });
});
