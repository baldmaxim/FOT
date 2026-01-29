import { apiClient } from './client';
import type {
  OrgCompany,
  OrgDepartment,
  OrgSubdivision,
  OrgSite,
  OrgStructureResponse,
  OrgStructureResponseExtended,
} from '../types';

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export const structureApi = {
  /**
   * Получить дерево структуры организации
   */
  async getTree(): Promise<ApiResponse<OrgStructureResponse>> {
    try {
      return await apiClient.get<ApiResponse<OrgStructureResponse>>('/structure');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  /**
   * Создать компанию
   */
  async createCompany(name: string, description?: string): Promise<ApiResponse<OrgCompany>> {
    try {
      return await apiClient.post<ApiResponse<OrgCompany>>('/structure/companies', {
        name,
        description,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания компании',
      };
    }
  },

  /**
   * Создать отдел
   */
  async createDepartment(
    name: string,
    companyId: string | null,
    description?: string
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      return await apiClient.post<ApiResponse<OrgDepartment>>('/structure/departments', {
        name,
        company_id: companyId,
        description,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания отдела',
      };
    }
  },

  /**
   * Создать подразделение
   */
  async createSubdivision(
    name: string,
    departmentId: string | null,
    description?: string
  ): Promise<ApiResponse<OrgSubdivision>> {
    try {
      return await apiClient.post<ApiResponse<OrgSubdivision>>('/structure/subdivisions', {
        name,
        department_id: departmentId,
        description,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания подразделения',
      };
    }
  },

  /**
   * Удалить компанию
   */
  async deleteCompany(id: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/companies/${id}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления компании',
      };
    }
  },

  /**
   * Удалить отдел
   */
  async deleteDepartment(id: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/departments/${id}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления отдела',
      };
    }
  },

  /**
   * Удалить подразделение
   */
  async deleteSubdivision(id: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/subdivisions/${id}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления подразделения',
      };
    }
  },

  // ============================================
  // Методы для строительных участков (sites)
  // ============================================

  /**
   * Получить список всех участков
   */
  async getSites(): Promise<ApiResponse<OrgSite[]>> {
    try {
      return await apiClient.get<ApiResponse<OrgSite[]>>('/structure/sites');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки участков',
      };
    }
  },

  /**
   * Получить участок по ID
   */
  async getSiteById(id: string): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.get<ApiResponse<OrgSite>>(`/structure/sites/${id}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки участка',
      };
    }
  },

  /**
   * Создать строительный участок
   */
  async createSite(data: {
    name: string;
    company_id?: string | null;
    department_id?: string | null;
    code?: string;
    description?: string;
    address?: string;
    manager_id?: number | null;
    start_date?: string;
    planned_end_date?: string;
    status?: 'planning' | 'active' | 'completed' | 'suspended';
  }): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.post<ApiResponse<OrgSite>>('/structure/sites', data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания участка',
      };
    }
  },

  /**
   * Обновить участок
   */
  async updateSite(
    id: string,
    data: Partial<{
      name: string;
      company_id: string | null;
      department_id: string | null;
      code: string | null;
      description: string | null;
      address: string | null;
      manager_id: number | null;
      start_date: string | null;
      planned_end_date: string | null;
      status: 'planning' | 'active' | 'completed' | 'suspended';
      is_active: boolean;
      sort_order: number;
    }>
  ): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${id}`, data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка обновления участка',
      };
    }
  },

  /**
   * Удалить участок
   */
  async deleteSite(id: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/sites/${id}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления участка',
      };
    }
  },

  /**
   * Получить расширенное дерево структуры (с участками)
   */
  async getTreeExtended(): Promise<ApiResponse<OrgStructureResponseExtended>> {
    try {
      return await apiClient.get<ApiResponse<OrgStructureResponseExtended>>('/structure/extended');
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  /**
   * Назначить менеджера участка
   */
  async setSiteManager(siteId: string, managerId: number | null): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${siteId}/manager`, {
        manager_id: managerId,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка назначения менеджера',
      };
    }
  },

  /**
   * Изменить статус участка
   */
  async setSiteStatus(
    siteId: string,
    status: 'planning' | 'active' | 'completed' | 'suspended'
  ): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${siteId}/status`, {
        status,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка изменения статуса',
      };
    }
  },
};
