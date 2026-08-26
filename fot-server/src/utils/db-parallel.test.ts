import { describe, expect, it } from 'vitest';
import { runMaybeParallel } from './db-parallel.js';
import type { DbExecutor } from '../config/postgres.js';

/**
 * pg не допускает конкурентных запросов на одном соединении (в pg@9 — deprecated
 * с предупреждением в лог). Хелпер сериализует группу запросов под клиентом
 * транзакции и сохраняет параллельность на пуле, где она нужна для скорости
 * интерактивного табеля и Excel-выгрузок.
 */

/** Фиктивный клиент: важен только факт его наличия. */
const FAKE_CLIENT = { query: async () => ({ rows: [] }) } as unknown as DbExecutor;

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Трассировка стартов/финишей — по ней видно, перекрывались вызовы или нет. */
function tracked(trace: string[], name: string, ms: number, value: unknown) {
  return async () => {
    trace.push(`${name}:start`);
    await delay(ms);
    trace.push(`${name}:end`);
    return value;
  };
}

describe('runMaybeParallel', () => {
  it('без exec выполняет параллельно — вызовы перекрываются', async () => {
    const trace: string[] = [];
    await runMaybeParallel(
      undefined,
      tracked(trace, 'a', 20, 1),
      tracked(trace, 'b', 5, 2),
    );

    // b стартует до того, как завершится a.
    expect(trace.indexOf('b:start')).toBeLessThan(trace.indexOf('a:end'));
    // И финиширует раньше — значит ждали не по очереди.
    expect(trace.indexOf('b:end')).toBeLessThan(trace.indexOf('a:end'));
  });

  it('с exec выполняет строго последовательно', async () => {
    const trace: string[] = [];
    await runMaybeParallel(
      FAKE_CLIENT,
      tracked(trace, 'a', 20, 1),
      tracked(trace, 'b', 5, 2),
    );

    expect(trace).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('порядок результатов соответствует порядку аргументов в обоих режимах', async () => {
    // Медленный первый, быстрый второй — если бы порядок терялся, здесь бы всплыло.
    const pool = await runMaybeParallel(
      undefined,
      async () => { await delay(15); return 'first'; },
      async () => 'second',
    );
    const client = await runMaybeParallel(
      FAKE_CLIENT,
      async () => { await delay(15); return 'first'; },
      async () => 'second',
    );

    expect(pool).toEqual(['first', 'second']);
    expect(client).toEqual(['first', 'second']);
  });

  it('сохраняет типы каждого элемента', async () => {
    const [rows, count, flag] = await runMaybeParallel(
      FAKE_CLIENT,
      async () => [{ id: 1 }],
      async () => 42,
      async () => true,
    );

    expect(rows[0]!.id).toBe(1);
    expect(count + 1).toBe(43);
    expect(flag).toBe(true);
  });

  it('ошибка пробрасывается в обоих режимах', async () => {
    await expect(runMaybeParallel(
      undefined,
      async () => 1,
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');

    await expect(runMaybeParallel(
      FAKE_CLIENT,
      async () => 1,
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
  });

  it('под клиентом после ошибки следующий запрос не стартует', async () => {
    // Иначе он ушёл бы в уже сломанную транзакцию.
    const trace: string[] = [];
    await expect(runMaybeParallel(
      FAKE_CLIENT,
      async () => { throw new Error('boom'); },
      tracked(trace, 'after', 1, 2),
    )).rejects.toThrow('boom');

    expect(trace).toEqual([]);
  });

  it('пустой список — пустой результат', async () => {
    expect(await runMaybeParallel(FAKE_CLIENT)).toEqual([]);
    expect(await runMaybeParallel(undefined)).toEqual([]);
  });
});
