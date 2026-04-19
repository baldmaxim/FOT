import { useEffect, useMemo, useState, type FC } from 'react';
import { RefreshCw } from 'lucide-react';
import { sigurService } from '../../../services/sigurService';
import { ApiError } from '../../../api/client';
import type { SigurConnectionScope } from '../../../types';

interface ICardHolder {
  holderId?: number;
  type?: string;
}

interface ICardItem {
  id: number;
  name?: string;
  value?: string;
  formattedValue?: string;
  format?: string;
  holder?: ICardHolder | null;
  guestApplicable?: boolean;
}

interface IProps {
  selectedConnection: SigurConnectionScope;
  setError: (message: string) => void;
}

export const SigurCardsSection: FC<IProps> = ({ selectedConnection, setError }) => {
  const [items, setItems] = useState<ICardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showIssued, setShowIssued] = useState<'all' | 'issued' | 'free'>('all');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await sigurService.getCards();
      const data = (result.data as ICardItem[]) || [];
      setItems(data);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : 'Не удалось загрузить карты');
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
    return items.filter(item => {
      const issued = !!item.holder?.holderId;
      if (showIssued === 'issued' && !issued) return false;
      if (showIssued === 'free' && issued) return false;
      if (!query) return true;
      return (item.name || '').toLocaleLowerCase('ru').includes(query)
        || (item.value || '').toLocaleLowerCase('ru').includes(query)
        || (item.formattedValue || '').toLocaleLowerCase('ru').includes(query);
    });
  }, [items, search, showIssued]);

  return (
    <div className="sigur-admin-section">
      <div className="sigur-admin-toolbar">
        <input
          className="sigur-admin-input"
          placeholder="Поиск по названию или номеру карты..."
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <select
          className="sigur-admin-btn"
          value={showIssued}
          onChange={event => setShowIssued(event.target.value as 'all' | 'issued' | 'free')}
        >
          <option value="all">Все</option>
          <option value="issued">Выданные</option>
          <option value="free">Свободные</option>
        </select>
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
              <th>Номер</th>
              <th>Формат</th>
              <th>Держатель</th>
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
                  Карт не найдено
                </td>
              </tr>
            )}
            {filtered.map(item => {
              const holderId = item.holder?.holderId;
              const holderType = item.holder?.type;
              return (
                <tr key={item.id}>
                  <td><span className="sigur-admin-badge">{item.id}</span></td>
                  <td>{item.name || <span style={{ color: 'var(--text-secondary)' }}>—</span>}</td>
                  <td>
                    {item.formattedValue || item.value || <span style={{ color: 'var(--text-secondary)' }}>—</span>}
                  </td>
                  <td>{item.format || '—'}</td>
                  <td>
                    {holderId
                      ? `${holderType || 'EMP'} #${holderId}`
                      : <span style={{ color: 'var(--text-secondary)' }}>Свободная</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
