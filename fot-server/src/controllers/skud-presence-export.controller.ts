/**
 * СКУД: выгрузка «Сотрудники на объектах» за период.
 *  - GET  /presence-by-object/export-filters      — списки объектов/отделов для модалки;
 *  - POST /presence-by-object/export              — «Списки по дням» (POST из-за массивов ключей);
 *  - POST /presence-by-object/month-stats-export  — «Статистика за месяц».
 *
 * Все эндпоинты read-only: POST исключены из write-through invalidation в роутере.
 */
import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { resolveAccessibleObjectIdsForRequest } from '../services/employee-skud-object-access.service.js';
import { hasPresenceAllObjectsGrant } from '../services/read-scope-grants.service.js';
import { resolveAccessibleEmployeeIds, hasObjectViewScope } from '../services/data-scope.service.js';
import {
  assertExportSize,
  buildFilterOptions,
  collectPresenceExport,
  filterPresenceExport,
  PresenceExportError,
  type IPresenceExportVisibility,
  type PresenceExportErrorCode,
} from '../services/skud-presence-export.service.js';
import { buildPresenceExportWorkbook } from '../services/skud-presence-export-excel.service.js';
import { sanitizeExportFileName } from '../services/skud-export.service.js';
import {
  computePresenceMonthStats,
  formatMonthLabel,
  PresenceMonthStatsError,
  resolveMonthPeriod,
} from '../services/skud-presence-month-stats.service.js';
import { buildPresenceMonthStatsWorkbook } from '../services/skud-presence-month-stats-excel.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';

const ERROR_MESSAGES: Record<PresenceExportErrorCode, string> = {
  INVALID_PERIOD: 'Некорректный период',
  PERIOD_TOO_LONG: 'Период больше 62 дней',
  DATASET_TOO_LARGE: 'Слишком много данных за период — сузьте период',
  EXPORT_TOO_LARGE: 'Слишком много строк — сузьте период или фильтры',
  NO_DATA: 'За выбранный период данных нет',
};

const exportBodySchema = z.object({
  date_from: z.string(),
  date_to: z.string(),
  object_keys: z.array(z.string()).max(1000).optional(),
  group_keys: z.array(z.string()).max(5000).optional(),
});

const monthStatsBodySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  object_keys: z.array(z.string()).max(1000).optional(),
});

const MONTH_STATS_ERRORS: Record<PresenceMonthStatsError['code'], { status: number; message: string }> = {
  INVALID_MONTH: { status: 400, message: 'Некорректный месяц' },
  ARCHIVE_UNKNOWN: { status: 503, message: 'Не удалось определить папку «Уволенные» — попробуйте позже' },
};

const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sendWorkbookBuffer(res: Response, buffer: Buffer, fileName: string): void {
  res.setHeader('Content-Type', XLSX_CONTENT_TYPE);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.send(buffer);
}

/** Скоуп страницы — union из четырёх режимов, а не пересечение (см. getPresenceByObject). */
async function resolveVisibility(req: AuthenticatedRequest): Promise<IPresenceExportVisibility> {
  const scope = await resolveAccessibleObjectIdsForRequest(req);
  // «Сотрудники на объектах — все объекты»: фильтры и Excel видят то же, что экран.
  const isUnrestricted = scope.is_unrestricted || await hasPresenceAllObjectsGrant(req);
  const allowedEmployeeIds = await resolveAccessibleEmployeeIds(req);
  const viewScope = isUnrestricted ? false : await hasObjectViewScope(req);
  return {
    isUnrestricted,
    assignedObjectIds: new Set(isUnrestricted && !scope.is_unrestricted ? [] : scope.object_ids),
    allowedEmployeeIds,
    hasObjectViewScope: viewScope,
  };
}

function sendExportError(res: Response, error: PresenceExportError): void {
  res.status(400).json({ success: false, error: ERROR_MESSAGES[error.code], code: error.code });
}

function formatDateShort(dateStr: string): string {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

/** «все» либо перечисление первых имён — для строки-подзаголовка в книге. */
function buildSelectionLabel(names: string[], selectedCount: number): string {
  if (selectedCount === 0) return 'все';
  const head = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${head} и ещё ${names.length - 5}` : head;
}

export const skudPresenceExportController = {
  /**
   * GET /api/skud/presence-by-object/export-filters?date_from=&date_to=
   * Опции выводятся из того же авторизованного датасета, что и книга — «мёртвых»
   * вариантов не бывает, чужие объекты/отделы не утекают.
   */
  async getPresenceExportFilters(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : '';
      const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : '';
      const visibility = await resolveVisibility(req);
      const days = await collectPresenceExport({ dateFrom, dateTo, visibility });
      // Пустой датасет — это 200 с пустыми списками: модалка не должна падать
      // до нажатия «Скачать».
      res.json({ success: true, data: buildFilterOptions(days) });
    } catch (error) {
      if (error instanceof PresenceExportError) {
        sendExportError(res, error);
        return;
      }
      console.error('Get presence export filters error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения фильтров выгрузки' });
    }
  },

  /**
   * POST /api/skud/presence-by-object/export
   * Тело: { date_from, date_to, object_keys?, group_keys? }. Пустые массивы = все.
   */
  async exportPresenceByObject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = exportBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректные параметры', code: 'INVALID_PARAMS' });
        return;
      }
      const { date_from: dateFrom, date_to: dateTo } = parsed.data;
      const objectKeys = new Set(parsed.data.object_keys ?? []);
      const groupKeys = new Set(parsed.data.group_keys ?? []);

      const visibility = await resolveVisibility(req);
      const dataset = await collectPresenceExport({ dateFrom, dateTo, visibility });
      const filtered = filterPresenceExport(dataset, { objectKeys, groupKeys });

      if (filtered.length === 0) {
        sendExportError(res, new PresenceExportError('NO_DATA', ERROR_MESSAGES.NO_DATA));
        return;
      }
      // Предел применяется ПОСЛЕ фильтров, иначе совет «сузьте фильтры» невыполним.
      assertExportSize(filtered);

      const options = buildFilterOptions(filtered);
      const workbook = buildPresenceExportWorkbook(filtered, {
        dateFrom,
        dateTo,
        objectsLabel: buildSelectionLabel(options.objects.map(o => o.name), objectKeys.size),
        groupsLabel: buildSelectionLabel(options.groups.map(g => g.name), groupKeys.size),
      });

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const fileName = sanitizeExportFileName(
        `Сотрудники_на_объектах_${formatDateShort(dateFrom)}-${formatDateShort(dateTo)}.xlsx`,
      );
      sendWorkbookBuffer(res, buffer, fileName);
    } catch (error) {
      if (error instanceof PresenceExportError) {
        sendExportError(res, error);
        return;
      }
      console.error('Export presence by object error:', error);
      res.status(500).json({ success: false, error: 'Ошибка формирования выгрузки' });
    }
  },

  /**
   * POST /api/skud/presence-by-object/month-stats-export
   * Тело: { month: 'YYYY-MM', object_keys? }. Пустой массив объектов = все.
   * Тот же авторизованный датасет, что у «Списков по дням», — числа объектов совпадают.
   */
  async exportPresenceMonthStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = monthStatsBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректные параметры', code: 'INVALID_PARAMS' });
        return;
      }
      const period = resolveMonthPeriod(parsed.data.month, moscowTodayIso());
      const objectKeys = new Set(parsed.data.object_keys ?? []);

      const visibility = await resolveVisibility(req);
      const dataset = await collectPresenceExport({
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        visibility,
      });
      const filtered = filterPresenceExport(dataset, { objectKeys });
      if (filtered.length === 0) {
        sendExportError(res, new PresenceExportError('NO_DATA', ERROR_MESSAGES.NO_DATA));
        return;
      }

      const stats = await computePresenceMonthStats(filtered, period);
      const monthLabel = formatMonthLabel(period.month);
      const workbook = buildPresenceMonthStatsWorkbook(stats, {
        monthLabel,
        objectsLabel: buildSelectionLabel(stats.objects.map(o => o.name), objectKeys.size),
      });

      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const fileName = sanitizeExportFileName(
        `Сотрудники_на_объектах_${monthLabel.toLowerCase().replace(' ', '_')}.xlsx`,
      );
      sendWorkbookBuffer(res, buffer, fileName);
    } catch (error) {
      if (error instanceof PresenceMonthStatsError) {
        const { status, message } = MONTH_STATS_ERRORS[error.code];
        res.status(status).json({ success: false, error: message, code: error.code });
        return;
      }
      if (error instanceof PresenceExportError) {
        sendExportError(res, error);
        return;
      }
      console.error('Export presence month stats error:', error);
      res.status(500).json({ success: false, error: 'Ошибка формирования выгрузки' });
    }
  },
};
