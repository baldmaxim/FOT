import type { Response } from 'express';
import * as Sentry from '@sentry/node';
import type { AuthenticatedRequest } from '../types/index.js';
import { mtsBusinessMappingService } from '../services/mts-business-mapping.service.js';
import { mtsBusinessSubscribersService, type IMySimNumber } from '../services/mts-business-subscribers.service.js';
import { mtsBusinessStatementRowsService, parseUsagePeriod } from '../services/mts-business-statement-rows.service.js';
import { msisdnHash } from '../services/mts-business-cdr.service.js';

// ЛК сотрудника: «Моя SIM» + «Телефонная книга». Номер резолвится ТОЛЬКО из
// req.user.employee_id (msisdn в параметрах не принимается) — сотрудник видит
// только свои номера. Всё из БД (ночное «Обновить всё»), живых вызовов МТС нет.
// ПДн (паспорт/ДР/юр.ФИО) и баланс лицевого счёта компании не отдаются
// (getMySimSummary эти поля физически не читает).

const fail = (res: Response, error: unknown, fallback: string): void => {
  console.error(`[employee-sim] ${fallback}:`, error instanceof Error ? error.message : 'unknown');
  Sentry.captureException(error, { tags: { module: 'mts-business', kind: 'employee-sim' } });
  res.status(500).json({ success: false, error: fallback });
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
        const [stored, days] = await Promise.all([
          mtsBusinessStatementRowsService.getUsageRows(hash, period.dateFrom, period.dateTo),
          mtsBusinessStatementRowsService.getDailyStats(hash, period.dateFrom, period.dateTo),
        ]);
        const rows = stored.map(({ peerHash, ...r }) => ({
          ...r,
          peerName: peerHash ? names.get(peerHash) ?? null : null,
        }));
        const total = days.reduce((a, d) => a + d.amount, 0);
        numbers.push({ msisdn, rows, total, days });
      }
      res.json({ success: true, data: { month: period.period, numbers } });
    } catch (error) {
      fail(res, error, 'Ошибка получения выписки');
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
