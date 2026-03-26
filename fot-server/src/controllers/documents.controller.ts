import type { Response } from 'express';
import { supabase } from '../config/database.js';
import { r2Service } from '../services/r2.service.js';
import type { AuthenticatedRequest } from '../types/index.js';

const DOCUMENT_CATEGORIES = ['certificate', 'scan', 'approval', 'payslip', 'other'] as const;

/** Получить presigned URL для загрузки */
const getUploadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!r2Service.isEnabled()) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }

    const { employee_id, file_name, content_type, category, leave_request_id } = req.body;
    if (!employee_id || !file_name || !content_type || !category) {
      res.status(400).json({ success: false, error: 'employee_id, file_name, content_type, category обязательны' });
      return;
    }
    if (!DOCUMENT_CATEGORIES.includes(category)) {
      res.status(400).json({ success: false, error: 'Недопустимая категория документа' });
      return;
    }

    const orgId = req.user.organization_id;
    if (!orgId) {
      res.status(400).json({ success: false, error: 'Организация не определена' });
      return;
    }

    const r2Key = r2Service.generateKey(orgId, employee_id, file_name);
    const uploadUrl = await r2Service.generateUploadUrl(r2Key, content_type);

    res.json({
      success: true,
      data: {
        upload_url: uploadUrl,
        r2_key: r2Key,
        employee_id,
        file_name,
        content_type,
        category,
        leave_request_id: leave_request_id || null,
      },
    });
  } catch (err) {
    console.error('documents.getUploadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка генерации URL' });
  }
};

/** Подтвердить загрузку — создать запись в БД */
const confirmUpload = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { r2_key, employee_id, file_name, file_size, mime_type, category, leave_request_id } = req.body;
    if (!r2_key || !employee_id || !file_name || !file_size || !mime_type || !category) {
      res.status(400).json({ success: false, error: 'Все поля обязательны' });
      return;
    }

    const { data, error } = await supabase
      .from('documents')
      .insert({
        organization_id: req.user.organization_id,
        employee_id,
        leave_request_id: leave_request_id || null,
        category,
        file_name,
        file_size,
        mime_type,
        r2_key,
        uploaded_by: req.user.id,
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('documents.confirmUpload error:', err);
    res.status(500).json({ success: false, error: 'Ошибка сохранения документа' });
  }
};

/** Получить presigned URL для скачивания */
const getDownloadUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!r2Service.isEnabled()) {
      res.status(503).json({ success: false, error: 'R2 хранилище не настроено' });
      return;
    }

    const { id } = req.params;
    const { data: doc, error } = await supabase
      .from('documents')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }

    // Проверка доступа: worker видит только свои
    if (req.user.position_type === 'worker' && doc.employee_id !== req.user.employee_id) {
      res.status(403).json({ success: false, error: 'Нет доступа' });
      return;
    }

    const downloadUrl = await r2Service.generateDownloadUrl(doc.r2_key);
    res.json({ success: true, data: { download_url: downloadUrl, file_name: doc.file_name } });
  } catch (err) {
    console.error('documents.getDownloadUrl error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения URL' });
  }
};

/** Мои документы (worker) */
const getMy = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const employeeId = req.user.employee_id;
    if (!employeeId) {
      res.json({ success: true, data: [] });
      return;
    }

    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('employee_id', employeeId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('documents.getMy error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения документов' });
  }
};

/** Документы сотрудника (header/hr/admin) */
const getByEmployee = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { empId } = req.params;

    const { data, error } = await supabase
      .from('documents')
      .select('*')
      .eq('employee_id', empId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('documents.getByEmployee error:', err);
    res.status(500).json({ success: false, error: 'Ошибка получения документов' });
  }
};

/** Удаление документа (hr/admin) */
const remove = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;

    const { data: doc, error: fetchErr } = await supabase
      .from('documents')
      .select('r2_key')
      .eq('id', id)
      .single();

    if (fetchErr || !doc) {
      res.status(404).json({ success: false, error: 'Документ не найден' });
      return;
    }

    // Удаляем из R2
    if (r2Service.isEnabled()) {
      try {
        await r2Service.deleteObject(doc.r2_key);
      } catch {
        // Не блокируем удаление записи из БД
      }
    }

    const { error } = await supabase.from('documents').delete().eq('id', id);
    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('documents.remove error:', err);
    res.status(500).json({ success: false, error: 'Ошибка удаления документа' });
  }
};

export const documentsController = {
  getUploadUrl,
  confirmUpload,
  getDownloadUrl,
  getMy,
  getByEmployee,
  remove,
};
