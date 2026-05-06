/**
 * Массовые операции в управлении кадрами: 3 модалки.
 *
 * Извлечено из pages/StaffControlPage.tsx (Волна 3 декомпозиции). Каждая модалка
 * — изолированный controlled-компонент с внутренним state (mode/scheduleId/dates),
 * получает targets и handlers через props. CSS-классы (sc-overlay/sc-modal/...)
 * остаются глобальными через styles/StaffControlPage.css, импортируется в родителе.
 */
import { type FC, type ReactNode, memo, useEffect, useMemo, useState } from 'react';
import { SearchInput } from '../ui/SearchInput';
import type { IWorkSchedule } from '../../types/schedule';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';

// Локальная утилита (дубль из StaffControlPage) — намеренно копия,
// чтобы модуль был автономным без зависимости от utils родителя.
const getLocalISODate = (): string => {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
};

export interface IBrigadeOption extends IFlatDepartmentOption {
  employeeCount: number;
}

// ─── BulkScheduleModal ─────────────────────────────────────────────────────

export interface IBulkScheduleModalProps {
  open: boolean;
  targetCount: number;
  targetLabel: string;
  previewText: ReactNode;
  templates: IWorkSchedule[];
  onClose: () => void;
  onApply: (scheduleId: string | null, effectiveFrom: string) => Promise<void>;
}

export const BulkScheduleModal: FC<IBulkScheduleModalProps> = memo(({ open, targetCount, targetLabel, previewText, templates, onClose, onApply }) => {
  const [mode, setMode] = useState<'assign' | 'reset'>('assign');
  const [scheduleId, setScheduleId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => getLocalISODate());
  const [saving, setSaving] = useState(false);
  const defaultScheduleLabel = templates.find(t => t.is_default)?.name || 'по умолчанию';

  useEffect(() => {
    if (!open) return;
    setMode('assign');
    setScheduleId('');
    setEffectiveFrom(getLocalISODate());
    setSaving(false);
  }, [open, targetCount, previewText]);

  if (!open) return null;

  const handleApply = async () => {
    if (!effectiveFrom) return;
    if (mode === 'assign' && !scheduleId) return;
    setSaving(true);
    try {
      await onApply(mode === 'assign' ? scheduleId : null, effectiveFrom);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовое назначение графика</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>Действие</label>
            <select value={mode} onChange={e => setMode(e.target.value as 'assign' | 'reset')} autoFocus>
              <option value="assign">Назначить персональный график</option>
              <option value="reset">Вернуть к графику {defaultScheduleLabel}</option>
            </select>
          </div>
          {mode === 'assign' && (
            <div className="sc-field">
              <label>Шаблон графика</label>
              <select value={scheduleId} onChange={e => setScheduleId(e.target.value)}>
                <option value="">Выберите график</option>
                {templates.filter(tpl => !tpl.is_default).map(tpl => (
                  <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="sc-field">
            <label>{mode === 'assign' ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
            <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="sc-schedule-help">
            <div><strong>{targetLabel}:</strong> {targetCount}</div>
            <div>{previewText}</div>
            <div>
              {mode === 'assign'
                ? 'С выбранной даты персональный график будет назначен всем сотрудникам из выбранной области.'
                : `С выбранной даты персональный график будет снят, и сотрудники вернутся к графику ${defaultScheduleLabel}.`}
            </div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button className="sc-btn apply" onClick={handleApply} disabled={saving || !effectiveFrom || (mode === 'assign' && !scheduleId)}>
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

// ─── BulkMoveDepartmentModal ───────────────────────────────────────────────

export interface IBulkMoveDepartmentModalProps {
  open: boolean;
  targetCount: number;
  previewText: ReactNode;
  departments: IFlatDepartmentOption[];
  archiveDepartmentId: string | null;
  onClose: () => void;
  onApply: (departmentId: string, effectiveDate: string, reason?: string) => Promise<void>;
}

export const BulkMoveDepartmentModal: FC<IBulkMoveDepartmentModalProps> = memo(({
  open,
  targetCount,
  previewText,
  departments,
  archiveDepartmentId,
  onClose,
  onApply,
}) => {
  const [departmentId, setDepartmentId] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => getLocalISODate());
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDepartmentId('');
    setEffectiveDate(getLocalISODate());
    setReason('');
    setSaving(false);
  }, [open, targetCount, previewText]);

  if (!open) return null;

  const availableDepartments = archiveDepartmentId
    ? departments.filter(d => d.id !== archiveDepartmentId)
    : departments;

  const handleApply = async () => {
    if (!departmentId || !effectiveDate || targetCount === 0) return;
    setSaving(true);
    try {
      await onApply(departmentId, effectiveDate, reason.trim() || undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовый перевод в другой отдел</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body">
          <div className="sc-field">
            <label>Целевой отдел</label>
            <select value={departmentId} onChange={e => setDepartmentId(e.target.value)} autoFocus>
              <option value="">Выберите отдел</option>
              {availableDepartments.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>
          <div className="sc-field">
            <label>Дата перевода</label>
            <input type="date" value={effectiveDate} onChange={e => setEffectiveDate(e.target.value)} />
          </div>
          <div className="sc-field">
            <label>Причина (необязательно)</label>
            <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Реорганизация, оптимизация..." />
          </div>
          <div className="sc-schedule-help">
            <div><strong>Выбрано сотрудников:</strong> {targetCount}</div>
            <div>{previewText}</div>
            <div>С выбранной даты у каждого сотрудника закроется текущее назначение и создастся новое в выбранном отделе.</div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button
            className="sc-btn apply"
            onClick={handleApply}
            disabled={saving || !departmentId || !effectiveDate || targetCount === 0}
          >
            {saving ? 'Сохранение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});

// ─── BulkBrigadeScheduleModal ──────────────────────────────────────────────

export interface IBulkBrigadeScheduleModalProps {
  open: boolean;
  brigades: IBrigadeOption[];
  templates: IWorkSchedule[];
  onClose: () => void;
  onApply: (departmentIds: string[], scheduleId: string | null, effectiveFrom: string) => Promise<void>;
}

export const BulkBrigadeScheduleModal: FC<IBulkBrigadeScheduleModalProps> = memo(({
  open,
  brigades,
  templates,
  onClose,
  onApply,
}) => {
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<'assign' | 'reset'>('assign');
  const [scheduleId, setScheduleId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(() => getLocalISODate());
  const [saving, setSaving] = useState(false);
  const defaultScheduleLabel = templates.find(t => t.is_default)?.name || 'по умолчанию';

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelectedIds([]);
    setMode('assign');
    setScheduleId('');
    setEffectiveFrom(getLocalISODate());
    setSaving(false);
  }, [open]);

  const filteredBrigades = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) return brigades;
    return brigades.filter(brigade => brigade.name.toLowerCase().includes(normalized));
  }, [brigades, search]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedBrigades = useMemo(
    () => brigades.filter(brigade => selectedIdSet.has(brigade.id)),
    [brigades, selectedIdSet],
  );
  const selectedEmployeeCount = useMemo(
    () => selectedBrigades.reduce((total, brigade) => total + brigade.employeeCount, 0),
    [selectedBrigades],
  );
  const selectedPreview = useMemo(() => {
    const names = selectedBrigades.slice(0, 3).map(brigade => brigade.name);
    const rest = Math.max(0, selectedBrigades.length - names.length);
    if (names.length === 0) return 'Бригады не выбраны';
    return rest > 0 ? `${names.join(', ')} и ещё ${rest}` : names.join(', ');
  }, [selectedBrigades]);

  if (!open) return null;

  const toggleBrigade = (brigadeId: string) => {
    setSelectedIds(prev => (
      prev.includes(brigadeId)
        ? prev.filter(id => id !== brigadeId)
        : [...prev, brigadeId]
    ));
  };

  const selectAllFiltered = () => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      filteredBrigades.forEach(brigade => next.add(brigade.id));
      return Array.from(next);
    });
  };

  const clearSelection = () => {
    setSelectedIds([]);
  };

  const handleApply = async () => {
    if (!effectiveFrom || selectedIds.length === 0 || selectedEmployeeCount === 0) return;
    if (mode === 'assign' && !scheduleId) return;

    setSaving(true);
    try {
      await onApply(selectedIds, mode === 'assign' ? scheduleId : null, effectiveFrom);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-modal sc-modal--wide" onClick={e => e.stopPropagation()}>
        <div className="sc-modal-header">
          <h3>Массовое назначение графика по бригадам</h3>
          <button className="sc-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="sc-modal-body sc-brigade-modal">
          <div className="sc-brigade-panel">
            <div className="sc-field">
              <label>Поиск бригады</label>
              <SearchInput
                value={search}
                onValueChange={setSearch}
                placeholder="Поиск по названию бригады..."
                autoFocus
              />
            </div>
            <div className="sc-brigade-toolbar">
              <div className="sc-brigade-toolbar-actions">
                <button className="sc-btn secondary" type="button" onClick={selectAllFiltered} disabled={filteredBrigades.length === 0}>
                  Выбрать все бригады
                </button>
                <button className="sc-btn cancel" type="button" onClick={clearSelection} disabled={selectedIds.length === 0}>
                  Снять выбор
                </button>
              </div>
              <div className="sc-brigade-toolbar-meta">
                Выбрано: <strong>{selectedBrigades.length}</strong>
              </div>
            </div>
            <div className="sc-brigade-list">
              {filteredBrigades.length === 0 ? (
                <div className="sc-brigade-empty">Нет доступных бригад по текущему поиску.</div>
              ) : (
                filteredBrigades.map(brigade => {
                  const isSelected = selectedIdSet.has(brigade.id);
                  return (
                    <label key={brigade.id} className={`sc-brigade-item ${isSelected ? 'sc-brigade-item--selected' : ''}`}>
                      <div className="sc-brigade-item-main">
                        <input
                          className="sc-check"
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleBrigade(brigade.id)}
                          aria-label={`Выбрать ${brigade.name}`}
                        />
                        <div className="sc-brigade-item-labels">
                          <span
                            className="sc-brigade-item-name"
                            style={{ paddingLeft: `${brigade.level * 14}px` }}
                          >
                            {brigade.name}
                          </span>
                          <span className="sc-brigade-item-hint">Точный отдел без вложенных подразделений</span>
                        </div>
                      </div>
                      <span className="sc-brigade-item-count">{brigade.employeeCount}</span>
                    </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="sc-brigade-panel">
            <div className="sc-field">
              <label>Действие</label>
              <select value={mode} onChange={e => setMode(e.target.value as 'assign' | 'reset')}>
                <option value="assign">Назначить персональный график</option>
                <option value="reset">Вернуть к графику {defaultScheduleLabel}</option>
              </select>
            </div>
            {mode === 'assign' && (
              <div className="sc-field">
                <label>Шаблон графика</label>
                <select value={scheduleId} onChange={e => setScheduleId(e.target.value)}>
                  <option value="">Выберите график</option>
                  {templates.filter(tpl => !tpl.is_default).map(tpl => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </div>
            )}
            <div className="sc-field">
              <label>{mode === 'assign' ? 'Дата вступления в силу' : 'Дата снятия персонального графика'}</label>
              <input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="sc-schedule-help">
              <div><strong>Выбрано бригад:</strong> {selectedBrigades.length}</div>
              <div><strong>Активных сотрудников:</strong> {selectedEmployeeCount}</div>
              <div><strong>Состав:</strong> {selectedPreview}</div>
              <div>
                {mode === 'assign'
                  ? 'С выбранной даты персональный график будет назначен всем текущим активным сотрудникам выбранных бригад.'
                  : `С выбранной даты персональный график будет снят, и сотрудники вернутся к графику ${defaultScheduleLabel}.`}
              </div>
            </div>
          </div>
        </div>
        <div className="sc-modal-footer">
          <button className="sc-btn cancel" onClick={onClose}>Отмена</button>
          <button
            className="sc-btn apply"
            onClick={handleApply}
            disabled={saving || selectedIds.length === 0 || selectedEmployeeCount === 0 || !effectiveFrom || (mode === 'assign' && !scheduleId)}
          >
            {saving ? 'Применение...' : 'Применить'}
          </button>
        </div>
      </div>
    </div>
  );
});
