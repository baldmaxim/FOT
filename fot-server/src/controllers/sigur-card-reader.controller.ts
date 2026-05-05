import { Response } from 'express';
import { AxiosError } from 'axios';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import { sigurService } from '../services/sigur.service.js';
import { resolveField } from '../services/sigur-sync-shared.js';
import { loadStructureCache } from '../services/employee-mapper.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

interface ICardSummary {
  cardId: number;
  cardNumber: string | null;
  status: string | null;
  format: string | null;
  startDate: string | null;
  expirationDate: string | null;
}

interface IEmployeeBrief {
  id: number;
  full_name: string;
  position_name: string | null;
  department: string | null;
  tab_number: string | null;
  sigur_employee_id: number | null;
}

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const trimOrNull = (value: unknown): string | null => {
  const str = typeof value === 'string' ? value : value != null ? String(value) : '';
  const trimmed = str.trim();
  return trimmed || null;
};

const toCardSummary = (raw: Record<string, unknown>): ICardSummary | null => {
  const cardId = normalizeInt(resolveField(raw, 'id', 'ID', 'Id', 'cardId', 'card_id', 'cardID'));
  if (!cardId) return null;
  return {
    cardId,
    cardNumber: trimOrNull(resolveField(raw, 'number', 'Number', 'cardNumber', 'card_number', 'serialNumber', 'serial_number')),
    status: trimOrNull(resolveField(raw, 'status', 'Status', 'state')),
    format: trimOrNull(resolveField(raw, 'format', 'Format', 'cardFormat')),
    startDate: trimOrNull(resolveField(raw, 'startDate', 'start_date', 'validFrom', 'startAt')),
    expirationDate: trimOrNull(resolveField(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo')),
  };
};

const toBindingEmployeeId = (raw: Record<string, unknown>): number | null => {
  return normalizeInt(resolveField(raw, 'employeeId', 'employee_id'));
};

const ensureSigurReady = async (res: Response): Promise<boolean> => {
  if (await sigurService.isConfigured()) return true;
  res.status(503).json({ success: false, error: 'Sigur не настроен' });
  return false;
};

const handleSigurError = (res: Response, err: unknown, fallback: string): void => {
  console.error(fallback, err);
  if (err instanceof AxiosError && err.response?.status) {
    const data = err.response.data as Record<string, unknown> | string | undefined;
    let message = fallback;
    if (typeof data === 'string' && data.trim()) message = data.trim();
    else if (data && typeof data === 'object') {
      const m = data.message ?? data.error ?? data.detail;
      if (typeof m === 'string' && m.trim()) message = m.trim();
    }
    res.status(err.response.status).json({ success: false, error: message });
    return;
  }
  res.status(500).json({ success: false, error: fallback });
};

const fetchEmployeeBySigurId = async (sigurEmployeeId: number): Promise<IEmployeeBrief | null> => {
  const { data, error } = await supabase
    .from('employees')
    .select('id, full_name, position_id, org_department_id, tab_number, sigur_employee_id, is_archived')
    .eq('sigur_employee_id', sigurEmployeeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const cache = await loadStructureCache();
  return {
    id: data.id,
    full_name: data.full_name || '',
    position_name: data.position_id ? cache.positions.get(data.position_id) || null : null,
    department: data.org_department_id ? cache.departments.get(data.org_department_id) || null : null,
    tab_number: data.tab_number || null,
    sigur_employee_id: data.sigur_employee_id,
  };
};

export const sigurCardReaderController = {
  async lookup(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const uid = typeof req.query.uid === 'string' ? req.query.uid.trim() : '';
      if (!uid) {
        res.status(400).json({ success: false, error: 'uid обязателен' });
        return;
      }
      if (!(await ensureSigurReady(res))) return;

      const cardsRaw = await sigurService.findCardsByNumber(uid);
      const cards = cardsRaw.map(toCardSummary).filter((c): c is ICardSummary => !!c);

      if (cards.length === 0) {
        res.json({ success: true, data: { found: false, uid } });
        return;
      }

      const card = cards[0];
      const bindingsRaw = await sigurService.getCardBindings({ cardId: card.cardId }) as Record<string, unknown>[];
      const sigurEmployeeId = bindingsRaw.map(toBindingEmployeeId).find((id): id is number => !!id) || null;

      let employee: IEmployeeBrief | null = null;
      if (sigurEmployeeId) {
        try {
          employee = await fetchEmployeeBySigurId(sigurEmployeeId);
        } catch (err) {
          console.warn('[card-reader] employee lookup failed:', err);
        }
      }

      res.json({
        success: true,
        data: {
          found: true,
          uid,
          card,
          sigurEmployeeId,
          employee,
        },
      });
    } catch (err) {
      handleSigurError(res, err, 'Ошибка поиска карты в Sigur');
    }
  },

  async assign(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { uid, employeeId, expirationDate } = req.body as {
        uid?: unknown;
        employeeId?: unknown;
        expirationDate?: unknown;
      };
      if (typeof uid !== 'string' || !uid.trim()) {
        res.status(400).json({ success: false, error: 'uid обязателен' });
        return;
      }
      const fotEmployeeId = normalizeInt(employeeId);
      if (!fotEmployeeId) {
        res.status(400).json({ success: false, error: 'employeeId обязателен' });
        return;
      }
      if (!(await ensureSigurReady(res))) return;

      const { data: emp, error: empErr } = await supabase
        .from('employees')
        .select('id, full_name, sigur_employee_id, is_archived')
        .eq('id', fotEmployeeId)
        .maybeSingle();
      if (empErr) throw empErr;
      if (!emp) {
        res.status(404).json({ success: false, error: 'Сотрудник не найден' });
        return;
      }
      if (emp.is_archived) {
        res.status(400).json({ success: false, error: 'Сотрудник в архиве' });
        return;
      }
      if (!emp.sigur_employee_id) {
        res.status(400).json({ success: false, error: 'Сотрудник не связан с Sigur — сначала синхронизируйте структуру' });
        return;
      }

      const cardsRaw = await sigurService.findCardsByNumber(uid.trim());
      const cards = cardsRaw.map(toCardSummary).filter((c): c is ICardSummary => !!c);
      if (cards.length === 0) {
        res.status(404).json({
          success: false,
          error: 'Карта не найдена в Sigur. Создайте карту в Sigur Manager перед привязкой.',
        });
        return;
      }
      const card = cards[0];

      const startIso = new Date().toISOString();
      let expiresIso: string;
      if (typeof expirationDate === 'string' && expirationDate.trim()) {
        const parsed = new Date(expirationDate);
        if (Number.isNaN(parsed.getTime())) {
          res.status(400).json({ success: false, error: 'Некорректная дата срока действия' });
          return;
        }
        expiresIso = parsed.toISOString();
      } else {
        const inFiveYears = new Date();
        inFiveYears.setFullYear(inFiveYears.getFullYear() + 5);
        expiresIso = inFiveYears.toISOString();
      }

      const existingBindings = await sigurService.getCardBindings({ cardId: card.cardId }) as Record<string, unknown>[];
      const existingEmployeeId = existingBindings.map(toBindingEmployeeId).find((id): id is number => !!id) || null;

      if (existingEmployeeId === emp.sigur_employee_id) {
        await sigurService.patchEmployeeCardBinding(
          emp.sigur_employee_id,
          card.cardId,
          startIso,
          expiresIso,
          undefined,
          card.format || undefined,
        );
      } else {
        await sigurService.createEmployeeCardBinding(
          emp.sigur_employee_id,
          card.cardId,
          startIso,
          expiresIso,
          undefined,
          card.format || undefined,
        );
      }

      await auditService.logFromRequest(req, req.user.id, 'UPDATE_EMPLOYEE', {
        entityType: 'sigur_card_binding',
        entityId: `${fotEmployeeId}:${card.cardId}`,
        details: {
          source: 'card-reader',
          uid: uid.trim(),
          employeeId: fotEmployeeId,
          sigurEmployeeId: emp.sigur_employee_id,
          cardId: card.cardId,
          startDate: startIso,
          expirationDate: expiresIso,
          replacedSigurEmployeeId: existingEmployeeId && existingEmployeeId !== emp.sigur_employee_id ? existingEmployeeId : undefined,
        },
      });

      res.json({
        success: true,
        data: {
          card: { ...card, startDate: startIso, expirationDate: expiresIso },
          employeeId: fotEmployeeId,
          sigurEmployeeId: emp.sigur_employee_id,
        },
      });
    } catch (err) {
      handleSigurError(res, err, 'Ошибка привязки карты');
    }
  },
};
