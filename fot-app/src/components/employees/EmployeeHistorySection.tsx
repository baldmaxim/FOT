import { useState, useMemo, useCallback, type FC } from 'react';
import { TrendingUp, TrendingDown, Minus, Briefcase, Pencil, Trash2, Check, X, Plus } from 'lucide-react';
import { employeeService } from '../../services/employeeService';
import type { EmployeeHistoryEvent } from '../../types';

interface IEmployeeHistorySectionProps {
  employeeId: number;
  history: EmployeeHistoryEvent[];
  loading: boolean;
  onRefresh: () => void;
}

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });

const formatSalary = (salary: number | null | undefined) => {
  if (!salary) return '—';
  return salary.toLocaleString('ru-RU') + ' ₽';
};

const formatDelta = (delta: number) => {
  const sign = delta > 0 ? '+' : '';
  return sign + delta.toLocaleString('ru-RU') + ' ₽';
};

const getAssignmentTitle = (data: Record<string, unknown>): string => {
  if (data.type === 'hire' || data.type === 'Прием') return 'Принят на работу';
  if (data.type === 'transfer' || data.type === 'Перевод') return 'Перевод';
  if (data.type === 'dismiss' || data.type === 'Увольнение') return 'Увольнение';
  return 'Назначение';
};

export const EmployeeHistorySection: FC<IEmployeeHistorySectionProps> = ({ employeeId, history, loading, onRefresh }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSalary, setEditSalary] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editReason, setEditReason] = useState('');
  const [saving, setSaving] = useState(false);

  const [addMode, setAddMode] = useState<'salary' | 'position' | null>(null);
  const [addVal, setAddVal] = useState('');
  const [addDate, setAddDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [addReason, setAddReason] = useState('');

  const sorted = useMemo(
    () => [...history].sort((a, b) => b.event_date.localeCompare(a.event_date)),
    [history],
  );

  const salaryEvents = useMemo(
    () => history.filter(e => e.event_type === 'salary').sort((a, b) => a.event_date.localeCompare(b.event_date)),
    [history],
  );

  const salaryDeltas = useMemo(() => {
    const map = new Map<string, number>();
    for (let i = 1; i < salaryEvents.length; i++) {
      const prev = (salaryEvents[i - 1].event_data as Record<string, unknown>).salary as number;
      const curr = (salaryEvents[i].event_data as Record<string, unknown>).salary as number;
      if (prev && curr) map.set(salaryEvents[i].event_id, curr - prev);
    }
    return map;
  }, [salaryEvents]);

  const startEdit = useCallback((ev: EmployeeHistoryEvent) => {
    const data = ev.event_data as Record<string, unknown>;
    setEditingId(ev.event_id);
    setEditDate(ev.event_date);
    setEditReason(String(data.reason || data.change_reason || ''));
    if (ev.event_type === 'salary') setEditSalary(String(data.salary || ''));
    setAddMode(null);
  }, []);

  const saveEdit = useCallback(async (ev: EmployeeHistoryEvent) => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { effective_date: editDate, change_reason: editReason };
      if (ev.event_type === 'salary') body.salary = Number(editSalary);
      await employeeService.updateHistoryEvent(employeeId, ev.event_id, ev.event_type, body);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }, [employeeId, editDate, editReason, editSalary, onRefresh]);

  const handleDelete = useCallback(async (ev: EmployeeHistoryEvent) => {
    if (!confirm('Удалить запись?')) return;
    try {
      await employeeService.deleteHistoryEvent(employeeId, ev.event_id, ev.event_type);
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Ошибка удаления');
    }
  }, [employeeId, onRefresh]);

  const openAdd = useCallback((mode: 'salary' | 'position') => {
    setAddMode(mode);
    setAddVal('');
    setAddDate(new Date().toISOString().slice(0, 10));
    setAddReason('');
    setEditingId(null);
  }, []);

  const handleAdd = useCallback(async () => {
    if (!addVal) return;
    setSaving(true);
    try {
      if (addMode === 'salary') {
        await employeeService.changeSalary(employeeId, Number(addVal), addReason || undefined, addDate || undefined);
      } else {
        await employeeService.changePosition(employeeId, addVal, addReason || undefined, addDate || undefined);
      }
      setAddMode(null);
      setAddVal('');
      setAddReason('');
      setAddDate(new Date().toISOString().slice(0, 10));
      onRefresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Ошибка добавления');
    } finally {
      setSaving(false);
    }
  }, [employeeId, addMode, addVal, addReason, addDate, onRefresh]);

  return (
    <div className="ec-history-wrap">
      <div className="ec-history-add-bar">
        <button type="button" className="ec-history-add-btn" onClick={() => openAdd('salary')}>
          <Plus size={13} /> Оклад
        </button>
        <button type="button" className="ec-history-add-btn" onClick={() => openAdd('position')}>
          <Plus size={13} /> Должность
        </button>
      </div>

      {addMode && (
        <div className="ec-history-add-form">
          <div className="ec-history-add-row">
            {addMode === 'salary' ? (
              <input type="number" value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Оклад (₽)" autoFocus />
            ) : (
              <input value={addVal} onChange={e => setAddVal(e.target.value)} placeholder="Должность" autoFocus />
            )}
            <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} />
          </div>
          <input value={addReason} onChange={e => setAddReason(e.target.value)} placeholder="Причина" />
          <div className="ec-history-edit-actions">
            <button type="button" className="ec-history-edit-btn save" onClick={handleAdd} disabled={!addVal || saving}>
              <Check size={13} /> {saving ? '...' : 'Добавить'}
            </button>
            <button type="button" className="ec-history-edit-btn" onClick={() => setAddMode(null)}>Отмена</button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="ec-history-empty">Загрузка...</div>
      ) : sorted.length === 0 ? (
        <div className="ec-history-empty">Нет записей в истории</div>
      ) : (
        <div className="ec-history-timeline">
          {sorted.map(event => {
            const data = event.event_data as Record<string, unknown>;
            const isEditing = editingId === event.event_id;

            if (event.event_type === 'salary') {
              const salary = data.salary as number | null;
              const delta = salaryDeltas.get(event.event_id);
              const isFirst = salaryEvents[0]?.event_id === event.event_id;
              const reason = String(data.reason || '');
              const isHire = reason.toLowerCase().includes('приеме') || reason.toLowerCase().includes('приём');

              return (
                <div key={event.event_id} className={`ec-history-item ec-history-salary ${isEditing ? 'editing' : ''}`}>
                  <div className="ec-history-date-col">
                    <span className="ec-history-date-text">{formatDate(event.event_date)}</span>
                  </div>
                  <div className="ec-history-line">
                    <div className={`ec-history-dot ${delta && delta > 0 ? 'green' : delta && delta < 0 ? 'red' : 'gray'}`} />
                  </div>
                  <div className="ec-history-card">
                    {isEditing ? (
                      <div className="ec-history-edit-form">
                        <div className="ec-history-add-row">
                          <input type="number" value={editSalary} onChange={e => setEditSalary(e.target.value)} placeholder="Оклад" />
                          <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                        </div>
                        <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                        <div className="ec-history-edit-actions">
                          <button type="button" className="ec-history-edit-btn save" onClick={() => saveEdit(event)} disabled={saving}>
                            <Check size={13} /> {saving ? '...' : 'OK'}
                          </button>
                          <button type="button" className="ec-history-edit-btn" onClick={() => setEditingId(null)}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="ec-history-card-top">
                          <span className="ec-history-salary-amount">{formatSalary(salary)}</span>
                          {delta != null && delta !== 0 && (
                            <span className={`ec-history-delta ${delta > 0 ? 'up' : 'down'}`}>
                              {delta > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                              {formatDelta(delta)}
                            </span>
                          )}
                          {isFirst && !delta && (
                            <span className="ec-history-delta neutral">
                              <Minus size={12} /> старт
                            </span>
                          )}
                          <span className="ec-history-actions">
                            <button type="button" className="ec-history-act-btn" onClick={() => startEdit(event)} title="Редактировать">
                              <Pencil size={12} />
                            </button>
                            <button type="button" className="ec-history-act-btn danger" onClick={() => handleDelete(event)} title="Удалить">
                              <Trash2 size={12} />
                            </button>
                          </span>
                        </div>
                        <div className="ec-history-card-label">
                          {isHire ? 'Оклад при приёме' : isFirst ? 'Начальный оклад' : 'Изменение оклада'}
                          {reason && !isHire ? <span className="ec-history-reason"> · {reason}</span> : null}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              );
            }

            return (
              <div key={event.event_id} className={`ec-history-item ec-history-assignment ${isEditing ? 'editing' : ''}`}>
                <div className="ec-history-date-col">
                  <span className="ec-history-date-text">{formatDate(event.event_date)}</span>
                  {event.event_end_date && (
                    <span className="ec-history-date-end">— {formatDate(event.event_end_date)}</span>
                  )}
                </div>
                <div className="ec-history-line">
                  <div className="ec-history-dot blue" />
                </div>
                <div className="ec-history-card">
                  {isEditing ? (
                    <div className="ec-history-edit-form">
                      <div className="ec-history-add-row">
                        <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} />
                      </div>
                      <input value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Причина" />
                      <div className="ec-history-edit-actions">
                        <button type="button" className="ec-history-edit-btn save" onClick={() => saveEdit(event)} disabled={saving}>
                          <Check size={13} /> {saving ? '...' : 'OK'}
                        </button>
                        <button type="button" className="ec-history-edit-btn" onClick={() => setEditingId(null)}>
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="ec-history-card-top">
                        <Briefcase size={14} className="ec-history-assign-icon" />
                        <span className="ec-history-assign-title">{getAssignmentTitle(data)}</span>
                        <span className="ec-history-actions">
                          <button type="button" className="ec-history-act-btn" onClick={() => startEdit(event)} title="Редактировать">
                            <Pencil size={12} />
                          </button>
                          <button type="button" className="ec-history-act-btn danger" onClick={() => handleDelete(event)} title="Удалить">
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </div>
                      {(data.position as string || data.department as string) && (
                        <div className="ec-history-card-details">
                          {data.position ? <span>{String(data.position)}</span> : null}
                          {data.department ? <span className="ec-history-dept">{String(data.department)}</span> : null}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
