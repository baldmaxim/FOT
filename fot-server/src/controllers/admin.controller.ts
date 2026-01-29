import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { totpService } from '../services/totp.service.js';
import { auditService } from '../services/audit.service.js';
import { encryptionService } from '../services/encryption.service.js';
import type { AuthenticatedRequest, UserProfile, OrganizationEncrypted, Organization } from '../types/index.js';

/**
 * Расшифровывает организацию
 */
function decryptOrganization(encrypted: OrganizationEncrypted): Organization {
  return {
    id: encrypted.id,
    name: encryptionService.decrypt(encrypted.name_encrypted),
    created_at: encrypted.created_at,
    updated_at: encrypted.updated_at,
  };
}

// Схемы валидации
const approveUserSchema = z.object({
  organization_id: z.string().uuid().optional(),
  position_type: z.enum(['worker', 'header', 'admin', 'super_admin']).optional(),
});

export const adminController = {
  /**
   * GET /api/admin/users
   * Получение списка всех пользователей (только super_admin)
   */
  async getAllUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error } = await supabase
        .from('user_profiles')
        .select(`
          *,
          organizations (id, name)
        `)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Get users error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
        return;
      }

      // Убираем чувствительные данные
      const sanitizedUsers = users.map((u: UserProfile & { organizations?: { id: string; name: string } }) => ({
        id: u.id,
        full_name: u.full_name,
        organization_id: u.organization_id,
        organization_name: u.organizations?.name || null,
        position_type: u.position_type,
        imported_position: u.imported_position,
        employee_id: u.employee_id,
        supervisor_id: u.supervisor_id,
        is_approved: u.is_approved,
        two_factor_enabled: u.two_factor_enabled,
        approved_at: u.approved_at,
        created_at: u.created_at,
      }));

      res.json({ success: true, data: sanitizedUsers });
    } catch (error) {
      console.error('Get users error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
  },

  /**
   * GET /api/admin/users/pending
   * Получение пользователей ожидающих одобрения
   */
  async getPendingUsers(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error } = await supabase
        .from('user_profiles')
        .select(`
          *,
          organizations (id, name)
        `)
        .eq('is_approved', false)
        .order('created_at', { ascending: false });

      if (error) {
        console.error('Get pending users error:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
        return;
      }

      // Получаем email из auth.users для каждого пользователя
      const usersWithEmail = await Promise.all(
        users.map(async (u: UserProfile & { organizations?: { id: string; name: string } }) => {
          let email = '';
          try {
            const { data: authUser } = await supabase.auth.admin.getUserById(u.id);
            email = authUser?.user?.email || '';
          } catch (e) {
            console.error('Failed to get user email:', e);
          }

          return {
            id: u.id,
            email,
            full_name: u.full_name,
            organization_id: u.organization_id,
            organization_name: u.organizations?.name || null,
            position_type: u.position_type,
            imported_position: u.imported_position,
            created_at: u.created_at,
          };
        })
      );

      res.json({ success: true, data: usersWithEmail });
    } catch (error) {
      console.error('Get pending users error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
    }
  },

  /**
   * POST /api/admin/users/:id/approve
   * Одобрение пользователя
   */
  async approveUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { organization_id, position_type } = approveUserSchema.parse(req.body);

      // Получаем текущий профиль
      const { data: profile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      // Обновляем профиль
      const updateData: Record<string, unknown> = {
        is_approved: true,
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
      };

      if (organization_id) {
        updateData.organization_id = organization_id;
      }
      if (position_type) {
        updateData.position_type = position_type;
      }

      const { error: updateError } = await supabase
        .from('user_profiles')
        .update(updateData)
        .eq('id', id);

      if (updateError) {
        console.error('Approve user error:', updateError);
        res.status(500).json({ success: false, error: 'Failed to approve user' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_APPROVED', {
        entityType: 'user',
        entityId: id,
        details: { position_type, organization_id },
      });

      res.json({ success: true, message: 'User approved successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Approve user error:', error);
      res.status(500).json({ success: false, error: 'Failed to approve user' });
    }
  },

  /**
   * POST /api/admin/users/:id/reject
   * Отклонение пользователя (удаление)
   */
  async rejectUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Сначала удаляем профиль
      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to reject user' });
        return;
      }

      // Затем удаляем из auth.users (чтобы пользователь мог зарегистрироваться снова)
      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
        // Не возвращаем ошибку, так как профиль уже удалён
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_REJECTED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User rejected and removed' });
    } catch (error) {
      console.error('Reject user error:', error);
      res.status(500).json({ success: false, error: 'Failed to reject user' });
    }
  },

  /**
   * DELETE /api/admin/users/:id
   * Удаление пользователя (полное удаление из системы)
   */
  async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Проверяем, что не пытаемся удалить super_admin
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('position_type')
        .eq('id', id)
        .single();

      if (profile?.position_type === 'super_admin') {
        res.status(403).json({ success: false, error: 'Cannot delete super_admin' });
        return;
      }

      // Удаляем профиль
      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
        return;
      }

      // Удаляем из auth.users
      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
        // Не возвращаем ошибку, так как профиль уже удалён
      }

      await auditService.logFromRequest(req, req.user.id, 'USER_DELETED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'User deleted successfully' });
    } catch (error) {
      console.error('Delete user error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete user' });
    }
  },

  /**
   * POST /api/admin/users/:id/confirm-email
   * Подтверждение email пользователя (для исправления старых регистраций)
   */
  async confirmUserEmail(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { error } = await supabase.auth.admin.updateUserById(id, {
        email_confirm: true,
      });

      if (error) {
        console.error('Confirm email error:', error);
        res.status(500).json({ success: false, error: 'Failed to confirm email' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'EMAIL_CONFIRMED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: 'Email confirmed successfully' });
    } catch (error) {
      console.error('Confirm email error:', error);
      res.status(500).json({ success: false, error: 'Failed to confirm email' });
    }
  },

  /**
   * PATCH /api/admin/users/:id/position
   * Изменение должности пользователя
   */
  async updateUserPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type } = z.object({
        position_type: z.enum(['worker', 'header', 'admin', 'super_admin'])
      }).parse(req.body);

      // Нельзя изменить должность super_admin
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('position_type')
        .eq('id', id)
        .single();

      if (profile?.position_type === 'super_admin') {
        res.status(403).json({ success: false, error: 'Cannot change super_admin position' });
        return;
      }

      const { error } = await supabase
        .from('user_profiles')
        .update({ position_type })
        .eq('id', id);

      if (error) {
        console.error('Update position error:', error);
        res.status(500).json({ success: false, error: 'Failed to update position' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'POSITION_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { new_position_type: position_type },
      });

      res.json({ success: true, message: 'Position updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update position error:', error);
      res.status(500).json({ success: false, error: 'Failed to update position' });
    }
  },

  /**
   * PATCH /api/admin/users/:id/organization
   * Назначение организации пользователю
   */
  async assignOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { organization_id } = z.object({ organization_id: z.string().uuid() }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ organization_id })
        .eq('id', id);

      if (error) {
        console.error('Assign organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to assign organization' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'ORG_ASSIGNED', {
        entityType: 'user',
        entityId: id,
        details: { organization_id },
      });

      res.json({ success: true, message: 'Organization assigned successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Assign organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to assign organization' });
    }
  },

  /**
   * PATCH /api/admin/users/:id/name
   * Изменение ФИО пользователя
   */
  async updateUserName(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { full_name } = z.object({ full_name: z.string().min(2).max(255) }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ full_name: full_name.trim() })
        .eq('id', id);

      if (error) {
        console.error('Update name error:', error);
        res.status(500).json({ success: false, error: 'Failed to update name' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'NAME_CHANGED', {
        entityType: 'user',
        entityId: id,
        details: { full_name },
      });

      res.json({ success: true, message: 'Name updated successfully' });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update name error:', error);
      res.status(500).json({ success: false, error: 'Failed to update name' });
    }
  },

  /**
   * POST /api/admin/users/:id/generate-2fa
   * Генерация 2FA для пользователя (только super_admin)
   */
  async generate2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Получаем пользователя
      const { data: profile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      // Получаем email из auth.users
      const { data: authUser } = await supabase.auth.admin.getUserById(id);

      if (!authUser?.user?.email) {
        res.status(400).json({ success: false, error: 'User email not found' });
        return;
      }

      // Генерируем TOTP секрет
      const { secret, encryptedSecret } = totpService.generateSecret(authUser.user.email);

      // Генерируем коды восстановления
      const { codes, encryptedCodes } = totpService.generateRecoveryCodes();

      // Генерируем QR-код
      const qrCode = await totpService.generateQRCode(authUser.user.email, secret);

      // Сохраняем в БД
      const { error: updateError } = await supabase
        .from('user_profiles')
        .update({
          totp_secret: encryptedSecret,
          recovery_codes: encryptedCodes,
          two_factor_enabled: true,
        })
        .eq('id', id);

      if (updateError) {
        console.error('Update 2FA error:', updateError);
        res.status(500).json({ success: false, error: 'Failed to save 2FA settings' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_ENABLED', {
        entityType: 'user',
        entityId: id,
      });

      // Возвращаем данные для передачи пользователю
      res.json({
        success: true,
        data: {
          secret, // Для ручного ввода
          qr_code: qrCode, // Data URL для QR-кода
          recovery_codes: codes.map(totpService.formatRecoveryCode), // Форматированные коды
        },
        message: 'Передайте эти данные пользователю безопасным способом',
      });
    } catch (error) {
      console.error('Generate 2FA error:', error);
      res.status(500).json({ success: false, error: 'Failed to generate 2FA' });
    }
  },

  /**
   * POST /api/admin/users/:id/disable-2fa
   * Отключение 2FA для пользователя (при утере устройства)
   */
  async disable2FA(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { error } = await supabase
        .from('user_profiles')
        .update({
          totp_secret: null,
          recovery_codes: null,
          two_factor_enabled: false,
        })
        .eq('id', id);

      if (error) {
        console.error('Disable 2FA error:', error);
        res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, '2FA_DISABLED', {
        entityType: 'user',
        entityId: id,
      });

      res.json({ success: true, message: '2FA disabled for user' });
    } catch (error) {
      console.error('Disable 2FA error:', error);
      res.status(500).json({ success: false, error: 'Failed to disable 2FA' });
    }
  },

  /**
   * GET /api/admin/organizations
   * Получение списка организаций с количеством сотрудников
   */
  async getOrganizations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // Получаем организации
      const { data: orgsEncrypted, error: orgsError } = await supabase
        .from('organizations')
        .select('*')
        .order('created_at');

      if (orgsError) {
        console.error('Get organizations error:', orgsError);
        res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
        return;
      }

      // Расшифровываем организации
      const orgs = (orgsEncrypted as OrganizationEncrypted[] || []).map(decryptOrganization);

      // Получаем количество сотрудников для каждой организации
      const { data: memberCounts, error: countError } = await supabase
        .from('user_profiles')
        .select('organization_id')
        .not('organization_id', 'is', null);

      if (countError) {
        console.error('Get member counts error:', countError);
      }

      // Подсчитываем количество членов для каждой организации
      const countMap: Record<string, number> = {};
      if (memberCounts) {
        memberCounts.forEach((m: { organization_id: string | null }) => {
          if (m.organization_id) {
            countMap[m.organization_id] = (countMap[m.organization_id] || 0) + 1;
          }
        });
      }

      // Добавляем member_count к каждой организации и сортируем по имени
      const orgsWithStats = orgs
        .map(org => ({
          ...org,
          member_count: countMap[org.id] || 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

      res.json({ success: true, data: orgsWithStats });
    } catch (error) {
      console.error('Get organizations error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch organizations' });
    }
  },

  /**
   * POST /api/admin/organizations
   * Создание новой организации
   */
  async createOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { name } = z.object({ name: z.string().min(2).max(255) }).parse(req.body);

      const { data: encrypted, error } = await supabase
        .from('organizations')
        .insert({ name_encrypted: encryptionService.encrypt(name.trim()) })
        .select()
        .single();

      if (error) {
        console.error('Create organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to create organization' });
        return;
      }

      const org = decryptOrganization(encrypted as OrganizationEncrypted);

      await auditService.logFromRequest(req, req.user.id, 'ORG_CREATED', {
        entityType: 'organization',
        entityId: org.id,
        details: { name },
      });

      res.status(201).json({ success: true, data: org });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Create organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to create organization' });
    }
  },

  /**
   * PATCH /api/admin/organizations/:id
   * Обновление организации
   */
  async updateOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { name } = z.object({ name: z.string().min(2).max(255) }).parse(req.body);

      const { data: encrypted, error } = await supabase
        .from('organizations')
        .update({
          name_encrypted: encryptionService.encrypt(name.trim()),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        console.error('Update organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to update organization' });
        return;
      }

      if (!encrypted) {
        res.status(404).json({ success: false, error: 'Organization not found' });
        return;
      }

      const org = decryptOrganization(encrypted as OrganizationEncrypted);

      await auditService.logFromRequest(req, req.user.id, 'ORG_UPDATED', {
        entityType: 'organization',
        entityId: id,
        details: { name },
      });

      res.json({ success: true, data: org });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to update organization' });
    }
  },

  /**
   * DELETE /api/admin/organizations/:id
   * Удаление организации (только если нет сотрудников)
   */
  async deleteOrganization(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // Проверяем, есть ли сотрудники в организации
      const { data: members, error: checkError } = await supabase
        .from('user_profiles')
        .select('id')
        .eq('organization_id', id)
        .limit(1);

      if (checkError) {
        console.error('Check members error:', checkError);
        res.status(500).json({ success: false, error: 'Failed to check organization members' });
        return;
      }

      if (members && members.length > 0) {
        res.status(400).json({
          success: false,
          error: 'Cannot delete organization with members. Remove all members first.',
        });
        return;
      }

      const { error } = await supabase
        .from('organizations')
        .delete()
        .eq('id', id);

      if (error) {
        console.error('Delete organization error:', error);
        res.status(500).json({ success: false, error: 'Failed to delete organization' });
        return;
      }

      await auditService.logFromRequest(req, req.user.id, 'ORG_DELETED', {
        entityType: 'organization',
        entityId: id,
      });

      res.json({ success: true, message: 'Organization deleted successfully' });
    } catch (error) {
      console.error('Delete organization error:', error);
      res.status(500).json({ success: false, error: 'Failed to delete organization' });
    }
  },

  /**
   * GET /api/admin/audit-logs
   * Получение логов аудита
   */
  async getAuditLogs(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
      const offset = parseInt(req.query.offset as string) || 0;

      const { data, count } = await auditService.getAll(limit, offset);

      res.json({
        success: true,
        data,
        pagination: {
          limit,
          offset,
          total: count,
        },
      });
    } catch (error) {
      console.error('Get audit logs error:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch audit logs' });
    }
  },
};
