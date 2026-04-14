import type { FC } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import type { TimesheetTeamManagementCandidate } from '../../types';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface ITimesheetTeamManagementModalProps {
  open: boolean;
  onClose: () => void;
  departmentName: string;
  searchQuery: string;
  searchLoading: boolean;
  searchResults: TimesheetTeamManagementCandidate[];
  pendingEmployeeId: number | null;
  onSearchQueryChange: (value: string) => void;
  onAddEmployee: (candidate: TimesheetTeamManagementCandidate) => void;
}

export const TimesheetTeamManagementModal: FC<ITimesheetTeamManagementModalProps> = ({
  open,
  onClose,
  departmentName,
  searchQuery,
  searchLoading,
  searchResults,
  pendingEmployeeId,
  onSearchQueryChange,
  onAddEmployee,
}) => {
  if (!open) return null;

  return (
    <>
      <div className="ts-backdrop ts-backdrop--open" onClick={onClose} />
      <div className="ts-modal-overlay ts-modal-overlay--open" onClick={onClose}>
        <div className="ts-modal ts-team-modal" onClick={event => event.stopPropagation()}>
          <div className="ts-modal-header ts-team-modal-header">
            <div>
              <div className="ts-modal-title">Добавить сотрудника</div>
              <div className="ts-modal-subtitle">{departmentName}</div>
            </div>
            <button type="button" className="ts-panel-close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>

          <div className="ts-modal-body ts-team-modal-body">
            <section className="ts-team-section">
              <div className="ts-team-section-title">Поиск по активным сотрудникам</div>
              <div className="ts-team-search">
                <Search size={16} />
                <input
                  value={searchQuery}
                  onChange={event => onSearchQueryChange(event.target.value)}
                  className="ts-team-search-input"
                  placeholder="Начните вводить ФИО"
                />
              </div>
              {searchQuery.trim().length < 2 ? (
                <div className="ts-team-empty">Введите минимум 2 символа для поиска по всем активным сотрудникам.</div>
              ) : searchLoading ? (
                <div className="ts-team-empty">Поиск сотрудников...</div>
              ) : searchResults.length === 0 ? (
                <div className="ts-team-empty">Ничего не найдено.</div>
              ) : (
                <div className="ts-team-list">
                  {searchResults.map(candidate => (
                    <div key={candidate.id} className="ts-team-item">
                      <div className="ts-team-item-main">
                        <div className="ts-team-item-name">{formatTimesheetEmployeeName(candidate.full_name)}</div>
                        <div className="ts-team-item-meta">
                          {candidate.department_name || 'Без отдела'}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="ts-btn ts-btn--primary"
                        onClick={() => onAddEmployee(candidate)}
                        disabled={pendingEmployeeId === candidate.id}
                      >
                        <UserPlus size={14} />
                        {pendingEmployeeId === candidate.id ? 'Перевод...' : 'Добавить'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </>
  );
};
