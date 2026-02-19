import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
import { supabase } from '../config/database.js';
import { encryptionService } from '../services/encryption.service.js';
import { auditService } from '../services/audit.service.js';
import { mapSigurEvent } from '../utils/sigur.mapper.js';
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

      // Забираем все события с пагинацией (как при синхронизации)
      const rawData = await sigurService.getEvents(
        startTime as string | undefined,
        endTime as string | undefined,
        connection,
      );

      console.log('[sigur preview] rawData count:', rawData.length);

      // Маппим и фильтруем по дате
      const startDateStr = (startTime as string)?.split('T')[0];
      const endDateStr = (endTime as string)?.split('T')[0];

      const mapped = rawData
        .map((raw: unknown) => mapSigurEvent(raw as Record<string, unknown>))
        .filter(Boolean)
        .filter(evt => {
          if (!startDateStr || !endDateStr) return true;
          return evt!.eventDate >= startDateStr && evt!.eventDate <= endDateStr;
        })
        .slice(0, 20);

      const sampleFields = ['physicalPerson', 'eventDate', 'eventTime', 'direction', 'accessPoint', 'cardNumber'];

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

      const organizationId = req.user.organization_id;
      if (!organizationId) {
        res.status(400).json({ success: false, error: 'Organization required' });
        return;
      }

      const { startDate, endDate } = req.body;
      if (!startDate || !endDate) {
        res.status(400).json({ success: false, error: 'startDate и endDate обязательны' });
        return;
      }

      const connection = (req.body.connection as 'external' | 'internal') || undefined;

      // 1. Забираем события из Sigur
      const startTime = `${startDate}T00:00:00`;
      const endTime = `${endDate}T23:59:59`;
      const sigurEvents = await sigurService.getEvents(startTime, endTime, connection);

      if (!sigurEvents || sigurEvents.length === 0) {
        res.json({ success: true, data: { imported: 0, skipped: 0, matched: 0, errors: [] } });
        return;
      }

      // 2. Загружаем сотрудников для сопоставления по ФИО
      const { data: employeesData } = await supabase
        .from('employees')
        .select('id, full_name_encrypted')
        .eq('organization_id', organizationId)
        .eq('is_archived', false);

      const employeeMap = new Map<string, number>();
      for (const emp of employeesData || []) {
        const name = encryptionService.decrypt(emp.full_name_encrypted).toLowerCase().trim();
        employeeMap.set(name, emp.id);
      }

      // 3. Загружаем существующие события для дедупликации
      const { data: existingEvents } = await supabase
        .from('skud_events')
        .select('physical_person_encrypted, event_date, event_time')
        .eq('organization_id', organizationId)
        .gte('event_date', startDate)
        .lte('event_date', endDate);

      const existingSet = new Set<string>();
      for (const evt of existingEvents || []) {
        const name = encryptionService.decrypt(evt.physical_person_encrypted).toLowerCase().trim();
        existingSet.add(`${name}|${evt.event_date}|${evt.event_time}`);
      }

      // 4. Маппим и фильтруем
      const errors: string[] = [];
      const eventsToInsert: {
        organization_id: string;
        physical_person_encrypted: string;
        card_number_encrypted: string | null;
        event_date: string;
        event_time: string;
        access_point: string | null;
        direction: 'entry' | 'exit' | null;
        employee_id: number | null;
      }[] = [];
      const summariesToUpdate = new Set<string>();
      let skipped = 0;

      for (const raw of sigurEvents) {
        const mapped = mapSigurEvent(raw as Record<string, unknown>);
        if (!mapped) {
          errors.push(`Не удалось распарсить: ${JSON.stringify(raw).slice(0, 120)}`);
          continue;
        }

        // Дедупликация
        const dedupKey = `${mapped.physicalPerson.toLowerCase().trim()}|${mapped.eventDate}|${mapped.eventTime}`;
        if (existingSet.has(dedupKey)) {
          skipped++;
          continue;
        }
        existingSet.add(dedupKey);

        const employeeId = employeeMap.get(mapped.physicalPerson.toLowerCase().trim()) || null;

        eventsToInsert.push({
          organization_id: organizationId,
          physical_person_encrypted: encryptionService.encrypt(mapped.physicalPerson),
          card_number_encrypted: mapped.cardNumber ? encryptionService.encrypt(mapped.cardNumber) : null,
          event_date: mapped.eventDate,
          event_time: mapped.eventTime,
          access_point: mapped.accessPoint,
          direction: mapped.direction,
          employee_id: employeeId,
        });

        if (employeeId) {
          summariesToUpdate.add(`${employeeId}:${mapped.eventDate}`);
        }
      }

      // 5. Вставляем батчами по 500
      let totalInserted = 0;
      const BATCH_SIZE = 500;
      for (let i = 0; i < eventsToInsert.length; i += BATCH_SIZE) {
        const batch = eventsToInsert.slice(i, i + BATCH_SIZE);
        const { error: insertError } = await supabase.from('skud_events').insert(batch);
        if (insertError) {
          errors.push(`Ошибка вставки батча ${i / BATCH_SIZE + 1}: ${insertError.message}`);
        } else {
          totalInserted += batch.length;
        }
      }

      // 6. Пересчитываем дневные сводки
      for (const key of summariesToUpdate) {
        const [empId, date] = key.split(':');
        await supabase.rpc('recalculate_skud_daily_summary', {
          p_organization_id: organizationId,
          p_employee_id: parseInt(empId, 10),
          p_date: date,
        });
      }

      // 7. Аудит
      await auditService.logFromRequest(req, req.user.id, 'SYNC_SIGUR', {
        details: {
          sigurTotal: sigurEvents.length,
          imported: totalInserted,
          skipped,
          errors: errors.length,
          matchedEmployees: summariesToUpdate.size,
          dateRange: { startDate, endDate },
        },
      });

      res.json({
        success: true,
        data: {
          imported: totalInserted,
          skipped,
          matched: summariesToUpdate.size,
          errors,
          sigurTotal: sigurEvents.length,
        },
      });
    } catch (error) {
      console.error('Sigur sync error:', error);
      res.status(500).json({ success: false, error: 'Ошибка синхронизации данных из Sigur' });
    }
  },
};
