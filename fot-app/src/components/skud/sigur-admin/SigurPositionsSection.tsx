import { useEffect, useMemo, useState, type FC } from 'react';
import { Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { sigurAdminService } from '../../../services/sigurAdminService';
import { ApiError } from '../../../api/client';
import type { SigurConnectionScope, SigurPositionSummary } from '../../../types';

interface IProps {
  canEdit: boolean;
  selectedConnection: SigurConnectionScope;
  setError: (message: string) => void;
}

export const SigurPositionsSection: FC<IProps> = ({ canEdit, selectedConnection, setError }) => {
  const [positions, setPositions] = useState<SigurPositionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await sigurAdminService.getPositions(selectedConnection);
      setPositions(data);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось загрузить должности');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConnection]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('ru');
    if (!query) return positions;
    return positions.filter(p => p.name.toLocaleLowerCase('ru').includes(query));
  }, [positions, search]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setError('');
    try {
      const created = await sigurAdminService.createPosition(name, selectedConnection);
      setPositions(prev => {
        if (prev.some(p => p.id === created.id)) return prev;
        return [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      });
      setNewName('');
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось создать должность');
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (position: SigurPositionSummary) => {
    setEditingId(position.id);
    setEditingName(position.name);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingName('');
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    const name = editingName.trim();
    if (!name) return;
    setSavingId(editingId);
    setError('');
    try {
      const updated = await sigurAdminService.updatePosition(editingId, name, selectedConnection);
      setPositions(prev => prev
        .map(p => (p.id === updated.id ? updated : p))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')));
      cancelEdit();
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось сохранить должность');
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (position: SigurPositionSummary) => {
    const ok = window.confirm(`Удалить должность «${position.name}»? Sigur не разрешит удаление, если она назначена сотруднику.`);
    if (!ok) return;
    setDeletingId(position.id);
    setError('');
    try {
      await sigurAdminService.deletePosition(position.id, selectedConnection);
      setPositions(prev => prev.filter(p => p.id !== position.id));
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось удалить должность');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="sigur-admin-section">
      <div className="sigur-admin-toolbar">
        <input
          className="sigur-admin-input"
          placeholder="Поиск по названию..."
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="sigur-admin-btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} />
          Обновить
        </button>
        {canEdit && (
          <>
            <input
              className="sigur-admin-input"
              placeholder="Новая должность..."
              value={newName}
              onChange={event => setNewName(event.target.value)}
              disabled={creating}
              onKeyDown={event => {
                if (event.key === 'Enter' && !creating) void handleCreate();
              }}
            />
            <button
              className="sigur-admin-btn primary"
              onClick={() => void handleCreate()}
              disabled={creating || !newName.trim()}
            >
              <Plus size={14} />
              {creating ? 'Создание...' : 'Создать'}
            </button>
          </>
        )}
      </div>

      <div className="sigur-admin-table-wrap">
        <table className="sigur-admin-table">
          <thead>
            <tr>
              <th style={{ width: 100 }}>ID</th>
              <th>Название</th>
              {canEdit && <th style={{ width: 200 }} className="actions">Действия</th>}
            </tr>
          </thead>
          <tbody>
            {loading && positions.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 3 : 2} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Загрузка...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 3 : 2} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Должностей не найдено
                </td>
              </tr>
            )}
            {filtered.map(position => {
              const isEditing = editingId === position.id;
              return (
                <tr key={position.id}>
                  <td><span className="sigur-admin-badge">{position.id}</span></td>
                  <td>
                    {isEditing ? (
                      <input
                        className="sigur-admin-inline-input"
                        value={editingName}
                        onChange={event => setEditingName(event.target.value)}
                        autoFocus
                        disabled={savingId === position.id}
                        onKeyDown={event => {
                          if (event.key === 'Enter') void saveEdit();
                          if (event.key === 'Escape') cancelEdit();
                        }}
                      />
                    ) : (
                      position.name
                    )}
                  </td>
                  {canEdit && (
                    <td className="actions">
                      {isEditing ? (
                        <>
                          <button
                            className="sigur-admin-btn primary"
                            onClick={() => void saveEdit()}
                            disabled={savingId === position.id || !editingName.trim()}
                          >
                            <Save size={14} />
                            {savingId === position.id ? 'Сохранение...' : 'Сохранить'}
                          </button>
                          <button
                            className="sigur-admin-btn"
                            onClick={cancelEdit}
                            disabled={savingId === position.id}
                            style={{ marginLeft: 6 }}
                          >
                            <X size={14} />
                            Отмена
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="sigur-admin-btn"
                            onClick={() => startEdit(position)}
                            disabled={deletingId === position.id}
                          >
                            <Pencil size={14} />
                            Изм.
                          </button>
                          <button
                            className="sigur-admin-btn danger"
                            onClick={() => void handleDelete(position)}
                            disabled={deletingId === position.id}
                            style={{ marginLeft: 6 }}
                          >
                            <Trash2 size={14} />
                            {deletingId === position.id ? 'Удаление...' : 'Удалить'}
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
