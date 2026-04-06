import { useState, memo, type FC } from 'react';
import { Pencil, X, TrendingUp, Briefcase, Trash2, Check } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { Employee, EmployeeHistoryEvent } from '../../types';

const fmt = (n: number | null | undefined) =>
  n ? n.toLocaleString('ru-RU') + ' ₽' : '—';

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

interface IHistoryPanelProps {
  employee: Employee;
  history: EmployeeHistoryEvent[];
  loading: boolean;
  onClose: () => void;
  onRefresh: () => void;
  onDataChanged: () => void;
}

export const HistoryPanel: FC<IHistoryPanelProps> = memo(({ employee, history, loading, onClose, onRefresh, onDataChanged }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSalary, setEditSalary] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);

  const [addMode, setAddMode] = useState<'salary' | 'position' | null>(null);
  const [addVal, setAddVal] = useState('');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addReason, setAddReason] = useState('');

  const salaryEvents = history
    .filter(e => e.event_type === 'salary')
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  const salaryDeltas = new Map<string, number>();
  for (let i = 1; i < salaryEvents.length; i++) {
    const prev = (salaryEvents[i - 1].event_data as Record<string, unknown>).salary as number;
    const curr = (salaryEvents[i].event_data as Record<string, unknown>).salary as number;
    if (prev && curr) salaryDeltas.set(salaryEvents[i].event_id, curr - prev);
  }

  const sorted = [...history].sort((a, b) => b.event_date.localeCompare(a.event_date));

  const startEdit = (ev: EmployeeHistoryEvent) => {
    const data = ev.event_data as Record<string, unknown>;
    setEditingId(ev.event_id);
    setEditDate(ev.event_date);
    setEditReason(String(data.reason || data.change_reason || ''));
    if (ev.event_type === 'salary') setEditSalary(String(data.salary || ''));
    setAddMode(null);
  };

  const saveEdit = async (ev: EmployeeHistoryEvent) => {
    setSaving(true);
    const body: Record<string, unknown> = { effective_date: editDate, change_reason: editReason };
    if (ev.event_type === 'salary') body.salary = Number(editSalary);
    await employeeService.updateHistoryEvent(employee.id, ev.event_id, body);
    setEditingId(null);
    setSaving(false);
    onRefresh();
    onDataChanged();
  };

  const handleDelete = async (ev: EmployeeHistoryEvent) => {
    if (!confirm('Удалить запись?')) return;
    await employeeService.deleteHistoryEvent(employee.id, ev.event_id);
    onRefresh();
    onDataChanged();
  };

  const handleAdd = async () => {
    if (!addVal) return;
    setSaving(true);
    if (addMode === 'salary') {
      await employeeService.changeSalary(employee.id, Number(addVal), addReason || undefined, addDate || undefined);
    } else {
      await employeeService.changePosition(employee.id, addVal, addReason || undefined, addDate || undefined);
    }
    setAddMode(null);
    setAddVal('');
    setAddReason('');
    setAddDate(new Date().toISOString().slice(0, 10));
    setSaving(false);
    onRefresh();
    onDataChanged();
  };

  const openAdd = (mode: 'salary' | 'position') => {
    setAddMode(mode);
    setAddVal('');
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddReason('');
    setEditingId(null);
  };

  return (
    <div className="sc-panel-overlay" onClick={onClose}>
      <div className="sc-panel" onClick={e => e.stopPropagation()}>
        <div className="sc-panel-header">
          <h3>{employee.full_name}</h3>
          <button className="sc-panel-close" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="sc-panel-add-bar">
          <button className="sc-panel-add-btn" onClick={() => openAdd('salary')}>
            <TrendingUp size={13} /> Оклад
          </button>
          <button className="sc-panel-add-btn" onClick={() => openAdd('position')}>
            <Briefcase size={13} /> Должность
          </button>
        </div>

        {addMode && (
          <div className="sc-panel-add-form">
            <div className="sc-panel-edit-row">
              {addMode === 'salary' ? (
                <input type="number" value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Оклад (₽)" autoFocus />
              ) : (
                <input value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Должность" autoFocus />
              )}
              <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} />
            </div>
            <input value={addReason} onChange={e => setAddReason(e.target.value)} placeholder="Причина" />
            <div className="sc-panel-edit-actions">
              <button className="sc-panel-edit-btn save" onClick={handleAdd} disabled={!addVal || saving}>
                <Check size={13} /> {saving ? '...' : 'Добавить'}
              </button>
              <button className="sc-panel-edit-btn" onClick={() => setAddMode(null)}>Отмена</button>
            </div>
          </div>
        )}

        <div className="sc-panel-body">
          {loading ? (
            <div className="sc-panel-loading">Загрузка...</div>
          ) : sorted.length === 0 ? (
            <div className="sc-panel-empty">Нет записей</div>
          ) : (
            <div className="sc-panel-timeline">
              {sorted.map(ev => {
                const data = ev.event_data as Record<string, unknown>;
                const isEditing = editingId === ev.event_id;

                if (ev.event_type === 'salary') {
                  const salary = data.salary as number | null;
                  const delta = salaryDeltas.get(ev.event_id);
                  const reason = String(data.reason || '');
                  const isFirst = salaryEvents[0]?.event_id === ev.event_id;
                  const isHire = reason.toLowerCase().includes('приеме') || reason.toLowerCase().includes('приём');

                  return (
                    <div key={ev.event_id} className={`sc-panel-item ${isEditing ? 'editing' : ''}`}>
                      <div className="sc-panel-dot-col">
                        <div className={`sc-panel-dot ${delta && delta > 0 ? 'green' : delta && delta < 0 ? 'red' : 'gray'}`} />
                        <div className="sc-panel-line" />
                      </div>
                      <div className="sc-panel-content">
                        {isEditing ? (
                          <div className="sc-panel-edit-form">
                            <div className="sc-panel-edit-row">
                              <input type="number" value={editSalary} onChange={e => setEditSalary(e.target.value)} placeholder="Оклад" />
                              <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                            </div>
                            <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                            <div className="sc-panel-edit-actions">
                              <button className="sc-panel-edit-btn save" onClick={() => saveEdit(ev)} disabled={saving}>
                                <Check size={13} /> {saving ? '...' : 'OK'}
                              </button>
                              <button className="sc-panel-edit-btn" onClick={() => setEditingId(null)}>×</button>
                            </div>
                          </div>
                        ) : (
                          <div className="sc-panel-row-compact">
                            <span className="sc-panel-date-sm">{fmtDate(ev.event_date)}</span>
                            <span className="sc-panel-salary-sm">{fmt(salary)}</span>
                            {delta != null && delta !== 0 && (
                              <span className={`sc-panel-delta-sm ${delta > 0 ? 'up' : 'down'}`}>
                                {delta > 0 ? '+' : ''}{delta.toLocaleString('ru-RU')}
                              </span>
                            )}
                            {isFirst && !delta && <span className="sc-panel-delta-sm neutral">старт</span>}
                            {reason && !isHire ? <span className="sc-panel-reason-sm">{reason}</span> : null}
                            <span className="sc-panel-item-btns">
                              <button className="sc-panel-act-btn" onClick={() => startEdit(ev)}><Pencil size={11} /></button>
                              <button className="sc-panel-act-btn danger" onClick={() => handleDelete(ev)}><Trash2 size={11} /></button>
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }

                const title = (() => {
                  if (data.type === 'hire' || data.type === 'Прием') return 'Приём';
                  if (data.type === 'transfer' || data.type === 'Перевод') return 'Перевод';
                  if (data.type === 'dismiss' || data.type === 'Увольнение') return 'Увольнение';
                  return 'Назначение';
                })();

                return (
                  <div key={ev.event_id} className={`sc-panel-item ${isEditing ? 'editing' : ''}`}>
                    <div className="sc-panel-dot-col">
                      <div className="sc-panel-dot blue" />
                      <div className="sc-panel-line" />
                    </div>
                    <div className="sc-panel-content">
                      {isEditing ? (
                        <div className="sc-panel-edit-form">
                          <div className="sc-panel-edit-row">
                            <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                          </div>
                          <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                          <div className="sc-panel-edit-actions">
                            <button className="sc-panel-edit-btn save" onClick={() => saveEdit(ev)} disabled={saving}>
                              <Check size={13} /> {saving ? '...' : 'OK'}
                            </button>
                            <button className="sc-panel-edit-btn" onClick={() => setEditingId(null)}>×</button>
                          </div>
                        </div>
                      ) : (
                        <div className="sc-panel-row-compact">
                          <span className="sc-panel-date-sm">{fmtDate(ev.event_date)}</span>
                          <Briefcase size={12} className="sc-panel-assign-icon" />
                          <span className="sc-panel-assign-sm">{title}</span>
                          {data.position ? <span className="sc-panel-pos-sm">{String(data.position)}</span> : null}
                          {data.department ? <span className="sc-panel-reason-sm">{String(data.department)}</span> : null}
                          <span className="sc-panel-item-btns">
                            <button className="sc-panel-act-btn" onClick={() => startEdit(ev)}><Pencil size={11} /></button>
                            <button className="sc-panel-act-btn danger" onClick={() => handleDelete(ev)}><Trash2 size={11} /></button>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
