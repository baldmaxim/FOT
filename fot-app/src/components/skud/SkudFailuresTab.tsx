import { type FC, useCallback, useEffect, useState } from 'react';
import { AlertCircle, RefreshCw, Search, X } from 'lucide-react';
import { skudService } from '../../services/skudService';
import type { SkudEventFailure } from '../../types';
import '../../styles/SigurRawDataPage.css';

const formatDate = (dateStr: string): string => {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
};

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const monthAgoIso = (): string => {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const SkudFailuresTab: FC = () => {
  const [data, setData] = useState<SkudEventFailure[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState(monthAgoIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [employeeIdInput, setEmployeeIdInput] = useState('');
  const [failureTypeFilter, setFailureTypeFilter] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await skudService.getEventFailures({
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        employeeId: employeeIdInput.trim() || undefined,
        failureType: failureTypeFilter.trim() || undefined,
        limit: 2000,
      });
      setData(result.data);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      setData([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, employeeIdInput, failureTypeFilter]);

  useEffect(() => {
    void loadData();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- автозагрузка при первом монтировании
  }, []);

  const filtered = search.trim()
    ? data.filter(row => (row.physical_person || '').toLowerCase().includes(search.toLowerCase()))
    : data;

  return (
    <div className="sigur-raw">
      <div className="sigur-raw-header">
        <div className="sigur-raw-title">
          <AlertCircle size={20} />
          <h2 style={{ margin: 0 }}>Ошибочные события Sigur</h2>
          {!loading && data.length > 0 && (
            <span className="sigur-raw-count">
              {filtered.length}{search ? ` / ${data.length}` : ''}
              {total > data.length && <span className="sigur-raw-cached"> (из {total})</span>}
            </span>
          )}
        </div>
        <button
          className="sigur-raw-refresh"
          onClick={() => { void loadData(); }}
          disabled={loading}
        >
          <RefreshCw size={16} className={loading ? 'spinning' : ''} />
          Обновить
        </button>
      </div>

      <div className="sigur-raw-events-filters">
        <div className="sigur-raw-events-dates">
          <label>
            С:
            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="sigur-raw-date-input"
            />
          </label>
          <label>
            По:
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="sigur-raw-date-input"
            />
          </label>
        </div>
        <label className="sigur-raw-employee-label">
          Employee ID:
          <input
            type="number"
            placeholder="ID сотрудника..."
            value={employeeIdInput}
            onChange={e => setEmployeeIdInput(e.target.value)}
            className="sigur-raw-employee-input"
          />
          {employeeIdInput && (
            <button className="sigur-raw-employee-clear" onClick={() => setEmployeeIdInput('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <label className="sigur-raw-employee-label">
          Тип ошибки:
          <input
            type="text"
            placeholder="PASS_DENY, READER_ERROR..."
            value={failureTypeFilter}
            onChange={e => setFailureTypeFilter(e.target.value)}
            className="sigur-raw-employee-input"
          />
          {failureTypeFilter && (
            <button className="sigur-raw-employee-clear" onClick={() => setFailureTypeFilter('')}>
              <X size={14} />
            </button>
          )}
        </label>
        <button
          className="sigur-raw-refresh"
          onClick={() => { void loadData(); }}
          disabled={loading}
        >
          Загрузить
        </button>
      </div>

      <div className="sigur-raw-search-wrap">
        <Search size={16} className="sigur-raw-search-icon" />
        <input
          type="text"
          placeholder="Поиск по ФИО..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="sigur-raw-search-input"
        />
        {search && (
          <button className="sigur-raw-search-clear" onClick={() => setSearch('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {error && (
        <div className="sigur-raw-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="sigur-raw-loading">
          <div className="spinner"></div>
          <p>Загрузка ошибочных событий...</p>
        </div>
      ) : filtered.length === 0 && !error ? (
        <div className="sigur-raw-empty">
          {data.length === 0 ? 'Нет ошибочных событий за выбранный период' : 'Ничего не найдено'}
        </div>
      ) : (
        <div className="sigur-raw-table-wrap">
          <table className="sigur-raw-table">
            <thead>
              <tr>
                <th className="sigur-raw-th-num">#</th>
                <th>Дата</th>
                <th>Время</th>
                <th>ФИО</th>
                <th>Карта</th>
                <th>Точка доступа</th>
                <th>Направление</th>
                <th>Тип ошибки</th>
                <th>Причина</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => (
                <tr key={row.id}>
                  <td className="sigur-raw-td-num">{idx + 1}</td>
                  <td>{formatDate(row.event_date)}</td>
                  <td>{row.event_time.slice(0, 8)}</td>
                  <td title={row.physical_person || ''}>{row.physical_person || '—'}</td>
                  <td>{row.card_number || '—'}</td>
                  <td>{row.access_point || '—'}</td>
                  <td>
                    {row.direction === 'entry' ? 'Вход' : row.direction === 'exit' ? 'Выход' : '—'}
                  </td>
                  <td>
                    <span className="skud-failure-badge">{row.failure_type}</span>
                  </td>
                  <td title={row.reason || ''}>{row.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
