import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
import { parseFIO } from '../utils/fio.utils.js';
import type { AuthenticatedRequest } from '../types/index.js';

export const sigurController = {
  /**
   * GET /api/sigur/test
   * Проверка соединения с Sigur
   */
  async testConnection(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({
          success: false,
          error: 'Sigur не настроен. Укажите SIGUR_EXTERNAL_* или SIGUR_INTERNAL_* в .env',
          connections: sigurService.getAvailableConnections(),
        });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const result = await sigurService.testConnection(connection);

      res.json({
        success: result.success,
        message: result.message,
        connection: result.connection,
        connections: sigurService.getAvailableConnections(),
      });
    } catch (error) {
      console.error('Sigur test connection error:', error);
      res.status(500).json({ success: false, error: 'Ошибка проверки подключения к Sigur' });
    }
  },

  /**
   * GET /api/sigur/employees
   * Получить список сотрудников из Sigur
   */
  async getEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getEmployees(undefined, connection);

      console.log('[sigur employees] sample (first 2):', JSON.stringify(data.slice(0, 2), null, 2));

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get employees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения сотрудников из Sigur' });
    }
  },

  /**
   * GET /api/sigur/departments
   * Получить список отделов из Sigur
   */
  async getDepartments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getDepartments(connection);

      console.log('[sigur departments] sample (first 2):', JSON.stringify(data.slice(0, 2), null, 2));

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get departments error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения отделов из Sigur' });
    }
  },

  /**
   * GET /api/sigur/access-points
   * Получить список точек доступа из Sigur
   */
  async getAccessPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getAccessPoints(connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get access points error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения точек доступа из Sigur' });
    }
  },

  /**
   * GET /api/sigur/events
   * Получить события из Sigur (query: startTime, endTime)
   */
  async getEvents(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const { startTime, endTime, connection: conn } = req.query;
      const connection = (conn as 'external' | 'internal') || undefined;

      const data = await sigurService.getEvents(
        startTime as string | undefined,
        endTime as string | undefined,
        connection,
      );

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get events error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения событий из Sigur' });
    }
  },

  /**
   * GET /api/sigur/events/codes
   * Получить коды событий из Sigur
   */
  async getEventCodes(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getEventCodes(connection);

      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur get event codes error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения кодов событий из Sigur' });
    }
  },

  /**
   * GET /api/sigur/cards
   * Получить карты доступа из Sigur
   */
  async getCards(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getCards(undefined, connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get cards error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения карт из Sigur' });
    }
  },

  /**
   * GET /api/sigur/zones
   * Получить зоны доступа из Sigur
   */
  async getZones(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getZones(connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get zones error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения зон из Sigur' });
    }
  },

  /**
   * GET /api/sigur/access-rules
   * Получить режимы доступа из Sigur
   */
  async getAccessRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getAccessRules(connection);

      res.json({ success: true, data, count: data.length });
    } catch (error) {
      console.error('Sigur get access rules error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения режимов доступа из Sigur' });
    }
  },

  /**
   * GET /api/sigur/preview
   * Предпросмотр событий из Sigur — показывает замапленные поля
   */
  async preview(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const { startTime, endTime, connection: conn } = req.query;
      const connection = (conn as 'external' | 'internal') || undefined;

      console.log('[sigur preview] fetching events (paginated):', { startTime, endTime, connection });

      // Забираем ограниченное кол-во событий для предпросмотра
      const rawData = await sigurService.getEventsLimited(
        startTime as string | undefined,
        endTime as string | undefined,
        500,
        connection,
      );

      console.log('[sigur preview] rawData count:', rawData.length);

      if (rawData.length > 0) {
        console.log('[sigur preview] RAW event sample:', JSON.stringify(rawData[0], null, 2));
      }

      // Маппим и фильтруем по дате
      const startDateStr = (startTime as string)?.split('T')[0];
      const endDateStr = (endTime as string)?.split('T')[0];
      console.log('[sigur preview] date filter:', { startDateStr, endDateStr });

      const mapped = rawData
        .map((raw: unknown) => mapSigurEvent(raw as Record<string, unknown>))
        .filter(Boolean)
        .filter(evt => {
          if (!startDateStr || !endDateStr) return true;
          return evt!.eventDate >= startDateStr && evt!.eventDate <= endDateStr;
        })
        .slice(0, 20) as import('../utils/sigur.mapper.js').IMappedSigurEvent[];

      // Обогащаем данными из /employees (кэш предзагружен при старте)
      if (mapped.length > 0) {
        try {
          const employees = await sigurService.getEmployeesCached(connection);
          const empMap = new Map<number, { departmentName: string | null; isBlocked: boolean }>();
          for (const emp of employees) {
            const id = emp.id as number;
            if (typeof id === 'number') {
              empMap.set(id, {
                departmentName: ((emp.departmentName as string) || '').trim() || null,
                isBlocked: !!(emp.isBlocked),
              });
            }
          }
          for (const evt of mapped) {
            if (evt.employeeId && empMap.has(evt.employeeId)) {
              const info = empMap.get(evt.employeeId)!;
              evt.department = info.departmentName;
              evt.blocked = info.isBlocked;
            }
          }
        } catch (e) {
          console.warn('[sigur preview] enrichment failed:', (e as Error).message);
        }
      }

      const sampleFields = ['physicalPerson', 'eventDate', 'eventTime', 'direction', 'accessPoint', 'cardNumber', 'department', 'blocked'];

      res.json({
        success: true,
        data: mapped,
        sampleFields,
        totalFetched: rawData.length,
        mappedCount: mapped.length,
      });
    } catch (error) {
      console.error('Sigur preview error:', error);
      res.status(500).json({ success: false, error: 'Ошибка предварительного просмотра данных Sigur' });
    }
  },

  /**
   * POST /api/sigur/sync
   * Синхронизация событий из Sigur в skud_events
   * Body: { startDate: "YYYY-MM-DD", endDate: "YYYY-MM-DD" }
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

      // SSE: стримим прогресс
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

      // Финальное сообщение
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
   * Импорт сотрудников из Sigur в БД с раздельным ФИО
   */
  async syncEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      // 1. Загружаем сотрудников из Sigur
      console.log('[syncEmployees] fetching employees from Sigur...');
      const sigurEmployees = await sigurService.getEmployeesCached(connection);
      console.log('[syncEmployees] got', sigurEmployees.length, 'employees from Sigur');

      if (sigurEmployees.length === 0) {
        res.json({ success: true, data: { imported: 0, skipped: 0, total: 0 } });
        return;
      }

      // 2. Загружаем справочник отделов Sigur → organizationId
      const deptMap = await sigurService.getDepartmentMapCached(connection);

      // Маппинг: departmentName → organization_id
      const { data: orgsData } = await supabase.from('organizations').select('id, name_encrypted');
      const orgNameToId = new Map<string, string>();
      for (const org of orgsData || []) {
        if (org.name_encrypted) {
          const name = encryptionService.decrypt(org.name_encrypted).toLowerCase().trim();
          orgNameToId.set(name, org.id);
        }
      }

      // Fallback org_id
      let fallbackOrgId: string | null = null;
      if (orgNameToId.size === 1) {
        fallbackOrgId = [...orgNameToId.values()][0];
      } else if (orgsData && orgsData.length > 0) {
        fallbackOrgId = orgsData[0].id;
      }

      // 3. Обрабатываем сотрудников
      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];

      const BATCH_SIZE = 100;
      const inserts: Record<string, unknown>[] = [];

      for (const emp of sigurEmployees) {
        const fullName = (emp.name as string) || '';
        if (!fullName.trim()) { skipped++; continue; }

        // Определяем организацию через отдел
        const deptId = emp.departmentId as number;
        const deptName = deptId ? deptMap.get(deptId) : null;
        const orgId = deptName ? orgNameToId.get(deptName.toLowerCase().trim()) : null;
        const organizationId = orgId || fallbackOrgId;
        if (!organizationId) {
          errors.push(`Нет организации для: ${fullName}`);
          skipped++;
          continue;
        }

        const fio = parseFIO(fullName);

        inserts.push({
          organization_id: organizationId,
          full_name_encrypted: encryptionService.encrypt(fullName.trim()),
          last_name_encrypted: encryptionService.encrypt(fio.lastName),
          first_name_encrypted: fio.firstName ? encryptionService.encrypt(fio.firstName) : null,
          middle_name_encrypted: fio.middleName ? encryptionService.encrypt(fio.middleName) : null,
          position_encrypted: encryptionService.encrypt('Сотрудник'),
          hire_date_encrypted: encryptionService.encrypt(new Date().toISOString().slice(0, 10)),
        });
      }

      console.log('[syncEmployees] prepared', inserts.length, 'inserts');

      // 4. Вставляем батчами
      for (let i = 0; i < inserts.length; i += BATCH_SIZE) {
        const batch = inserts.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await supabase.from('employees').insert(batch);
        if (insertError) {
          errors.push(`Ошибка вставки батча ${i / BATCH_SIZE + 1}: ${insertError.message}`);
        } else {
          imported += batch.length;
        }
      }

      console.log(`[syncEmployees] done: ${imported} imported, ${skipped} skipped, ${errors.length} errors`);

      res.json({
        success: true,
        data: { imported, skipped, total: sigurEmployees.length, errors },
      });
    } catch (error) {
      console.error('Sigur syncEmployees error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта сотрудников из Sigur' });
    }
  },

  /**
   * POST /api/sigur/sync-organizations
   * Импорт отделов Sigur как организаций в БД
   */
  async syncOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;
      const departments = await sigurService.getDepartments(connection) as Record<string, unknown>[];

      console.log('[syncOrganizations] dept sample:', JSON.stringify(departments.slice(0, 3), null, 2));

      if (!departments || departments.length === 0) {
        res.json({ success: true, data: { imported: 0, skipped: 0, total: 0 } });
        return;
      }

      // Загружаем существующие организации для дедупликации
      const { data: existingOrgs } = await supabase
        .from('organizations')
        .select('id, name_encrypted');

      const existingNames = new Set<string>();
      console.log('[syncOrganizations] existing orgs:', existingOrgs?.length ?? 0);
      for (const org of existingOrgs || []) {
        if (org.name_encrypted) {
          const decrypted = encryptionService.decrypt(org.name_encrypted).toLowerCase().trim();
          existingNames.add(decrypted);
        }
      }
      console.log('[syncOrganizations] existingNames size:', existingNames.size);

      let imported = 0;
      let skipped = 0;
      let skipEmpty = 0;
      let skipDup = 0;
      let skipErr = 0;

      for (const dept of departments) {
        const name = (dept.name as string) || (dept.title as string) || '';
        if (!name.trim()) {
          skipEmpty++;
          skipped++;
          continue;
        }

        if (existingNames.has(name.toLowerCase().trim())) {
          skipDup++;
          skipped++;
          continue;
        }

        const { error: insertError } = await supabase
          .from('organizations')
          .insert({ name_encrypted: encryptionService.encrypt(name.trim()) });

        if (insertError) {
          skipErr++;
          console.error('[syncOrganizations] insert error:', insertError.message);
          skipped++;
        } else {
          existingNames.add(name.toLowerCase().trim());
          imported++;
        }
      }

      console.log(`[syncOrganizations] details: empty=${skipEmpty}, dup=${skipDup}, err=${skipErr}`);

      console.log(`[syncOrganizations] done: ${imported} imported, ${skipped} skipped, ${departments.length} total`);

      res.json({
        success: true,
        data: { imported, skipped, total: departments.length },
      });
    } catch (error) {
      console.error('Sigur syncOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка импорта организаций из Sigur' });
    }
  },

  /**
   * POST /api/sigur/clean-duplicate-organizations
   * Удаление дублей организаций: оставляем первую, переносим ссылки, удаляем остальные
   */
  async cleanDuplicateOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // 1. Загружаем все организации
      const { data: allOrgs } = await supabase
        .from('organizations')
        .select('id, name_encrypted, created_at')
        .order('created_at', { ascending: true });

      if (!allOrgs || allOrgs.length === 0) {
        res.json({ success: true, data: { duplicatesRemoved: 0, totalBefore: 0, totalAfter: 0 } });
        return;
      }

      console.log(`[cleanDuplicateOrgs] loaded ${allOrgs.length} organizations`);

      // 2. Группируем по расшифрованному имени
      const groups = new Map<string, typeof allOrgs>();
      for (const org of allOrgs) {
        const name = org.name_encrypted
          ? encryptionService.decrypt(org.name_encrypted).toLowerCase().trim()
          : '';
        if (!name) continue;
        const existing = groups.get(name) || [];
        existing.push(org);
        groups.set(name, existing);
      }

      // 3. Собираем маппинг dupId → keepId и список всех дублей
      const remapEntries: { dupId: string; keepId: string }[] = [];
      const allDuplicateIds: string[] = [];

      for (const [, orgs] of groups) {
        if (orgs.length <= 1) continue;
        const keepId = orgs[0].id;
        for (let i = 1; i < orgs.length; i++) {
          remapEntries.push({ dupId: orgs[i].id, keepId });
          allDuplicateIds.push(orgs[i].id);
        }
      }

      console.log(`[cleanDuplicateOrgs] found ${allDuplicateIds.length} duplicates to remove`);

      if (allDuplicateIds.length === 0) {
        res.json({ success: true, data: { duplicatesRemoved: 0, totalBefore: allOrgs.length, totalAfter: allOrgs.length } });
        return;
      }

      // 4. Переносим ссылки батчами: группируем по keepId
      const TABLES_WITH_ORG_ID = [
        'employees', 'org_companies', 'org_departments', 'org_sites',
        'org_subdivisions', 'positions', 'skud_daily_summary', 'skud_events', 'user_profiles',
      ];

      const errors: string[] = [];
      const keepGroups = new Map<string, string[]>();
      for (const { dupId, keepId } of remapEntries) {
        const list = keepGroups.get(keepId) || [];
        list.push(dupId);
        keepGroups.set(keepId, list);
      }

      for (const table of TABLES_WITH_ORG_ID) {
        for (const [keepId, dupIds] of keepGroups) {
          const { error: updateError } = await supabase
            .from(table)
            .update({ organization_id: keepId })
            .in('organization_id', dupIds);

          if (updateError) {
            errors.push(`${table}: ${updateError.message}`);
          }
        }
      }

      console.log(`[cleanDuplicateOrgs] references updated, deleting duplicates...`);

      // 5. Удаляем дубли батчом
      const { error: deleteError } = await supabase
        .from('organizations')
        .delete()
        .in('id', allDuplicateIds);

      let duplicatesRemoved = allDuplicateIds.length;
      if (deleteError) {
        errors.push(`delete batch: ${deleteError.message}`);
        duplicatesRemoved = 0;
      }

      console.log(`[cleanDuplicateOrgs] removed ${duplicatesRemoved} duplicates, errors: ${errors.length}`);

      res.json({
        success: true,
        data: {
          totalBefore: allOrgs.length,
          totalAfter: allOrgs.length - duplicatesRemoved,
          duplicatesRemoved,
          errors,
        },
      });
    } catch (error) {
      console.error('cleanDuplicateOrganizations error:', error);
      res.status(500).json({ success: false, error: 'Ошибка очистки дублей организаций' });
    }
  },
};
