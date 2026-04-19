import { useEffect, useMemo, useState, type FC } from 'react';
import { RefreshCw } from 'lucide-react';
import { sigurService } from '../../../services/sigurService';
import { ApiError } from '../../../api/client';
import type { SigurConnectionScope } from '../../../types';

interface IAccessRuleItem {
  id: number;
  name: string;
  description?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  level?: number;
  folderId?: number | null;
}

interface IProps {
  selectedConnection: SigurConnectionScope;
  setError: (message: string) => void;
}

const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
};

export const SigurAccessRulesSection: FC<IProps> = ({ selectedConnection, setError }) => {
  const [items, setItems] = useState<IAccessRuleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await sigurService.getAccessRules();
      const data = (result.data as IAccessRuleItem[]) || [];
      setItems(data);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось загрузить режимы доступа');
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
      (item.name || '').toLocaleLowerCase('ru').includes(query)
      || (item.description || '').toLocaleLowerCase('ru').includes(query),
    );
  }, [items, search]);

  return (
    <div className="sigur-admin-section">
      <div className="sigur-admin-toolbar">
        <input
          className="sigur-admin-input"
          placeholder="Поиск по названию или описанию..."
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
              <th>Описание</th>
              <th style={{ width: 140 }}>Начало</th>
              <th style={{ width: 140 }}>Окончание</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Загрузка...
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
                  Режимов доступа не найдено
                </td>
              </tr>
            )}
            {filtered.map(item => (
              <tr key={item.id}>
                <td><span className="sigur-admin-badge">{item.id}</span></td>
                <td>{item.name}</td>
                <td>{item.description || <span style={{ color: 'var(--text-secondary)' }}>—</span>}</td>
                <td>{formatDate(item.startDate)}</td>
                <td>{formatDate(item.endDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
