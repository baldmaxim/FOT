import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { computeDedupHash } from '../utils/dedup.utils.js';
import {
  syncOrganizationsLogic,
  cleanDuplicateOrganizationsLogic,
  syncDepartmentsLogic,
  syncPositionsFromSigurLogic,
  seedPositionsLogic,
  syncEmployeesLogic,
  getWhitelistedDepartmentIds,
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

      // 1. Загружаем ВСЕХ сотрудников (маппинг по name|org + по sigur_employee_id)
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, organization_id, full_name, sigur_employee_id')
        .eq('is_archived', false);

      // name|org_id → emp (исключает конфликты при одинаковых ФИО в разных org)
      const employeeByNameOrg = new Map<string, { id: number; organization_id: string }>();
      const sigurIdMap = new Map<number, { id: number; organization_id: string }>();
      for (const emp of employeesData || []) {
        const name = (emp.full_name || '').toLowerCase().trim();
        const empRef = { id: emp.id, organization_id: emp.organization_id };
        const key = `${name}|${emp.organization_id}`;
        if (!employeeByNameOrg.has(key)) {
          employeeByNameOrg.set(key, empRef);
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

      // 1b. Проверяем whitelist отделов → фильтруем по Sigur-сотрудникам
      const whitelist = await getWhitelistedDepartmentIds(fallbackOrgId || '');
      let allowedNames: Set<string> | null = null;
      let allowedSigurIds: Set<number> | null = null;

      if (whitelist) {
        sendProgress({ type: 'status', message: `Загрузка фильтра: ${whitelist.size} отделов...` });
        const sigurEmployees = await sigurService.getEmployeesCached(connection);
        allowedNames = new Set<string>();
        allowedSigurIds = new Set<number>();
        for (const emp of sigurEmployees) {
          const deptId = emp.departmentId as number | undefined;
          if (deptId && whitelist.has(deptId)) {
            const name = ((emp.name as string) || '').toLowerCase().trim();
            if (name) allowedNames.add(name);
            if (typeof emp.id === 'number') allowedSigurIds.add(emp.id);
          }
        }
        sendProgress({ type: 'status', message: `Фильтр: ${whitelist.size} отделов, ${allowedNames.size} сотрудников` });
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
      let totalNoName = 0;
      let totalNoOrg = 0;
      let totalFilteredDept = 0;
      const summariesToUpdate = new Set<string>();

      sendProgress({ type: 'start', totalDays: days.length, employees: employeeByNameOrg.size, filtered: !!whitelist });

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

        // Дедупликация: загружаем существующие хэши за день
        const { data: existingEvents } = await supabase
          .from('skud_events')
          .select('dedup_hash')
          .eq('event_date', day)
          .not('dedup_hash', 'is', null);

        const existingSet = new Set<string>();
        for (const evt of existingEvents || []) {
          if (evt.dedup_hash) existingSet.add(evt.dedup_hash);
        }

        const dayInserts: {
          organization_id: string;
          physical_person: string;
          card_number: string | null;
          event_date: string;
          event_time: string;
          access_point: string | null;
          direction: 'entry' | 'exit' | null;
          employee_id: number | null;
          dedup_hash: string;
        }[] = [];
        let daySkipped = 0;

        for (const raw of rawEvents) {
          const mapped = mapSigurEvent(raw as Record<string, unknown>);
          if (!mapped) { totalNoName++; continue; }

          // Фильтр по отделам: пропускаем сотрудников не из whitelisted отделов
          if (allowedNames) {
            const nameKey = mapped.physicalPerson.toLowerCase().trim();
            const sigurEmpId = mapped.employeeId;
            if (!allowedNames.has(nameKey) && !(sigurEmpId && allowedSigurIds?.has(sigurEmpId))) {
              totalFilteredDept++;
              continue;
            }
          }

          const dedupHash = computeDedupHash(
            mapped.physicalPerson, mapped.eventDate, mapped.eventTime,
            mapped.accessPoint, mapped.direction,
          );
          if (existingSet.has(dedupHash)) {
            totalSkipped++;
            daySkipped++;
            continue;
          }
          existingSet.add(dedupHash);

          const nameKey = mapped.physicalPerson.toLowerCase().trim();
          let emp = mapped.employeeId != null ? sigurIdMap.get(mapped.employeeId) : undefined;
          if (!emp && fallbackOrgId) {
            emp = employeeByNameOrg.get(`${nameKey}|${fallbackOrgId}`);
          }
          const orgId = emp?.organization_id || fallbackOrgId;
          if (!orgId) { totalNoOrg++; continue; }

          dayInserts.push({
            organization_id: orgId,
            physical_person: mapped.physicalPerson,
            card_number: mapped.cardNumber || null,
            event_date: mapped.eventDate,
            event_time: mapped.eventTime,
            access_point: mapped.accessPoint,
            direction: mapped.direction,
            employee_id: emp?.id || null,
            dedup_hash: dedupHash,
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
          const { error: insertError } = await supabase.from('skud_events').upsert(batch, { onConflict: 'dedup_hash', ignoreDuplicates: true });
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

      // 4. Пересчитываем сводки (пакетный RPC)
      if (summariesToUpdate.size > 0) {
        sendProgress({ type: 'status', message: 'Пересчёт сводок...' });
        const pairs = [...summariesToUpdate].map(key => {
          const [empId, orgId, date] = key.split(':');
          return { org_id: orgId, emp_id: parseInt(empId, 10), date };
        });
        await supabase.rpc('batch_recalculate_skud_daily_summary', { p_pairs: pairs });
      }

      // 5. Аудит
      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          sigurTotal: totalSigur,
          imported: totalInserted,
          skipped: totalSkipped,
          droppedNoName: totalNoName,
          droppedNoOrg: totalNoOrg,
          filteredByDept: totalFilteredDept,
          errors: errors.length,
          matchedEmployees: summariesToUpdate.size,
          dateRange: { startDate, endDate },
        },
      });

      sendProgress({
        type: 'done',
        imported: totalInserted,
        skipped: totalSkipped,
        droppedNoName: totalNoName,
        droppedNoOrg: totalNoOrg,
        filteredByDept: totalFilteredDept,
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
   * POST /api/sigur/clear-events
   * Удаление событий из skud_events за указанный период (по дням, чтобы не таймаутить)
   */
  async clearEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      // Генерируем список дней
      const days: string[] = [];
      const cur = new Date(startDate);
      const end = new Date(endDate);
      while (cur <= end) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setDate(cur.getDate() + 1);
      }

      let totalDeleted = 0;
      const errors: string[] = [];

      // Удаляем по дням чтобы не таймаутить
      for (const day of days) {
        const { count, error: deleteError } = await supabase
          .from('skud_events')
          .delete({ count: 'exact' })
          .eq('event_date', day);

        if (deleteError) {
          errors.push(`[${day}] ${deleteError.message}`);
        } else {
          totalDeleted += count || 0;
        }
      }

      // Удаляем сводки за этот период
      await supabase
        .from('skud_daily_summary')
        .delete()
        .gte('date', startDate)
        .lte('date', endDate);

      await auditService.logFromRequest(req, req.user.id, 'CLEAR_SKUD_EVENTS', {
        details: { startDate, endDate, deletedCount: totalDeleted, errors },
      });

      res.json({ success: true, data: { deleted: totalDeleted, errors } });
    } catch (error) {
      console.error('Clear events error:', error);
      res.status(500).json({ success: false, error: 'Ошибка удаления событий' });
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

      console.log(`[syncAll] resolved organizationId: ${organizationId}, user.organization_id: ${req.user.organization_id}`);

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
