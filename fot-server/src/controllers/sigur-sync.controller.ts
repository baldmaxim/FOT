import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import {
  syncOrganizationsLogic,
  cleanDuplicateOrganizationsLogic,
  syncDepartmentsLogic,
  syncPositionsFromSigurLogic,
  seedPositionsLogic,
  syncEmployeesLogic,
} from '../services/sigur-sync.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const sigurSyncController = {
  /**
   * POST /api/sigur/sync
   * Синхронизация событий из Sigur в skud_events (SSE)
   */
  async sync(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sendProgress = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      sendProgress({ type: 'status', message: 'Загрузка сотрудников...' });

      // 1. Загружаем ВСЕХ сотрудников (маппинг по ФИО + по sigur_employee_id)
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, organization_id, full_name_encrypted, sigur_employee_id')
        .eq('is_archived', false);

      const employeeMap = new Map<string, { id: number; organization_id: string }>();
      const sigurIdMap = new Map<number, { id: number; organization_id: string }>();
      for (const emp of employeesData || []) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
        const empRef = { id: emp.id, organization_id: emp.organization_id };
        if (!employeeMap.has(name)) {
          employeeMap.set(name, empRef);
        }
        if (emp.sigur_employee_id != null) {
          sigurIdMap.set(emp.sigur_employee_id, empRef);
        }
      }

      // Fallback org_id
      const userOrgId = req.user.organization_id || req.body.organization_id || null;
      let fallbackOrgId = userOrgId;
      if (!fallbackOrgId) {
        const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
        fallbackOrgId = orgs?.[0]?.id || null;
      }

      // 2. Генерируем список дней
      const days: string[] = [];
      const cur = new Date(startDate);
      const end = new Date(endDate);
      while (cur <= end) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
      }

      const errors: string[] = [];
      let totalSigur = 0;
      let totalInserted = 0;
      let totalSkipped = 0;
      const summariesToUpdate = new Set<string>();

      sendProgress({ type: 'start', totalDays: days.length, employees: employeeMap.size });

      // 3. Обрабатываем по одному дню
      for (let dayIdx = 0; dayIdx < days.length; dayIdx++) {
        const day = days[dayIdx];
        const dayStart = `${day}T00:00:00`;
        const dayEnd = `${day}T23:59:59`;

        sendProgress({
          type: 'day_start',
          day,
          dayIndex: dayIdx,
          totalDays: days.length,
          percent: Math.round((dayIdx / days.length) * 100),
        });

        const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED', { pageSize: 3000 });
        totalSigur += rawEvents.length;

        if (rawEvents.length === 0) {
          sendProgress({ type: 'day_done', day, dayIndex: dayIdx, events: 0, inserted: 0, skipped: 0 });
          continue;
        }

        // Дедупликация
        const { data: existingEvents } = await supabase
          .from('skud_events')
          .select('physical_person_encrypted, event_date, event_time')
          .eq('event_date', day);

        const existingSet = new Set<string>();
        for (const evt of existingEvents || []) {
          const name = encryptionService.decrypt(evt.physical_person_encrypted).toLowerCase().trim();
          existingSet.add(`${name}|${evt.event_date}|${evt.event_time}`);
        }

        const dayInserts: {
          organization_id: string;
          physical_person_encrypted: string;
          card_number_encrypted: string | null;
          event_date: string;
          event_time: string;
          access_point: string | null;
          direction: 'entry' | 'exit' | null;
          employee_id: number | null;
        }[] = [];
        let daySkipped = 0;

        for (const raw of rawEvents) {
          const mapped = mapSigurEvent(raw as Record<string, unknown>);
          if (!mapped) continue;

          const nameKey = mapped.physicalPerson.toLowerCase().trim();
          const dedupKey = `${nameKey}|${mapped.eventDate}|${mapped.eventTime}`;
          if (existingSet.has(dedupKey)) {
            totalSkipped++;
            daySkipped++;
            continue;
          }
          existingSet.add(dedupKey);

          const emp = (mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined)
            || employeeMap.get(nameKey);
          const orgId = emp?.organization_id || fallbackOrgId;
          if (!orgId) continue;

          dayInserts.push({
            organization_id: orgId,
            physical_person_encrypted: encryptionService.encrypt(mapped.physicalPerson),
            card_number_encrypted: mapped.cardNumber ? encryptionService.encrypt(mapped.cardNumber) : null,
            event_date: mapped.eventDate,
            event_time: mapped.eventTime,
            access_point: mapped.accessPoint,
            direction: mapped.direction,
            employee_id: emp?.id || null,
          });

          if (emp) {
            summariesToUpdate.add(`${emp.id}:${orgId}:${mapped.eventDate}`);
          }
        }

        // Вставляем батчами
        const BATCH_SIZE = 500;
        let dayInserted = 0;
        for (let i = 0; i < dayInserts.length; i += BATCH_SIZE) {
          const batch = dayInserts.slice(i, i + BATCH_SIZE);
          const { error: insertError } = await supabase.from('skud_events').insert(batch);
          if (insertError) {
            errors.push(`[${day}] Ошибка вставки: ${insertError.message}`);
          } else {
            dayInserted += batch.length;
            totalInserted += batch.length;
          }
        }

        sendProgress({
          type: 'day_done',
          day,
          dayIndex: dayIdx,
          events: rawEvents.length,
          inserted: dayInserted,
          skipped: daySkipped,
          totalInserted,
          totalSkipped,
          percent: Math.round(((dayIdx + 1) / days.length) * 100),
        });
      }

      // 4. Пересчитываем сводки
      if (summariesToUpdate.size > 0) {
        sendProgress({ type: 'status', message: 'Пересчёт сводок...' });
        for (const key of summariesToUpdate) {
          const [empId, orgId, date] = key.split(':');
          await supabase.rpc('recalculate_skud_daily_summary', {
            p_organization_id: orgId,
            p_employee_id: parseInt(empId, 10),
            p_date: date,
          });
        }
      }

      // 5. Аудит
      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          sigurTotal: totalSigur,
          imported: totalInserted,
          skipped: totalSkipped,
          errors: errors.length,
          matchedEmployees: summariesToUpdate.size,
          dateRange: { startDate, endDate },
        },
      });

      sendProgress({
        type: 'done',
        imported: totalInserted,
        skipped: totalSkipped,
        matched: summariesToUpdate.size,
        errors,
        sigurTotal: totalSigur,
      });

      res.end();
    } catch (error) {
      console.error('Sigur sync error:', error);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Ошибка синхронизации данных из Sigur' })}\n\n`);
        res.end();
      } catch { /* headers already sent */ }
    }
  },

  /**
   * POST /api/sigur/sync-employees
   * Импорт сотрудников из Sigur в БД с привязкой к подразделениям и должностям
   */
  async syncEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }
      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const result = await syncEmployeesLogic(organizationId, connection);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur syncEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта сотрудников из Sigur' });
    }
  },

  /**
   * POST /api/sigur/sync-departments
   * Импорт отделов из Sigur в org_departments с иерархией (parent_id)
   */
  async syncDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }
      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const result = await syncDepartmentsLogic(organizationId, connection);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur syncDepartments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта отделов из Sigur' });
    }
  },

  /**
   * POST /api/sigur/sync-positions
   * Импорт должностей из Sigur в positions таблицу
   */
  async syncPositions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }
      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const result = await syncPositionsFromSigurLogic(organizationId, connection);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur syncPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта должностей из Sigur' });
    }
  },

  /**
   * POST /api/sigur/sync-all
   * Полная синхронизация структуры из Sigur (SSE)
   * Последовательность: организации → дубли → отделы → должности → сотрудники
   */
  async syncAll(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      let organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        const { data: orgs } = await supabase.from('organizations').select('id').limit(1);
        organizationId = orgs?.[0]?.id || null;
      }
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const sendProgress = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      const steps = [
        { id: 1, name: 'organizations', label: 'Импорт организаций', fn: () => syncOrganizationsLogic(connection) },
        { id: 2, name: 'clean-duplicates', label: 'Очистка дублей', fn: () => cleanDuplicateOrganizationsLogic() },
        { id: 3, name: 'departments', label: 'Импорт отделов (иерархия)', fn: () => syncDepartmentsLogic(organizationId, connection) },
        { id: 4, name: 'positions', label: 'Импорт должностей', fn: async () => {
          const fromSigur = await syncPositionsFromSigurLogic(organizationId, connection);
          const seeded = await seedPositionsLogic(organizationId);
          return { ...fromSigur, seeded: seeded.created };
        }},
        { id: 5, name: 'employees', label: 'Импорт сотрудников', fn: () => syncEmployeesLogic(organizationId, connection) },
      ];

      const results: Record<string, unknown> = {};

      for (const step of steps) {
        sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'running' });
        try {
          const result = await step.fn();
          results[step.name] = result;
          sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'done', result });
        } catch (error) {
          const message = (error as Error).message;
          results[step.name] = { error: message };
          sendProgress({ type: 'step', step: step.id, name: step.name, label: step.label, status: 'error', error: message });
        }
      }

      // Аудит
      await auditService.logFromRequest(req, req.user.id, 'SYNC_ALL_SIGUR', {
        details: { results },
      });

      sendProgress({ type: 'done', results });
      res.end();
    } catch (error) {
      console.error('Sigur syncAll error:', error);
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Ошибка полной синхронизации' })}\n\n`);
        res.end();
      } catch { /* headers already sent */ }
    }
  },
};
