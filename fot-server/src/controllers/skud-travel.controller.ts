import { Response } from 'express';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  confirmTravelObjectMapUpload as confirmTravelObjectMapUploadService,
  createTravelObject,
  createTravelObjectMapUploadUrl as createTravelObjectMapUploadUrlService,
  getTravelConfig as getTravelConfigService,
  getAccessPointMapView as getAccessPointMapViewService,
  getTravelObjectMap as getTravelObjectMapService,
  createTravelRoute,
  deleteTravelObjectMap as deleteTravelObjectMapService,
  deleteTravelObject,
  deleteTravelRoute,
  listTravelObjects,
  listTravelRoutes,
  listTravelSegments,
  rebuildTravelSegmentsForScope,
  saveTravelObjectMapPoints as saveTravelObjectMapPointsService,
  saveTravelConfig as saveTravelConfigService,
  updateTravelObject,
  updateTravelRoute,
} from '../services/skud-travel.service.js';
import { resolveScopedDepartmentId } from '../services/data-scope.service.js';

const monthRegex = /^\d{4}-\d{2}$/;

const createObjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
});

const updateObjectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  access_points: z.array(z.string().trim().min(1).max(255)).max(500).default([]),
});

const uploadTravelObjectMapSchema = z.object({
  file_name: z.string().trim().min(1).max(255),
  content_type: z.string().trim().min(1).max(100),
  file_size: z.number().int().positive().max(10 * 1024 * 1024),
});

const confirmTravelObjectMapSchema = uploadTravelObjectMapSchema.extend({
  storage_path: z.string().trim().min(1).max(1024),
});

const saveTravelObjectMapPointsSchema = z.object({
  points: z.array(z.object({
    access_point_name: z.string().trim().min(1).max(255),
    x_ratio: z.number().min(0).max(1),
    y_ratio: z.number().min(0).max(1),
  })).max(500).default([]),
});

const saveRouteSchema = z.object({
  from_object_id: z.string().uuid(),
  to_object_id: z.string().uuid(),
  travel_minutes: z.number().int().positive().max(1440),
});

const travelConfigSchema = z.object({
  limit_minutes: z.number().int().positive().max(1440),
});

const segmentQuerySchema = z.object({
  month: z.string().regex(monthRegex),
  department_id: z.string().uuid().optional(),
  employee_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['auto_approved', 'delayed', 'needs_object', 'needs_route', 'problem']).optional(),
});

const accessPointMapQuerySchema = z.object({
  access_point_name: z.string().trim().min(1).max(255),
});

export const skudTravelController = {
  async getTravelConfig(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await getTravelConfigService();
      res.json({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка загрузки лимита передвижения';
      console.error('getTravelConfig error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async updateTravelConfig(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = travelConfigSchema.parse(req.body);
      const data = await saveTravelConfigService({
        limitMinutes: parsed.limit_minutes,
        userId: req.user.id,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный лимит передвижения', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка сохранения лимита передвижения';
      console.error('updateTravelConfig error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getTravelObjects(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await listTravelObjects();
      res.json({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка загрузки объектов';
      console.error('getTravelObjects error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async createTravelObject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = createObjectSchema.parse(req.body);
      const data = await createTravelObject(parsed.name);
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные объекта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка создания объекта';
      console.error('createTravelObject error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async updateTravelObject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      const parsed = updateObjectSchema.parse(req.body);
      const data = await updateTravelObject({
        objectId,
        name: parsed.name,
        accessPoints: parsed.access_points,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные объекта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка сохранения объекта';
      console.error('updateTravelObject error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async deleteTravelObject(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      await deleteTravelObject(objectId);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id объекта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка удаления объекта';
      console.error('deleteTravelObject error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getTravelObjectMap(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      const data = await getTravelObjectMapService(objectId);
      if (!data) {
        res.status(404).json({ success: false, error: 'Карта для объекта ещё не загружена' });
        return;
      }
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id объекта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка загрузки карты объекта';
      console.error('getTravelObjectMap error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getTravelObjectMapUploadUrl(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      const parsed = uploadTravelObjectMapSchema.parse(req.body);
      const data = await createTravelObjectMapUploadUrlService({
        objectId,
        fileName: parsed.file_name,
        contentType: parsed.content_type,
        fileSize: parsed.file_size,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные файла карты', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка подготовки загрузки карты';
      console.error('getTravelObjectMapUploadUrl error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async confirmTravelObjectMapUpload(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      const parsed = confirmTravelObjectMapSchema.parse(req.body);
      const data = await confirmTravelObjectMapUploadService({
        objectId,
        storagePath: parsed.storage_path,
        fileName: parsed.file_name,
        contentType: parsed.content_type,
        fileSize: parsed.file_size,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные файла карты', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка подтверждения карты объекта';
      console.error('confirmTravelObjectMapUpload error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async saveTravelObjectMapPoints(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      const parsed = saveTravelObjectMapPointsSchema.parse(req.body);
      const data = await saveTravelObjectMapPointsService({
        objectId,
        points: parsed.points,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные координаты карты', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка сохранения маркеров карты';
      console.error('saveTravelObjectMapPoints error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async deleteTravelObjectMap(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const objectId = z.string().uuid().parse(req.params.id);
      await deleteTravelObjectMapService(objectId);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id объекта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка удаления карты объекта';
      console.error('deleteTravelObjectMap error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getAccessPointMap(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = accessPointMapQuerySchema.parse({
        access_point_name: req.query.access_point_name,
      });
      const data = await getAccessPointMapViewService(parsed.access_point_name);
      // Возвращаем 200 + data: null, если карта не настроена — иначе фронт спамит 404 в консоль
      // на каждое наведение на бейдж точки доступа без карты.
      res.json({ success: true, data: data ?? null });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректное название точки доступа', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка загрузки карты точки доступа';
      console.error('getAccessPointMap error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getTravelRoutes(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const data = await listTravelRoutes();
      res.json({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ошибка загрузки маршрутов';
      console.error('getTravelRoutes error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async createTravelRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const parsed = saveRouteSchema.parse(req.body);
      const data = await createTravelRoute({
        fromObjectId: parsed.from_object_id,
        toObjectId: parsed.to_object_id,
        travelMinutes: parsed.travel_minutes,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные маршрута', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка создания маршрута';
      console.error('createTravelRoute error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async updateTravelRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const routeId = z.string().uuid().parse(req.params.id);
      const parsed = saveRouteSchema.parse(req.body);
      const data = await updateTravelRoute({
        routeId,
        fromObjectId: parsed.from_object_id,
        toObjectId: parsed.to_object_id,
        travelMinutes: parsed.travel_minutes,
      });
      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные данные маршрута', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка сохранения маршрута';
      console.error('updateTravelRoute error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async deleteTravelRoute(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const routeId = z.string().uuid().parse(req.params.id);
      await deleteTravelRoute(routeId);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректный id маршрута', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка удаления маршрута';
      console.error('deleteTravelRoute error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async getTravelSegments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const raw = segmentQuerySchema.parse({
        month: req.query.month,
        department_id: await resolveScopedDepartmentId(
          req,
          typeof req.query.department_id === 'string' ? req.query.department_id : null,
        ) || undefined,
        employee_id: req.query.employee_id,
        status: req.query.status,
      });

      const data = await listTravelSegments({
        month: raw.month,
        departmentId: raw.department_id || null,
        employeeId: raw.employee_id || null,
        status: raw.status,
      });

      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные параметры выборки', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка загрузки передвижений';
      console.error('getTravelSegments error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },

  async rebuildTravelSegments(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const raw = segmentQuerySchema.parse({
        month: req.body?.month,
        department_id: await resolveScopedDepartmentId(
          req,
          typeof req.body?.department_id === 'string' ? req.body.department_id : null,
        ) || undefined,
        employee_id: req.body?.employee_id,
      });

      const data = await rebuildTravelSegmentsForScope({
        month: raw.month,
        departmentId: raw.department_id || null,
        employeeId: raw.employee_id || null,
      });

      res.json({ success: true, data });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: 'Некорректные параметры пересчёта', details: error.errors });
        return;
      }
      const message = error instanceof Error ? error.message : 'Ошибка пересчёта передвижений';
      console.error('rebuildTravelSegments error:', error);
      res.status(500).json({ success: false, error: message });
    }
  },
};
