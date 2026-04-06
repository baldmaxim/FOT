import { Response } from 'express';
import { z } from 'zod';
import { supabase } from '../config/database.js';
import { auditService } from '../services/audit.service.js';
import type { AuthenticatedRequest, UserProfile } from '../types/index.js';
import { logSupabaseError } from './admin-helpers.js';
import { getRoleByCode } from '../services/roles-cache.service.js';

const approveUserSchema = z.object({
  position_type: z.string().optional(),
  employee_id: z.number().int().positive().optional(),
});

export const adminUsersController = {
  async getAllUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error: usersError } = await supabase
        .from('user_profiles')
        .select('*')
        .order('created_at', { ascending: false });

      if (usersError) {
        logSupabaseError('GetUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch users' });
        return;
      }

      // Подгружаем department_id из employees для пользователей с employee_id
      const empIds = users
        .filter((u: UserProfile) => u.employee_id)
        .map((u: UserProfile) => u.employee_id);

      let empDeptMap: Record<number, string | null> = {};
      if (empIds.length > 0) {
        const { data: emps } = await supabase
          .from('employees')
          .select('id, org_department_id')
          .in('id', empIds);
        if (emps) {
          empDeptMap = emps.reduce((acc, e) => {
            acc[e.id] = e.org_department_id || null;
            return acc;
          }, {} as Record<number, string | null>);
        }
      }

      // Подгружаем названия отделов
      const deptIds = Object.values(empDeptMap).filter(Boolean) as string[];
      let deptNameMap: Record<string, string> = {};
      if (deptIds.length > 0) {
        const { data: depts } = await supabase
          .from('org_departments')
          .select('id, name')
          .in('id', deptIds);
        if (depts) {
          deptNameMap = depts.reduce((acc, d) => {
            acc[d.id] = d.name;
            return acc;
          }, {} as Record<string, string>);
        }
      }

      // Подгружаем email и статус подтверждения из Supabase Auth
      const authEmailMap: Record<string, { email: string; email_confirmed: boolean }> = {};
      try {
        const perPage = 1000;
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          const { data: authData, error: authError } = await supabase.auth.admin.listUsers({ page, perPage });
          if (authError) {
            console.error('[GetUsers] listUsers error:', authError);
            break;
          }
          if (authData?.users) {
            for (const au of authData.users) {
              authEmailMap[au.id] = {
                email: au.email || '',
                email_confirmed: !!au.email_confirmed_at,
              };
            }
            hasMore = authData.users.length === perPage;
            page++;
          } else {
            hasMore = false;
          }
        }
      } catch (err) {
        console.error('[GetUsers] Auth fetch error:', err);
      }

      const sanitizedUsers = users.map((u: UserProfile) => {
        const deptId = u.employee_id ? empDeptMap[u.employee_id] || null : null;
        const authInfo = authEmailMap[u.id];
        return {
          id: u.id,
          email: authInfo?.email || '',
          email_confirmed: authInfo?.email_confirmed ?? false,
          full_name: u.full_name,
          department_id: deptId,
          department_name: deptId ? (deptNameMap[deptId] || null) : null,
          position_type: u.position_type,
          imported_position: u.imported_position,
          employee_id: u.employee_id,
          supervisor_id: u.supervisor_id,
          is_approved: u.is_approved,
          two_factor_enabled: u.two_factor_enabled,
          approved_at: u.approved_at,
          created_at: u.created_at,
        };
      });

      res.json({ success: true, data: sanitizedUsers });
    } catch (error) {
      console.error('[GetUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch users' });
    }
  },

  async getPendingUsers(_req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { data: users, error: usersError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('is_approved', false)
        .order('created_at', { ascending: false });

      if (usersError) {
        logSupabaseError('GetPendingUsers', usersError);
        res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
        return;
      }

      if (!users || users.length === 0) {
        res.json({ success: true, data: [] });
        return;
      }

      const usersWithEmail = await Promise.all(
        users.map(async (u: UserProfile) => {
          let email = '';
          let emailConfirmed = false;
          try {
            const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(u.id);
            if (authError) {
              console.error(`Failed to get email for user ${u.id}:`, authError);
            }
            email = authUser?.user?.email || '';
            emailConfirmed = !!authUser?.user?.email_confirmed_at;
          } catch (e) {
            console.error('Failed to get user email:', e);
          }

          return {
            id: u.id,
            email,
            email_confirmed: emailConfirmed,
            full_name: u.full_name,
            position_type: u.position_type,
            imported_position: u.imported_position,
            created_at: u.created_at,
          };
        })
      );

      res.json({ success: true, data: usersWithEmail });
    } catch (error) {
      console.error('[GetPendingUsers-Catch] Error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ success: false, error: 'Failed to fetch pending users' });
    }
  },

  async approveUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type, employee_id } = approveUserSchema.parse(req.body);

      const { data: profile, error: fetchError } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !profile) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }

      const updateData: Record<string, unknown> = {
        is_approved: true,
        approved_by: req.user.id,
        approved_at: new Date().toISOString(),
      };

      if (position_type) {
        updateData.position_type = position_type;
      }
      if (employee_id) {
        updateData.employee_id = employee_id;
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
        details: { position_type },
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

  async rejectUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to reject user' });
        return;
      }

      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
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

  async deleteUser(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const { data: profile } = await supabase
        .from('user_profiles')
        .select('position_type')
        .eq('id', id)
        .single();

      if (profile?.position_type === 'super_admin') {
        res.status(403).json({ success: false, error: 'Cannot delete super_admin' });
        return;
      }

      const { error: profileError } = await supabase
        .from('user_profiles')
        .delete()
        .eq('id', id);

      if (profileError) {
        console.error('Delete profile error:', profileError);
        res.status(500).json({ success: false, error: 'Failed to delete user' });
        return;
      }

      const { error: authError } = await supabase.auth.admin.deleteUser(id);

      if (authError) {
        console.error('Delete auth user error:', authError);
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

  async updateUserPosition(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { position_type } = z.object({
        position_type: z.string().min(1)
      }).parse(req.body);

      const role = await getRoleByCode(position_type);
      if (!role) {
        res.status(400).json({ success: false, error: 'Роль не найдена' });
        return;
      }

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

  async updateUserEmployee(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { employee_id, department_id } = z.object({
        employee_id: z.number().int().positive().nullable(),
        department_id: z.string().uuid().nullable().optional(),
      }).parse(req.body);

      const { error } = await supabase
        .from('user_profiles')
        .update({ employee_id })
        .eq('id', id);

      if (error) {
        res.status(500).json({ success: false, error: 'Failed to update employee link' });
        return;
      }

      // Если указан отдел и сотрудник — обновляем org_department_id сотрудника
      if (employee_id && department_id) {
        await supabase
          .from('employees')
          .update({ org_department_id: department_id })
          .eq('id', employee_id);
      }

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee error:', error);
      res.status(500).json({ success: false, error: 'Failed to update employee link' });
    }
  },

  /** Обновить отдел привязанного сотрудника */
  async updateEmployeeDepartment(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { department_id } = z.object({
        department_id: z.string().uuid(),
      }).parse(req.body);

      // Получаем employee_id пользователя
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('employee_id')
        .eq('id', id)
        .single();

      if (!profile?.employee_id) {
        res.status(400).json({ success: false, error: 'У пользователя нет привязки к сотруднику' });
        return;
      }

      const { error } = await supabase
        .from('employees')
        .update({ org_department_id: department_id })
        .eq('id', profile.employee_id);

      if (error) {
        res.status(500).json({ success: false, error: 'Failed to update department' });
        return;
      }

      res.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ success: false, error: error.errors[0].message });
        return;
      }
      console.error('Update employee department error:', error);
      res.status(500).json({ success: false, error: 'Failed to update department' });
    }
  },

  async searchUnlinkedEmployees(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const q = (req.query.q as string || '').trim();

      if (!q || q.length < 2) {
        res.json({ success: true, data: [] });
        return;
      }

      const { data: linkedProfiles } = await supabase
        .from('user_profiles')
        .select('employee_id')
        .not('employee_id', 'is', null);

      const linkedIds = (linkedProfiles || [])
        .map((p: { employee_id: number | null }) => p.employee_id)
        .filter((id): id is number => id !== null);

      let query = supabase
        .from('employees')
        .select('id, full_name, org_department_id')
        .ilike('full_name', `%${q}%`)
        .eq('employment_status', 'active')
        .limit(20);

      if (linkedIds.length > 0) {
        query = query.not('id', 'in', `(${linkedIds.join(',')})`);
      }

      const { data: employees, error } = await query;

      if (error) {
        logSupabaseError('SearchUnlinkedEmployees', error);
        res.status(500).json({ success: false, error: 'Failed to search employees' });
        return;
      }

      res.json({ success: true, data: employees || [] });
    } catch (error) {
      console.error('Search unlinked employees error:', error);
      res.status(500).json({ success: false, error: 'Failed to search employees' });
    }
  },
};
