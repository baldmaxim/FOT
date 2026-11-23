import { describe, expect, it, vi } from 'vitest';
import { uploadQueue, validateScheduleFiles } from './scheduleFileQueue';

describe('uploadQueue', () => {
  it('все загружены — остатка нет, каждый отмечен один раз', async () => {
    const uploaded: string[] = [];
    const result = await uploadQueue(['a', 'b'], async () => undefined, file => uploaded.push(file));
    expect(result).toEqual({ remaining: [], error: null });
    expect(uploaded).toEqual(['a', 'b']);
  });

  it('первый загружен, второй упал: в остатке второй и третий, третий не отправлялся', async () => {
    const uploadOne = vi.fn(async (file: string) => {
      if (file === 'b') throw new Error('Не удалось сохранить файл «b» — попробуйте ещё раз');
    });
    const uploaded: string[] = [];
    const result = await uploadQueue(['a', 'b', 'c'], uploadOne, file => uploaded.push(file));
    expect(result.remaining).toEqual(['b', 'c']);
    expect(result.error).toContain('«b»');
    expect(uploaded).toEqual(['a']);
    expect(uploadOne.mock.calls.map(([file]) => file)).toEqual(['a', 'b']);
  });

  it('повтор по остатку не загружает первый файл второй раз', async () => {
    const server: string[] = [];
    let failB = true;
    const uploadOne = async (file: string) => {
      if (file === 'b' && failB) throw new Error('сбой');
      server.push(file);
    };
    // Очередь, как в окне графика: успешный файл убирается сразу.
    let pending = ['a', 'b', 'c'];
    const drop = (file: string) => { pending = pending.filter(item => item !== file); };

    const first = await uploadQueue(pending, uploadOne, drop);
    pending = first.remaining;
    expect(pending).toEqual(['b', 'c']);

    failB = false;
    const second = await uploadQueue(pending, uploadOne, drop);
    expect(second).toEqual({ remaining: [], error: null });
    expect(pending).toEqual([]);
    expect(server).toEqual(['a', 'b', 'c']);
  });
});

describe('validateScheduleFiles', () => {
  const file = (name: string, size = 100): File => new File([new Uint8Array(size)], name);

  it('разрешённые типы, в том числе в верхнем регистре', () => {
    expect(validateScheduleFiles([file('Приказ.PDF'), file('график.xlsx'), file('скан.jpeg')], 0)).toBeNull();
  });

  it('тип не из списка', () => {
    expect(validateScheduleFiles([file('заметка.txt')], 0)).toContain('можно PDF');
  });

  it('больше 25 МБ и пустой', () => {
    expect(validateScheduleFiles([file('big.pdf', 25 * 1024 * 1024 + 1)], 0)).toContain('больше 25 МБ');
    expect(validateScheduleFiles([file('empty.pdf', 0)], 0)).toContain('пустой');
  });

  it('предел 20 — с учётом уже прикреплённых', () => {
    expect(validateScheduleFiles([file('a.pdf')], 19)).toBeNull();
    expect(validateScheduleFiles([file('a.pdf'), file('b.pdf')], 19)).toContain('не больше 20');
  });
});
