import { Response } from 'express';
import { sigurService } from '../services/sigur.service.js';
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
   * GET /api/sigur/stream?type=employees
   * SSE-стриминг данных с прогрессом
   */
  async stream(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const type = req.query.type as string;
      const ENTITIES: Record<string, string> = {
        employees: '/api/v1/employees',
        departments: '/api/v1/departments',
        events: '/api/v1/events/parsed',
        'access-points': '/api/v1/accesspoints',
        cards: '/api/v1/cards',
        zones: '/api/v1/zones',
        'access-rules': '/api/v1/accessrules',
      };

      const endpoint = ENTITIES[type];
      if (!endpoint) {
        res.status(400).json({ success: false, error: 'Неизвестный тип данных' });
        return;
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const send = (data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const connection = (req.query.connection as 'external' | 'internal') || undefined;

      send({ type: 'start' });

      const allData = await sigurService.fetchWithProgress(
        endpoint,
        (loaded, page, pageItems) => {
          send({ type: 'progress', loaded, page, pageSize: pageItems.length });
        },
        undefined,
        connection,
      );

      send({ type: 'done', data: allData, total: allData.length });
      res.end();
    } catch (error) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: (error as Error).message })}\n\n`);
        res.end();
      } catch { /* headers already sent */ }
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
   * GET /api/sigur/events/types
   * Получить типы событий из Sigur
   */
  async getEventTypes(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const data = await sigurService.getEventTypes(connection);

      res.json({ success: true, data });
    } catch (error) {
      console.error('Sigur get event types error:', error);
      res.status(500).json({ success: false, error: 'Ошибка получения типов событий из Sigur' });
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
   * GET /api/sigur/discover
   * Диагностика: показывает ВСЕ доступные поля из Sigur API
   */
  async discover(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      if (!sigurService.isConfigured()) {
        res.status(503).json({ success: false, error: 'Sigur не настроен' });
        return;
      }

      const connection = (req.query.connection as 'external' | 'internal') || undefined;
      const result: Record<string, unknown> = {};

      // 1. Берём все отделы и показываем первые 3
      try {
        const depts = await sigurService.getDepartments(connection) as Record<string, unknown>[];
        result.departmentsTotal = depts.length;
        result.departmentSamples = depts.slice(0, 5);
        result.departmentFields = depts.length > 0 ? Object.keys(depts[0]) : [];

        // Ищем поля иерархии
        const hierarchyFields = ['parentId', 'parentDepartmentId', 'parent_id', 'parent'];
        const foundHierarchy: Record<string, unknown> = {};
        for (const field of hierarchyFields) {
          const hasField = depts.some(d => d[field] !== undefined);
          if (hasField) {
            foundHierarchy[field] = depts.filter(d => d[field] != null).slice(0, 3).map(d => ({
              id: d.id, name: d.name, [field]: d[field],
            }));
          }
        }
        result.departmentHierarchyFields = foundHierarchy;

        // Проверяем один отдел по ID
        if (depts.length > 0 && typeof depts[0].id === 'number') {
          try {
            const singleDept = await sigurService.getDepartmentById(depts[0].id as number, connection);
            result.singleDepartmentFull = singleDept;
          } catch { result.singleDepartmentFull = 'Ошибка запроса'; }
        }
      } catch (e) { result.departmentsError = (e as Error).message; }

      // 2. Берём сотрудников
      try {
        const emps = await sigurService.getEmployeesLimited(10, connection);
        result.employeesTotal = emps.length;
        result.employeeSamples = emps.slice(0, 5);
        result.employeeFields = emps.length > 0 ? Object.keys(emps[0]) : [];

        // Ищем поля должности
        const positionFields = ['positionId', 'positionName', 'position', 'jobTitle'];
        const foundPositions: Record<string, unknown> = {};
        for (const field of positionFields) {
          const hasField = emps.some(e => e[field] !== undefined);
          if (hasField) {
            foundPositions[field] = emps.filter(e => e[field] != null).slice(0, 3).map(e => ({
              id: e.id, name: e.name, [field]: e[field],
            }));
          }
        }
        result.employeePositionFields = foundPositions;

        // Проверяем одного сотрудника по ID
        if (emps.length > 0 && typeof emps[0].id === 'number') {
          try {
            const singleEmp = await sigurService.getEmployeeById(emps[0].id as number, connection);
            result.singleEmployeeFull = singleEmp;
          } catch { result.singleEmployeeFull = 'Ошибка запроса'; }
        }
      } catch (e) { result.employeesError = (e as Error).message; }

      // 3. Пробуем эндпоинт должностей
      try {
        const positions = await sigurService.getPositions(connection);
        if (positions) {
          result.positionsEndpoint = { available: true, total: positions.length, samples: positions.slice(0, 5) };
        } else {
          result.positionsEndpoint = { available: false };
        }
      } catch { result.positionsEndpoint = { available: false }; }

      res.json({ success: true, data: result });
    } catch (error) {
      console.error('Sigur discover error:', error);
      res.status(500).json({ success: false, error: 'Ошибка диагностики Sigur API' });
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

      const { startTime, endTime, connection: conn, departmentId: deptIdFilter } = req.query;
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

      let mapped = rawData
        .map((raw: unknown) => mapSigurEvent(raw as Record<string, unknown>))
        .filter(Boolean)
        .filter(evt => {
          if (!startDateStr || !endDateStr) return true;
          return evt!.eventDate >= startDateStr && evt!.eventDate <= endDateStr;
        }) as import('../utils/sigur.mapper.js').IMappedSigurEvent[];

      // Фильтр по отделу + обогащение
      const filterDeptId = typeof deptIdFilter === 'string' ? Number(deptIdFilter) : NaN;
      try {
        if (!isNaN(filterDeptId)) {
          // Загружаем сотрудников конкретного отдела через Sigur API
          const deptEmployees = await sigurService.fetchAllPaginated<Record<string, unknown>>(
            '/api/v1/employees',
            { departmentId: filterDeptId },
            connection,
            1000,
          );
          const allowedIds = new Set<number>();
          for (const emp of deptEmployees) {
            if (typeof emp.id === 'number') allowedIds.add(emp.id as number);
          }
          console.log('[sigur preview] dept filter:', filterDeptId, 'employees found:', allowedIds.size);
          if (deptEmployees.length > 0) {
            console.log('[sigur preview] emp sample:', JSON.stringify(deptEmployees[0], null, 2));
          }
          console.log('[sigur preview] allowedIds sample:', [...allowedIds].slice(0, 5));
          console.log('[sigur preview] mapped employeeIds sample:', mapped.slice(0, 5).map(e => e.employeeId));
          mapped = mapped.filter(evt => evt.employeeId != null && allowedIds.has(evt.employeeId));
          console.log('[sigur preview] after dept filter:', mapped.length);

          // Ставим department name
          const deptMap = await sigurService.getDepartmentMapCached(connection);
          const deptName = deptMap.get(filterDeptId) || null;
          for (const evt of mapped) {
            evt.department = deptName;
          }
        }
      } catch (e) {
        console.warn('[sigur preview] enrichment failed:', (e as Error).message);
      }

      const totalMapped = mapped.length;
      mapped = mapped.slice(0, 20);

      const sampleFields = ['physicalPerson', 'eventDate', 'eventTime', 'direction', 'accessPoint', 'cardNumber', 'department', 'blocked'];

      res.json({
        success: true,
        data: mapped,
        sampleFields,
        totalFetched: rawData.length,
        mappedCount: totalMapped,
      });
    } catch (error) {
      console.error('Sigur preview error:', error);
      res.status(500).json({ success: false, error: 'Ошибка предварительного просмотра данных Sigur' });
    }
  },

};
