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

const orgQuery = (orgId?: string) => orgId ? `?organization_id=${orgId}` : '';

export const structureApi = {
  async getTree(organizationId?: string): Promise<ApiResponse<OrgStructureResponse>> {
    try {
      return await apiClient.get<ApiResponse<OrgStructureResponse>>(`/structure${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  async createCompany(name: string, description?: string, organizationId?: string): Promise<ApiResponse<OrgCompany>> {
    try {
      return await apiClient.post<ApiResponse<OrgCompany>>(`/structure/companies${orgQuery(organizationId)}`, {
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

  async createDepartment(
    name: string,
    companyId: string | null,
    description?: string,
    organizationId?: string
  ): Promise<ApiResponse<OrgDepartment>> {
    try {
      return await apiClient.post<ApiResponse<OrgDepartment>>(`/structure/departments${orgQuery(organizationId)}`, {
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

  async createSubdivision(
    name: string,
    departmentId: string | null,
    description?: string,
    organizationId?: string
  ): Promise<ApiResponse<OrgSubdivision>> {
    try {
      return await apiClient.post<ApiResponse<OrgSubdivision>>(`/structure/subdivisions${orgQuery(organizationId)}`, {
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

  async deleteCompany(id: string, organizationId?: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/companies/${id}${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления компании',
      };
    }
  },

  async deleteDepartment(id: string, organizationId?: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/departments/${id}${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления отдела',
      };
    }
  },

  async deleteSubdivision(id: string, organizationId?: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/subdivisions/${id}${orgQuery(organizationId)}`);
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

  async getSites(organizationId?: string): Promise<ApiResponse<OrgSite[]>> {
    try {
      return await apiClient.get<ApiResponse<OrgSite[]>>(`/structure/sites${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки участков',
      };
    }
  },

  async getSiteById(id: string, organizationId?: string): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.get<ApiResponse<OrgSite>>(`/structure/sites/${id}${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки участка',
      };
    }
  },

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
  }, organizationId?: string): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.post<ApiResponse<OrgSite>>(`/structure/sites${orgQuery(organizationId)}`, data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка создания участка',
      };
    }
  },

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
    }>,
    organizationId?: string
  ): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${id}${orgQuery(organizationId)}`, data);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка обновления участка',
      };
    }
  },

  async deleteSite(id: string, organizationId?: string): Promise<ApiResponse<void>> {
    try {
      return await apiClient.delete<ApiResponse<void>>(`/structure/sites/${id}${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка удаления участка',
      };
    }
  },

  async getTreeExtended(organizationId?: string): Promise<ApiResponse<OrgStructureResponseExtended>> {
    try {
      return await apiClient.get<ApiResponse<OrgStructureResponseExtended>>(`/structure/extended${orgQuery(organizationId)}`);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка загрузки структуры',
      };
    }
  },

  async setSiteManager(siteId: string, managerId: number | null, organizationId?: string): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${siteId}/manager${orgQuery(organizationId)}`, {
        manager_id: managerId,
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Ошибка назначения менеджера',
      };
    }
  },

  async setSiteStatus(
    siteId: string,
    status: 'planning' | 'active' | 'completed' | 'suspended',
    organizationId?: string
  ): Promise<ApiResponse<OrgSite>> {
    try {
      return await apiClient.put<ApiResponse<OrgSite>>(`/structure/sites/${siteId}/status${orgQuery(organizationId)}`, {
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
