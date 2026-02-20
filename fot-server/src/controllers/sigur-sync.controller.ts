import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { parseFIO } from '../utils/fio.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

/** Системные папки Sigur — фильтруем при импорте отделов */
const SIGUR_SYSTEM_DEPARTMENTS = [
  'api_keys', 'автопарк', 'гостевые qr-коды',
];

function isSystemDepartment(name: string): boolean {
  return SIGUR_SYSTEM_DEPARTMENTS.includes(name.toLowerCase().trim());
}

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

      // 1. Загружаем ВСЕХ сотрудников
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, organization_id, full_name_encrypted')
        .eq('is_archived', false);

      const employeeMap = new Map<string, { id: number; organization_id: string }>();
      for (const emp of employeesData || []) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
        if (!employeeMap.has(name)) {
          employeeMap.set(name, { id: emp.id, organization_id: emp.organization_id });
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

        const rawEvents = await sigurService.getEvents(dayStart, dayEnd, connection, 'PASS_DETECTED');
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

          const emp = employeeMap.get(nameKey);
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
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      console.log('[syncEmployees] fetching employees from Sigur...');
      const sigurEmployees = await sigurService.getEmployeesCached(connection);
      console.log('[syncEmployees] got', sigurEmployees.length, 'employees from Sigur');

      if (sigurEmployees.length === 0) {
        res.json({ success: true, data: { imported: 0, updated: 0, skipped: 0, total: 0 } });
        return;
      }

      // Загружаем существующих сотрудников для upsert по sigur_employee_id
      const { data: existingEmps } = await supabase
        .from('employees')
        .select('id, sigur_employee_id')
        .eq('organization_id', organizationId)
        .not('sigur_employee_id', 'is', null);

      const sigurIdToDbId = new Map<number, number>();
      for (const e of existingEmps || []) {
        if (e.sigur_employee_id != null) {
          sigurIdToDbId.set(e.sigur_employee_id, e.id);
        }
      }

      // Маппинг org_departments: sigur_department_id → db uuid
      const { data: dbDepartments } = await supabase
        .from('org_departments')
        .select('id, sigur_department_id')
        .eq('organization_id', organizationId)
        .not('sigur_department_id', 'is', null);

      const sigurDeptToDbId = new Map<number, string>();
      for (const d of dbDepartments || []) {
        if (d.sigur_department_id != null) {
          sigurDeptToDbId.set(d.sigur_department_id, d.id);
        }
      }

      // Маппинг positions: sigur_position_id → db uuid
      const { data: dbPositions } = await supabase
        .from('positions')
        .select('id, sigur_position_id')
        .eq('organization_id', organizationId)
        .not('sigur_position_id', 'is', null);

      const sigurPosToDbId = new Map<number, string>();
      for (const p of dbPositions || []) {
        if (p.sigur_position_id != null) {
          sigurPosToDbId.set(p.sigur_position_id, p.id);
        }
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      const BATCH_SIZE = 100;
      const inserts: Record<string, unknown>[] = [];

      for (const emp of sigurEmployees) {
        const fullName = (emp.name as string) || '';
        if (!fullName.trim()) { skipped++; continue; }

        const sigurEmpId = emp.id as number | undefined;

        // Резолвим подразделение и должность
        const sigurDeptId = emp.departmentId as number | undefined;
        const orgDepartmentId = sigurDeptId ? sigurDeptToDbId.get(sigurDeptId) || null : null;

        const sigurPosId = emp.positionId as number | undefined;
        const positionId = sigurPosId ? sigurPosToDbId.get(sigurPosId) || null : null;

        // Если уже импортирован — обновляем привязки
        if (sigurEmpId && sigurIdToDbId.has(sigurEmpId)) {
          const dbId = sigurIdToDbId.get(sigurEmpId)!;
          const updateFields: Record<string, unknown> = {};

          if (orgDepartmentId) updateFields.org_department_id = orgDepartmentId;
          if (positionId) updateFields.position_id = positionId;

          if (Object.keys(updateFields).length > 0) {
            const { error: updateError } = await supabase
              .from('employees')
              .update(updateFields)
              .eq('id', dbId);
            if (!updateError) updated++;
            else errors.push(`update ${fullName}: ${updateError.message}`);
          } else {
            skipped++;
          }
          continue;
        }

        const fio = parseFIO(fullName);

        inserts.push({
          organization_id: organizationId,
          full_name_encrypted: encryptionService.encrypt(fullName.trim()),
          last_name_encrypted: encryptionService.encrypt(fio.lastName),
          first_name_encrypted: fio.firstName ? encryptionService.encrypt(fio.firstName) : null,
          middle_name_encrypted: fio.middleName ? encryptionService.encrypt(fio.middleName) : null,
          hire_date_encrypted: encryptionService.encrypt(new Date().toISOString().slice(0, 10)),
          sigur_employee_id: sigurEmpId || null,
          org_department_id: orgDepartmentId,
          position_id: positionId,
        });
      }

      console.log('[syncEmployees] prepared', inserts.length, 'inserts');

      for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
        const batch = inserts.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await supabase.from('employees').insert(batch);
        if (insertError) {
          errors.push(`Ошибка вставки батча ${i / BATCH_SIZE + 1}: ${insertError.message}`);
        } else {
          imported += batch.length;
        }
      }

      console.log(`[syncEmployees] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);

      res.json({
        success: true,
        data: { imported, updated, skipped, total: sigurEmployees.length, errors },
      });
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
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];

      if (!departments || departments.length === 0) {
        res.json({ success: true, data: { imported: 0, updated: 0, skipped: 0, filtered: 0, total: 0 } });
        return;
      }

      console.log(`[syncDepartments] got ${departments.length} departments from Sigur`);

      // Загружаем существующие отделы для upsert по sigur_department_id
      const { data: existingDepts } = await supabase
        .from('org_departments')
        .select('id, sigur_department_id, name_encrypted')
        .eq('organization_id', organizationId);

      const sigurIdToDbId = new Map<number, string>();
      for (const d of existingDepts || []) {
        if (d.sigur_department_id != null) {
          sigurIdToDbId.set(d.sigur_department_id, d.id);
        }
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let filtered = 0;
      const errors: string[] = [];

      // Pass 1: Upsert отделов (без parent_id)
      const sigurToDbMap = new Map<number, string>(); // sigurId → db uuid

      // Копируем существующие маппинги
      for (const [sigurId, dbId] of sigurIdToDbId) {
        sigurToDbMap.set(sigurId, dbId);
      }

      // Определяем корневой элемент (Объект) — не создаём как отдел
      const rootDept = departments.find(d =>
        (d.parentId === null || d.parentId === undefined || d.parentId === 0) &&
        departments.some(child => child.parentId === d.id)
      );
      const rootSigurId = rootDept?.id as number | undefined;

      for (const dept of departments) {
        const name = (dept.name as string) || '';
        const sigurId = dept.id as number;

        if (!name.trim()) { skipped++; continue; }

        // Пропускаем корневой элемент (это сама организация)
        if (rootSigurId && sigurId === rootSigurId) {
          skipped++;
          continue;
        }

        // Фильтруем системные папки
        if (isSystemDepartment(name)) {
          filtered++;
          continue;
        }

        // Upsert: есть ли уже в БД?
        if (sigurIdToDbId.has(sigurId)) {
          // Обновляем название
          const dbId = sigurIdToDbId.get(sigurId)!;
          const { error: updateError } = await supabase
            .from('org_departments')
            .update({ name_encrypted: encryptionService.encrypt(name.trim()) })
            .eq('id', dbId);

          if (updateError) {
            errors.push(`update ${name}: ${updateError.message}`);
          } else {
            updated++;
          }
          sigurToDbMap.set(sigurId, dbId);
        } else {
          // Создаём новый
          const { data: created, error: insertError } = await supabase
            .from('org_departments')
            .insert({
              organization_id: organizationId,
              name_encrypted: encryptionService.encrypt(name.trim()),
              sigur_department_id: sigurId,
            })
            .select('id')
            .single();

          if (insertError) {
            errors.push(`insert ${name}: ${insertError.message}`);
          } else {
            imported++;
            sigurToDbMap.set(sigurId, created.id);
          }
        }
      }

      // Pass 2: Проставляем parent_id связи
      let parentLinksSet = 0;
      for (const dept of departments) {
        const sigurId = dept.id as number;
        const parentSigurId = dept.parentId as number | null | undefined;

        if (!parentSigurId || !sigurToDbMap.has(sigurId)) continue;

        // Если parent — корень, ставим null (верхний уровень)
        const parentDbId = (rootSigurId && parentSigurId === rootSigurId)
          ? null
          : sigurToDbMap.get(parentSigurId) || null;

        const dbId = sigurToDbMap.get(sigurId)!;
        const { error: linkError } = await supabase
          .from('org_departments')
          .update({ parent_id: parentDbId })
          .eq('id', dbId);

        if (!linkError) parentLinksSet++;
      }

      console.log(`[syncDepartments] done: ${imported} imported, ${updated} updated, ${skipped} skipped, ${filtered} filtered, ${parentLinksSet} parent links`);

      res.json({
        success: true,
        data: { imported, updated, skipped, filtered, total: departments.length, parentLinksSet, errors },
      });
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
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const organizationId = req.body.organization_id || req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'organization_id обязателен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const sigurPositions = await sigurService.getPositions(connection);

      if (!sigurPositions || sigurPositions.length === 0) {
        res.json({ success: true, data: { imported: 0, updated: 0, skipped: 0, total: 0 } });
        return;
      }

      console.log(`[syncPositions] got ${sigurPositions.length} positions from Sigur`);

      // Загружаем существующие должности для upsert по sigur_position_id
      const { data: existingPositions } = await supabase
        .from('positions')
        .select('id, sigur_position_id, name_encrypted')
        .eq('organization_id', organizationId);

      const sigurIdToDbId = new Map<number, string>();
      for (const p of existingPositions || []) {
        if (p.sigur_position_id != null) {
          sigurIdToDbId.set(p.sigur_position_id, p.id);
        }
      }

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      const errors: string[] = [];

      for (const pos of sigurPositions) {
        const name = (pos.name as string) || '';
        const sigurId = pos.id as number;

        if (!name.trim()) { skipped++; continue; }

        if (sigurIdToDbId.has(sigurId)) {
          const dbId = sigurIdToDbId.get(sigurId)!;
          const { error: updateError } = await supabase
            .from('positions')
            .update({ name_encrypted: encryptionService.encrypt(name.trim()) })
            .eq('id', dbId);

          if (updateError) {
            errors.push(`update ${name}: ${updateError.message}`);
          } else {
            updated++;
          }
        } else {
          const { error: insertError } = await supabase
            .from('positions')
            .insert({
              organization_id: organizationId,
              name_encrypted: encryptionService.encrypt(name.trim()),
              sigur_position_id: sigurId,
              category: 'other',
            });

          if (insertError) {
            errors.push(`insert ${name}: ${insertError.message}`);
          } else {
            imported++;
          }
        }
      }

      console.log(`[syncPositions] done: ${imported} imported, ${updated} updated, ${skipped} skipped`);

      res.json({
        success: true,
        data: { imported, updated, skipped, total: sigurPositions.length, errors },
      });
    } catch (error) {
      console.error('Sigur syncPositions error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта должностей из Sigur' });
    }
  },

};
