import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Search, UserPlus, X } from 'lucide-react';
import type { TimesheetTeamManagementCandidate } from '../../types';
import { formatTimesheetEmployeeName } from '../../utils/timesheetDisplay';

interface ITimesheetTeamManagementModalProps {
  open: boolean;
  onClose: () => void;
  departmentName: string;
  defaultEffectiveFrom: string;
  searchQuery: string;
  searchLoading: boolean;
  searchResults: TimesheetTeamManagementCandidate[];
  pendingEmployeeId: number | null;
  onSearchQueryChange: (value: string) => void;
  onAddEmployee: (candidate: TimesheetTeamManagementCandidate, effectiveFrom: string) => void;
}

export const TimesheetTeamManagementModal: FC<ITimesheetTeamManagementModalProps> = ({
  open,
  onClose,
  departmentName,
  defaultEffectiveFrom,
  searchQuery,
  searchLoading,
  searchResults,
  pendingEmployeeId,
  onSearchQueryChange,
  onAddEmployee,
}) => {
  const [selectedCandidate, setSelectedCandidate] = useState<TimesheetTeamManagementCandidate | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(defaultEffectiveFrom);

  useEffect(() => {
    if (!open) return;
    setSelectedCandidate(null);
    setEffectiveFrom(defaultEffectiveFrom);
  }, [open, defaultEffectiveFrom]);

  const isSubmitting = pendingEmployeeId != null && pendingEmployeeId === selectedCandidate?.id;
  const sourceDepartmentLabel = useMemo(() => (
    selectedCandidate?.department_name || 'Без отдела'
  ), [selectedCandidate]);

  const mouseDownOnOverlayRef = useRef(false);

  if (!open) return null;

  const handleOverlayMouseDown = (event: React.MouseEvent) => {
    mouseDownOnOverlayRef.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget && mouseDownOnOverlayRef.current) {
      onClose();
    }
    mouseDownOnOverlayRef.current = false;
  };

  return createPortal(
    <div
      className="ts-modal-overlay ts-modal-overlay--open"
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
    >
      <div className="ts-modal ts-team-modal">
          <div className="ts-modal-header ts-team-modal-header">
            <div>
              <div className="ts-modal-title">Перевести сотрудника</div>
              <div className="ts-modal-subtitle">{departmentName}</div>
            </div>
            <button type="button" className="ts-panel-close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>

          <div className="ts-modal-body ts-team-modal-body">
            {!selectedCandidate ? (
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
                            {candidate.excluded_from_timesheet ? ' · Исключён из табеля' : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="ts-btn ts-btn--primary"
                          onClick={() => setSelectedCandidate(candidate)}
                        >
                          <ArrowRight size={14} />
                          Выбрать
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <section className="ts-team-section">
                <div className="ts-team-section-title">Подтверждение перевода</div>
                <div className="ts-team-confirm-card">
                  <div className="ts-team-confirm-block">
                    <div className="ts-team-confirm-label">Сотрудник</div>
                    <div className="ts-team-confirm-name">
                      {formatTimesheetEmployeeName(selectedCandidate.full_name)}
                    </div>
                  </div>
                  <div className="ts-team-confirm-block">
                    <div className="ts-team-confirm-label">Перевод отдела</div>
                    <div className="ts-team-confirm-route">
                      <div className="ts-team-confirm-route-side">
                        <span className="ts-team-confirm-route-caption">Текущий отдел</span>
                        <strong>{sourceDepartmentLabel}</strong>
                      </div>
                      <ArrowRight size={16} />
                      <div className="ts-team-confirm-route-side">
                        <span className="ts-team-confirm-route-caption">В отдел руководителя</span>
                        <strong>{departmentName}</strong>
                      </div>
                    </div>
                  </div>
                  <label className="ts-form-group ts-team-confirm-date">
                    <span className="ts-form-label">Дата вступления перевода</span>
                    <input
                      type="date"
                      className="ts-form-input"
                      value={effectiveFrom}
                      onChange={event => setEffectiveFrom(event.target.value)}
                    />
                  </label>
                  <div className="ts-team-warning">
                    Это физический перевод сотрудника между отделами. Изменение попадёт в историю назначений и начнёт действовать с выбранной даты.
                    {selectedCandidate.excluded_from_timesheet ? ' Сотрудник будет возвращён в табель.' : ''}
                  </div>
                </div>
                <div className="ts-team-confirm-actions">
                  <button
                    type="button"
                    className="ts-btn"
                    onClick={() => setSelectedCandidate(null)}
                    disabled={isSubmitting}
                  >
                    Назад
                  </button>
                  <button
                    type="button"
                    className="ts-btn ts-btn--primary"
                    onClick={() => onAddEmployee(selectedCandidate, effectiveFrom)}
                    disabled={isSubmitting || !effectiveFrom}
                  >
                    <UserPlus size={14} />
                    {isSubmitting ? 'Перевод...' : 'Подтвердить перевод'}
                  </button>
                </div>
              </section>
            )}
          </div>
        </div>
      </div>,
    document.body,
  );
};
