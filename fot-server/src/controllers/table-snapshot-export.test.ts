/**
 * Форма снимка из нескольких таблиц: число листов задаёт сервер, проверки каждой таблицы — те же,
 * что у одиночного снимка (уникальные столбцы, число ячеек, непустые строки).
 */
import { describe, expect, it } from 'vitest';

import { tableSnapshotSchema, tableSnapshotsSchema } from './table-snapshot-export.js';

const table = () => ({
  title: 'Иванов Иван',
  subtitle: '',
  columns: [
    { label: 'Показатель', type: 'text' },
    { label: 'Значение', type: 'money' },
  ],
  rows: [{ cells: ['Оклад, ₽/мес', 100000] }],
});

const firstMessage = (result: { success: boolean; error?: { errors: Array<{ message: string }> } }): string | undefined => (
  result.error?.errors[0]?.message
);

describe('tableSnapshotsSchema', () => {
  it('ровно заданное число таблиц — проходит', () => {
    const result = tableSnapshotsSchema(2).safeParse({ file_name: 'Зарплата.xlsx', sheets: [table(), table()] });
    expect(result.success).toBe(true);
  });

  it('другое число таблиц — «Неверное число листов»', () => {
    for (const sheets of [[table()], [table(), table(), table()]]) {
      const result = tableSnapshotsSchema(2).safeParse({ file_name: 'Зарплата.xlsx', sheets });
      expect(result.success).toBe(false);
      expect(firstMessage(result)).toBe('Неверное число листов');
    }
  });

  it('повтор столбца в одной из таблиц — отказ', () => {
    const bad = { ...table(), columns: [{ label: 'Значение', type: 'text' }, { label: 'Значение', type: 'money' }] };
    const result = tableSnapshotsSchema(2).safeParse({ file_name: 'Зарплата.xlsx', sheets: [table(), bad] });
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toBe('Названия столбцов повторяются');
  });

  it('число ячеек не совпадает со столбцами — отказ', () => {
    const bad = { ...table(), rows: [{ cells: ['Оклад, ₽/мес'] }] };
    const result = tableSnapshotsSchema(2).safeParse({ file_name: 'Зарплата.xlsx', sheets: [bad, table()] });
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toBe('Число ячеек в строке не совпадает с числом столбцов');
  });

  it('пустая таблица и без имени файла — отказ', () => {
    expect(tableSnapshotsSchema(2).safeParse({ file_name: 'x', sheets: [table(), { ...table(), rows: [] }] }).success)
      .toBe(false);
    expect(tableSnapshotsSchema(2).safeParse({ sheets: [table(), table()] }).success).toBe(false);
  });
});

describe('tableSnapshotSchema', () => {
  it('одиночный снимок — по-прежнему с file_name и теми же проверками', () => {
    expect(tableSnapshotSchema.safeParse({ ...table(), file_name: 'Свод.xlsx' }).success).toBe(true);
    expect(tableSnapshotSchema.safeParse(table()).success).toBe(false);
    const duplicated = { ...table(), file_name: 'x', columns: [{ label: 'A', type: 'text' }, { label: 'A', type: 'text' }] };
    expect(firstMessage(tableSnapshotSchema.safeParse(duplicated))).toBe('Названия столбцов повторяются');
  });
});
