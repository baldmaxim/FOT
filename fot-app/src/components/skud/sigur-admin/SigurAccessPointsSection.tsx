import { useEffect, useMemo, useState, type FC } from 'react';
import { RefreshCw } from 'lucide-react';
import { sigurService } from '../../../services/sigurService';
import { ApiError } from '../../../api/client';
import type { SigurConnectionScope } from '../../../types';

interface IAccessPointItem {
  id: number | null;
  name: string;
  objectId: string | null;
  objectName: string | null;
}

interface IProps {
  selectedConnection: SigurConnectionScope;
  setError: (message: string) => void;
}

export const SigurAccessPointsSection: FC<IProps> = ({ selectedConnection, setError }) => {
  const [items, setItems] = useState<IAccessPointItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await sigurService.getAccessPoints(selectedConnection);
      const data = (result.data as IAccessPointItem[]) || [];
      setItems(data);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось загрузить точки доступа');
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
    if (!query) return items;
    return items.filter(item =>
      item.name.toLocaleLowerCase('ru').includes(query)
      || (item.objectName || '').toLocaleLowerCase('ru').includes(query),
    );
  }, [items, search]);

  return (
    <div className="sigur-admin-section">
      <div className="sigur-admin-toolbar">
        <input
          className="sigur-admin-input"
          placeholder="Поиск по названию или объекту..."
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <button className="sigur-admin-btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} />
          Обновить
        </button>
      </div>

      <div className="sigur-admin-table-wrap">
        <table className="sigur-admin-table">
          <thead>
            <tr>
              <th style={{ width: 100 }}>ID</th>
              <th>Название</th>
              <th>Объект</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Загрузка...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={3} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Точек доступа не найдено
                </td>
              </tr>
            )}
            {filtered.map(item => (
              <tr key={`${item.id ?? 'null'}-${item.name}`}>
                <td><span className="sigur-admin-badge">{item.id ?? '—'}</span></td>
                <td>{item.name}</td>
                <td>{item.objectName || <span style={{ color: 'var(--text-secondary)' }}>—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
