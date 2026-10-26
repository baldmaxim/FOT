import type { Response } from 'express';
import ExcelJS from 'exceljs';
import { z } from 'zod';

import {
  addTableSnapshotSheet,
  buildTableSnapshotWorkbook,
  type ITableSnapshotSheet,
} from '../services/table-snapshot-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';

/**
 * Лимиты снимка: клиентские таблицы — десятки строк, запас — на рост справочника, но не на
 * «выгрузку произвольной таблицы». Самая широкая — сотрудники объекта в «Своде» «Зарплаты»: №, ФИО,
 * отдел, должность, категория, «К выплате», «Всего начислено», «Всего удержано», 39 статей «Оплачено»
 * (миграция 326) — 47 столбцов.
 */
export const TABLE_SNAPSHOT_MAX_COLUMNS = 50;
export const TABLE_SNAPSHOT_MAX_ROWS = 1000;

const cellSchema = z.union([z.string().max(300), z.number().finite(), z.null()]);

/** Таблица снимка без имени файла: лист книги. */
const snapshotTableShape = {
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300),
  columns: z
    .array(z.object({
      label: z.string().trim().min(1).max(60),
      type: z.enum(['text', 'money', 'percent', 'int']),
    }))
    .min(1)
    .max(TABLE_SNAPSHOT_MAX_COLUMNS),
  rows: z
    .array(z.object({ cells: z.array(cellSchema), muted: z.boolean().optional() }))
    .min(1, 'Нет строк для выгрузки')
    .max(TABLE_SNAPSHOT_MAX_ROWS, 'Слишком много строк для выгрузки'),
};

const fileNameSchema = z.string().trim().min(1).max(150);

/** Проверки таблицы, которые не выразить формой: superRefine, чтобы базовый объект оставался расширяемым. */
const checkSnapshotTable = (
  value: { columns: ReadonlyArray<{ label: string }>; rows: ReadonlyArray<{ cells: ReadonlyArray<unknown> }> },
  ctx: z.RefinementCtx,
): void => {
  // Имена столбцов умной таблицы Excel обязаны быть уникальными, иначе файл не откроется.
  if (new Set(value.columns.map((column) => column.label)).size !== value.columns.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Названия столбцов повторяются' });
  }
  if (!value.rows.every((row) => row.cells.length === value.columns.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Число ячеек в строке не совпадает с числом столбцов' });
  }
};

const snapshotTableSchema = z.object(snapshotTableShape).superRefine(checkSnapshotTable);

export const tableSnapshotSchema = z
  .object({ ...snapshotTableShape, file_name: fileNameSchema })
  .superRefine(checkSnapshotTable);

/** Снимок из нескольких таблиц — по листу на каждую, число таблиц задаёт вызывающий. */
export const tableSnapshotsSchema = (sheetCount: number) => z.object({
  file_name: fileNameSchema,
  sheets: z.array(snapshotTableSchema).length(sheetCount, 'Неверное число листов'),
});

/** Книга → xlsx в ответ; имя файла очищается от служебных символов, расширение — ровно одно. */
async function sendWorkbookXlsx(res: Response, workbook: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const safeName = `${sanitizeExportFileName(fileName.replace(/\.xlsx$/i, ''))}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
  );
  res.send(buffer);
}

/**
 * Снимок таблицы экрана → xlsx в ответ. Некорректный снимок — ZodError, его ответ (400)
 * оформляет вызывающий контроллер.
 */
export async function sendTableSnapshotXlsx(
  res: Response,
  body: unknown,
  sheet: ITableSnapshotSheet,
): Promise<void> {
  const payload = tableSnapshotSchema.parse(body);
  await sendWorkbookXlsx(res, buildTableSnapshotWorkbook(payload, sheet), payload.file_name);
}

/**
 * Несколько таблиц экрана → одна книга, таблица на лист в порядке sheets. Таблиц в снимке —
 * ровно sheets.length; иначе ZodError (400 оформляет вызывающий контроллер).
 */
export async function sendTableSnapshotsXlsx(
  res: Response,
  body: unknown,
  sheets: ReadonlyArray<ITableSnapshotSheet>,
): Promise<void> {
  const payload = tableSnapshotsSchema(sheets.length).parse(body);
  const workbook = new ExcelJS.Workbook();
  payload.sheets.forEach((table, index) => addTableSnapshotSheet(workbook, table, sheets[index]));
  await sendWorkbookXlsx(res, workbook, payload.file_name);
}
