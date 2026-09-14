import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessSubscribersService, type IMySimNumber } from '../services/mts-business-subscribers.service.js';
import { mtsBusinessStatementRowsService, parseUsagePeriod, USAGE_ROWS_LIMIT } from '../services/mts-business-statement-rows.service.js';
import { mtsBusinessMetricsStoreService } from '../services/mts-business-metrics-store.service.js';
import { mtsBusinessCatalogService, type IMtsForwardingRule } from '../services/mts-business-catalog.service.js';
import { mtsBusinessActionsService } from '../services/mts-business-actions.service.js';
import { MtsBusinessApiError } from '../services/mts-business-base.service.js';
import { msisdnHash, normalizeMsisdn } from '../services/mts-business-cdr.service.js';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  FORWARDING_TYPES,
  validateForwardingTarget,
  resolveNoReplyTimer,
} from '../services/mts-forwarding.shared.js';
import { mtsForwardingOperationsService as forwardingOps } from '../services/mts-forwarding-operations.service.js';
import {
  hasForwardingService,
  sendServiceRequest,
  RULE_STAGE_DEADLINE_SECONDS,
  SERVICE_STAGE_DEADLINE_SECONDS,
} from '../services/mts-forwarding-operations.runner.js';
import { runRuleCyclesNow } from '../services/mts-forwarding-operations.flow.js';
import {
  sendOperationConflictOrPending,
  sendOperationResult,
  toOperationDto,
} from '../services/mts-forwarding-operations.response.js';

// ЛК сотрудника: «Моя SIM» + «Телефонная книга». Номер резолвится ТОЛЬКО из
// req.user.employee_id (msisdn в параметрах не принимается) — сотрудник видит
// только свои номера. Всё из БД (ночное «Обновить всё»), живых вызовов МТС нет.
// ПДн (паспорт/ДР/юр.ФИО) и баланс лицевого счёта компании не отдаются
// (getMySimSummary эти поля физически не читает).
//
// Единственное исключение из read-only — переадресация: сотрудник сам включает
// её на своём номере (write-вызов МТС ChangeCallForwarding). Защита: право edit
// на /employee/sim (рубильник у админа), квота изменений в БД, аудит, и msisdn из
// запроса обязан принадлежать этому сотруднику.

/**
 * Объём интернета тарифа для полосы остатка в «Моя SIM». В ValidityInfo МТС
 * счётчика интернета у тарифов «Умный бизнес» нет вовсе (безлимит по факту
 * ограничен пакетом) — объём задан вручную, остаток считаем как квота минус
 * трафик из выписки за текущий биллинг-период номера.
 */
const MY_SIM_INTERNET_QUOTA_BYTES = 30_000_000_000; // 30 ГБ

/**
 * Псевдо-пакет «Интернет»: если у номера нет BYTE-счётчика с остатком,
 * возвращаем строку «30 ГБ минус потрачено». Период — биллинг-цикл номера из
 * validFrom тарифного пакета минут/SMS, fallback — календарный месяц.
 */
const buildInternetPackage = async (
  summary: IMySimNumber,
  hash: string,
): Promise<IMySimNumber['packages'][number] | null> => {
  const pkgs = summary.packages ?? [];
  if (pkgs.some(p => p.unitOfMeasure === 'BYTE' && (p.remainder ?? 0) > 0)) return null;
  const today = moscowTodayIso();
  const cycle = pkgs.find(p =>
    p.name != null && p.validFrom != null && p.validTo != null
    && moscowTodayIso(new Date(p.validFrom)) <= today
    && moscowTodayIso(new Date(p.validTo)) >= today);
  const dateFrom = cycle?.validFrom ? moscowTodayIso(new Date(cycle.validFrom)) : `${today.slice(0, 7)}-01`;
  const totals = await mtsBusinessStatementRowsService.getUsageTotals(hash, dateFrom, today);
  const consumed = totals.groups.find(g => g.key === 'internet')?.bytes ?? 0;
  return {
    name: 'Интернет',
    unitOfMeasure: 'BYTE',
    quota: MY_SIM_INTERNET_QUOTA_BYTES,
    remainder: Math.max(0, MY_SIM_INTERNET_QUOTA_BYTES - consumed),
    consumption: consumed,
    rotate: null,
    validFrom: cycle?.validFrom ?? null,
    validTo: cycle?.validTo ?? null,
  };
};

const fail = (res: Response, error: unknown, fallback: string): void => {
  // Причину от МТС наверх отдаём (как в админском контуре): без неё сотрудник
  // видит только общий текст и не понимает, что именно отклонил оператор.
  if (error instanceof MtsBusinessApiError) {
    console.error(`[employee-sim] upstream error: http=${error.status} code=${error.code ?? '-'}`);
    Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'employee-sim-upstream' } });
    res.status(502).json({ success: false, error: fallback, mtsHttp: error.status, mtsMessage: error.message });
    return;
  }
  console.error(`[employee-sim] ${fallback}:`, error instanceof Error ? error.message : 'unknown');
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'employee-sim' } });
  res.status(500).json({ success: false, error: fallback });
};

const setForwardingSchema = z.object({
  msisdn: z.string().trim().min(1).optional(),
  type: z.enum(FORWARDING_TYPES),
  target: z.string().trim().min(1),
  timer: z.coerce.number().int().min(5).max(30).optional(),
});

const deleteForwardingSchema = z.object({
  msisdn: z.string().trim().min(1).optional(),
  type: z.enum(FORWARDING_TYPES),
});

/** Номера сотрудника + проверка, что запрошенный msisdn — его. Иначе 403/400. */
const resolveOwnMsisdn = async (
  req: AuthenticatedRequest,
  res: Response,
  requested?: string,
): Promise<string | null> => {
  const employeeId = req.user.employee_id;
  const own = employeeId ? await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId) : [];
  if (own.length === 0) {
    res.status(400).json({ success: false, error: 'За вами не закреплён корпоративный номер' });
    return null;
  }
  if (!requested) return own[0];
  const norm = normalizeMsisdn(requested);
  const match = own.find(m => normalizeMsisdn(m) === norm);
  if (!match) {
    res.status(403).json({ success: false, error: 'Номер не закреплён за вами' });
    return null;
  }
  return match;
};

const SET_FAIL_TITLE = 'Не удалось включить переадресацию';
const REMOVE_FAIL_TITLE = 'Не удалось отключить переадресацию';

/** Свой номер, сотрудник, ЛС и хэш — всё, что нужно операции. Иначе ответ уже отправлен. */
const resolveOperationContext = async (
  req: AuthenticatedRequest,
  res: Response,
  requested?: string,
): Promise<{ msisdn: string; employeeId: number; accountId: string; hash: string } | null> => {
  const msisdn = await resolveOwnMsisdn(req, res, requested);
  if (!msisdn) return null;
  const employeeId = req.user.employee_id;
  const accountId = (await mtsBusinessMappingService.getSubscriberContext(msisdn))?.accountId ?? null;
  const hash = msisdnHash(msisdn);
  if (!employeeId || !accountId || !hash) {
    res.status(400).json({ success: false, error: 'Не удалось определить лицевой счёт номера' });
    return null;
  }
  return { msisdn, employeeId, accountId, hash };
};

export const employeeSimController = {
  /** Номера сотрудника — строка «Телефон» в блоке «Информация» на главной ЛК. */
  async getMyNumbers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({ success: true, data: { numbers: [] } });
        return;
      }
      const numbers = await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId);
      res.json({ success: true, data: { numbers } });
    } catch (error) {
      fail(res, error, 'Ошибка получения номера телефона');
    }
  },

  /** «Моя SIM»: тариф/абонплата/пакеты/услуги/начисления по каждому своему номеру. */
  async getMySim(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({ success: true, data: { numbers: [] } });
        return;
      }
      const msisdns = await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId);
      const numbers: Array<IMySimNumber & { months: string[] }> = [];
      for (const msisdn of msisdns) {
        const summary = await mtsBusinessSubscribersService.getMySimSummary(msisdn);
        if (!summary) continue;
        const hash = msisdnHash(msisdn);
        const months = hash ? await mtsBusinessStatementRowsService.getMonthsWithData(hash) : [];
        const internet = hash ? await buildInternetPackage(summary, hash) : null;
        if (internet) summary.packages = [...(summary.packages ?? []), internet];
        numbers.push({ ...summary, months });
      }
      res.json({ success: true, data: { numbers } });
    } catch (error) {
      fail(res, error, 'Ошибка получения данных SIM');
    }
  },

  /**
   * Выписка по своим номерам за месяц/день — из БД. Строки капятся сервисом
   * (3000), итог считается по дневным агрегатам (полная сумма периода).
   */
  async getMyUsage(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const period = parseUsagePeriod(String(req.query.month || '').trim(), String(req.query.date || '').trim());
      if (!period) {
        res.status(400).json({ success: false, error: 'Укажите month=YYYY-MM или date=YYYY-MM-DD' });
        return;
      }
      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({ success: true, data: { month: period.period, numbers: [] } });
        return;
      }
      const msisdns = await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId);
      if (msisdns.length === 0) {
        res.json({ success: true, data: { month: period.period, numbers: [] } });
        return;
      }
      // Собеседник — конкретный абонент, если его номер есть в нашей базе.
      const names = await mtsBusinessMappingService.getNamesByMsisdnHash();
      const numbers = [];
      for (const msisdn of msisdns) {
        const hash = msisdnHash(msisdn);
        if (!hash) continue;
        const [stored, days, totals] = await Promise.all([
          mtsBusinessStatementRowsService.getUsageRows(hash, period.dateFrom, period.dateTo),
          mtsBusinessStatementRowsService.getDailyStats(hash, period.dateFrom, period.dateTo),
          mtsBusinessStatementRowsService.getUsageTotals(hash, period.dateFrom, period.dateTo),
        ]);
        const rows = stored.map(({ peerHash, ...r }) => ({
          ...r,
          peerName: peerHash ? names.get(peerHash) ?? null : null,
        }));
        // total и плитки — по SQL-агрегату (не по обрезанным cap'ом строкам):
        // ровно те же числа отдаёт админский /subscribers/:msisdn/usage.
        numbers.push({ msisdn, rows, total: totals.total, days, totals, truncated: rows.length >= USAGE_ROWS_LIMIT });
      }
      res.json({ success: true, data: { month: period.period, numbers } });
    } catch (error) {
      fail(res, error, 'Ошибка получения выписки');
    }
  },

  /** Текущие правила переадресации по своим номерам — из ночного снапшота (без живых вызовов). */
  async getMyForwarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const employeeId = req.user.employee_id;
      if (!employeeId) {
        res.json({ success: true, data: { numbers: [] } });
        return;
      }
      const msisdns = await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId);
      const numbers = [];
      for (const msisdn of msisdns) {
        const snap = await mtsBusinessMetricsStoreService.getLatestSnapshotForMsisdn(msisdn, 'forwarding');
        const rules = Array.isArray(snap?.payload) ? (snap.payload as IMtsForwardingRule[]) : [];
        numbers.push({ msisdn, rules, capturedAt: snap?.capturedAt ?? null });
      }
      res.json({ success: true, data: { numbers } });
    } catch (error) {
      fail(res, error, 'Ошибка получения переадресации');
    }
  },

  /**
   * Включить/сменить режим переадресации своего номера через серверную операцию
   * (mts-forwarding-operations.*): при отсутствии услуги PE0250 портал сам её
   * подключает; мешающие правила других типов снимаются, выбранное ставится и
   * подтверждается режимом целиком. Первые шаги — здесь, остальное доводит воркер.
   */
  async setMyForwarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = setForwardingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const ctx = await resolveOperationContext(req, res, parsed.data.msisdn);
      if (!ctx) return;

      const target = validateForwardingTarget(parsed.data.target, ctx.msisdn);
      if (!target.ok) {
        res.status(400).json({ success: false, error: target.error });
        return;
      }
      const type = parsed.data.type;
      const intent = {
        kind: 'set' as const, forwardingType: type, target: target.value,
        noReplyTimer: resolveNoReplyTimer(type, parsed.data.timer) ?? null,
      };

      // Незавершённая операция по номеру — новых внешних вызовов нет.
      const existing = await forwardingOps.getActive(ctx.accountId, ctx.hash);
      if (existing) {
        sendOperationConflictOrPending(res, existing, intent, SET_FAIL_TITLE);
        return;
      }

      let services;
      try {
        services = await mtsBusinessCatalogService.getProductInfo(ctx.accountId, ctx.msisdn);
      } catch (error) {
        console.warn(`[employee-sim] услуги номера не прочитаны: ${error instanceof MtsBusinessApiError ? error.status : 'unknown'}`);
        res.status(503).json({ success: false, error: 'Не удалось проверить услуги номера в МТС. Попробуйте через несколько минут' });
        return;
      }
      const serviceActive = hasForwardingService(services);

      const { operation, created } = await forwardingOps.reserve({
        accountId: ctx.accountId, msisdn: ctx.msisdn, employeeId: ctx.employeeId, requestedBy: req.user.id, ...intent,
        initialState: serviceActive ? 'rule_ready' : 'service_reserved',
        deadlineSeconds: serviceActive ? RULE_STAGE_DEADLINE_SECONDS : SERVICE_STAGE_DEADLINE_SECONDS,
      });
      if (!created) {
        sendOperationConflictOrPending(res, operation, intent, SET_FAIL_TITLE);
        return;
      }

      const owner = `http:${randomUUID()}`;
      // Два синхронных цикла: например, снять CFU → поставить CFNRY; дальше — воркер.
      const op = serviceActive
        ? await runRuleCyclesNow(operation, owner, ctx.msisdn, 2)
        : await sendServiceRequest(operation, owner, ctx.msisdn);
      sendOperationResult(res, op, SET_FAIL_TITLE);
    } catch (error) {
      fail(res, error, 'Ошибка включения переадресации');
    }
  },

  /** Операция переадресации своего номера (незавершённая или последняя за сутки) — для модалки. */
  async getMyForwardingOperation(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const requested = typeof req.query.msisdn === 'string' ? req.query.msisdn : undefined;
      const msisdn = await resolveOwnMsisdn(req, res, requested);
      if (!msisdn) return;
      const op = await forwardingOps.getActiveOrRecent(msisdn);
      res.json({ success: true, data: op ? toOperationDto(op) : null });
    } catch (error) {
      fail(res, error, 'Ошибка получения статуса переадресации');
    }
  },

  /**
   * Отключить переадресацию своего номера — та же операция (kind=remove): частичный
   * UNIQUE номера исключает пересечение с включением из другой вкладки, квота общая.
   * Снимаются все активные правила поддерживаемых типов (CFB не трогаем).
   */
  async deleteMyForwarding(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = deleteForwardingSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ success: false, error: 'Некорректный запрос', details: parsed.error.flatten() });
        return;
      }
      const ctx = await resolveOperationContext(req, res, parsed.data.msisdn);
      if (!ctx) return;
      const intent = { kind: 'remove' as const, forwardingType: parsed.data.type, target: null, noReplyTimer: null };

      const { operation, created } = await forwardingOps.reserve({
        accountId: ctx.accountId, msisdn: ctx.msisdn, employeeId: ctx.employeeId, requestedBy: req.user.id, ...intent,
        initialState: 'rule_ready', deadlineSeconds: RULE_STAGE_DEADLINE_SECONDS,
      });
      if (!created) {
        sendOperationConflictOrPending(res, operation, intent, REMOVE_FAIL_TITLE);
        return;
      }
      const op = await runRuleCyclesNow(operation, `http:${randomUUID()}`, ctx.msisdn, 3);
      sendOperationResult(res, op, REMOVE_FAIL_TITLE);
    } catch (error) {
      fail(res, error, 'Ошибка отключения переадресации');
    }
  },

  /** Статус своей заявки на переадресацию (поллинг из UI до completed). */
  async getMyForwardingStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const eventId = String(req.query.eventId || '').trim();
      if (!eventId) {
        res.status(400).json({ success: false, error: 'Укажите eventId' });
        return;
      }
      const employeeId = req.user.employee_id;
      const own = employeeId ? await mtsBusinessMappingService.getMsisdnsByEmployeeId(employeeId) : [];
      const ownHashes = new Set(own.map(m => msisdnHash(m)).filter((h): h is string => Boolean(h)));

      const row = await mtsBusinessActionsService.getByEventId(eventId);
      // Заявка чужая (или не по номеру сотрудника) — не подтверждаем её существование.
      if (!row || !row.msisdnHash || !ownHashes.has(row.msisdnHash)) {
        res.status(404).json({ success: false, error: 'Заявка не найдена' });
        return;
      }
      res.json({ success: true, data: { eventId: row.eventId, status: row.status, actionType: row.actionType } });
    } catch (error) {
      fail(res, error, 'Ошибка получения статуса заявки');
    }
  },

  /** «Телефонная книга»: привязанные номера активных сотрудников (номер/ФИО/должность/отдел). */
  async getPhonebook(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const rows = await mtsBusinessMappingService.getPhonebook();
      res.json({ success: true, data: { rows } });
    } catch (error) {
      fail(res, error, 'Ошибка получения телефонной книги');
    }
  },
};
