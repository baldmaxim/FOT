import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  leaveRequestService,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestType,
} from '../services/leaveRequestService';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  useHrAckLeaveRequests,
  getHrAckLeaveRequestsQueryKey,
  type HrAckRequestsVariant,
} from '../hooks/usePortalData';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { SearchInput } from '../components/ui/SearchInput';
import { HrAckRequestCard } from '../components/leave-requests/HrAckRequestCard';
import { isLeaveRequestFullyFuture, leaveRequestOverlapsPeriod } from '../utils/leaveRequestDates';
import { TIMESHEET_FAMILY_KEYS } from '../api/queryKeys';
import './LeaveRequestsManagePage.css';

const EMPTY_REQUESTS: ILeaveRequest[] = [];
const NO_DEPARTMENT_KEY = 'Без отдела';

// Предметные различия вкладок: маркер доступа и тексты. Алгоритм общий.
const VARIANT_CONFIG: Record<HrAckRequestsVariant, {
  accessPath: string;
  emptyAll: string;
  emptyUnacked: string;
  emptyAcked: string;
}> = {
  vacations: {
    accessPath: '/leave-vacations',
    emptyAll: 'Нет отпусков',
    emptyUnacked: 'Все отпуска обработаны',
    emptyAcked: 'Нет ознакомленных отпусков',
  },
  dismissals: {
    accessPath: '/leave-dismissals',
    emptyAll: 'Нет заявлений на увольнение',
    emptyUnacked: 'Все увольнения обработаны',
    emptyAcked: 'Нет ознакомленных увольнений',
  },
};

// Текущая дата МСК (YYYY-MM-DD) — тем же способом, что и на бэкенде (moscowTodayIso).
const moscowTodayIso = (): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow' }).format(new Date());

// Единый ключ группы отдела — и для группировки списка, и для фильтра по отделам.
const deptKeyOf = (r: ILeaveRequest) => r.department_name?.trim() || NO_DEPARTMENT_KEY;

const compareDeptKeys = (a: string, b: string) => {
  if (a === NO_DEPARTMENT_KEY) return 1;
  if (b === NO_DEPARTMENT_KEY) return -1;
  return a.localeCompare(b, 'ru');
};

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
}

interface IHrAckRequestsPageProps {
  variant: HrAckRequestsVariant;
}

/**
 * Вкладки отдела кадров в «Заявлениях»: «Отпуска» и «Увольнения».
 * Общий список по организации, по умолчанию «Не ознакомлен», фильтры ФИО/отдел/период,
 * группировка по отделам, отметка «Ознакомлен» (hr_acknowledged_at/by).
 * Редактор категории — только у отпусков.
 */
export const HrAckRequestsPage: FC<IHrAckRequestsPageProps> = ({ variant }) => {
  const cfg = VARIANT_CONFIG[variant];
  const queryClient = useQueryClient();
  const { canEditPage } = useAuth();
  const { showToast } = useToast();
  const { data, isLoading } = useHrAckLeaveRequests(variant);
  const requests = data ?? EMPTY_REQUESTS;
  const canEdit = canEditPage(cfg.accessPath);
  const queryKey = getHrAckLeaveRequestsQueryKey(variant);

  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const [acking, setAcking] = useState<Set<number>>(new Set());
  const [editingTypeId, setEditingTypeId] = useState<number | null>(null);
  // Категория на момент ОТКРЫТИЯ редактора — уходит на сервер как expected_request_type:
  // если другой HR успел её сменить, сервер ответит 409 вместо молчаливой перезаписи.
  const [editingTypeOriginal, setEditingTypeOriginal] = useState<LeaveRequestType>('vacation');
  const [typeDraft, setTypeDraft] = useState<LeaveRequestType>('vacation');
  const [savingType, setSavingType] = useState(false);
  // Под-вкладки: «Не ознакомлен» (hr_acknowledged_at пусто) / «Ознакомлен».
  const [ackFilter, setAckFilter] = useState<'unacked' | 'acked'>('unacked');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');

  const ackFiltered = useMemo(
    () => requests.filter(r => (ackFilter === 'acked' ? !!r.hr_acknowledged_at : !r.hr_acknowledged_at)),
    [requests, ackFilter],
  );

  // Опции фильтра по отделам — из списка ДО поиска/фильтра, чтобы селект не сужался при фильтрации.
  const deptOptions = useMemo(
    () => Array.from(new Set(ackFiltered.map(deptKeyOf))).sort(compareDeptKeys),
    [ackFiltered],
  );

  // Дата МСК на один рендер: по ней решаем, начался ли уже согласованный отпуск.
  const todayIso = useMemo(() => moscowTodayIso(), []);

  // Категорию правим только у отпусков: у pending всегда, у согласованного — пока
  // отпуск не начался (тот же гард на бэкенде: задним числом табель не переигрываем).
  const canEditType = (r: ILeaveRequest): boolean => {
    if (variant !== 'vacations' || !canEdit) return false;
    if (r.status === 'pending') return true;
    return r.status === 'approved' && isLeaveRequestFullyFuture(r, todayIso);
  };

  const query = search.trim().toLowerCase();
  const hasPeriod = periodFrom !== '' || periodTo !== '';
  const isFiltering = query !== '' || deptFilter !== 'all' || hasPeriod;

  const filtered = useMemo(() => {
    if (!isFiltering) return ackFiltered;
    return ackFiltered.filter(r =>
      (deptFilter === 'all' || deptKeyOf(r) === deptFilter)
      && (!hasPeriod || leaveRequestOverlapsPeriod(r, periodFrom, periodTo))
      && (query === '' || (r.employee_name ?? '').toLowerCase().includes(query)));
  }, [ackFiltered, isFiltering, deptFilter, hasPeriod, periodFrom, periodTo, query]);

  // Инвариант from ≤ to держим сами: min/max — лишь подсказка календарю,
  // при ручном вводе с клавиатуры перевёрнутый диапазон иначе пройдёт.
  const handlePeriodFromChange = (next: string) => {
    if (!next || !periodTo || next <= periodTo) setPeriodFrom(next);
  };
  const handlePeriodToChange = (next: string) => {
    if (!next || !periodFrom || next >= periodFrom) setPeriodTo(next);
  };
  const resetPeriod = () => {
    setPeriodFrom('');
    setPeriodTo('');
  };

  const grouped = useMemo(() => {
    const map = new Map<string, ILeaveRequest[]>();
    for (const r of filtered) {
      const key = deptKeyOf(r);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => compareDeptKeys(a, b));
  }, [filtered]);

  const ackFilteredRef = useRef(ackFiltered);
  ackFilteredRef.current = ackFiltered;
  const hasData = data !== undefined;

  useEffect(() => {
    // Дефолтное сворачивание (>2 групп — свернуть все) — только при первичной
    // загрузке и смене под-вкладки «Не ознакомлен/Ознакомлен». Изменения данных
    // (отметка «Ознакомлен», refetch) раскрытые отделы не трогают.
    if (!hasData) return;
    const keys = new Set(ackFilteredRef.current.map(deptKeyOf));
    setCollapsedDepts(keys.size > 2 ? keys : new Set());
  }, [hasData, ackFilter]);

  const queryActive = query !== '';
  useEffect(() => {
    // Начало поиска раскрывает группы, чтобы совпадения были видны;
    // свернуть обратно можно вручную — доввод символов не раскрывает повторно.
    if (queryActive) setCollapsedDepts(new Set());
  }, [queryActive]);

  const toggleDept = (key: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAcknowledge = async (id: number) => {
    setAcking(prev => new Set(prev).add(id));
    // Оптимистично проставляем отметку в кэше вкладки до refetch'а.
    const nowIso = new Date().toISOString();
    queryClient.setQueriesData<ILeaveRequest[] | undefined>(
      { queryKey },
      (prev) => prev?.map(r => (r.id === id ? { ...r, hr_acknowledged_at: nowIso } : r)),
    );
    try {
      await leaveRequestService.acknowledgeHr(id);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
      ]);
    } catch (err) {
      console.error('hr-acknowledge error:', err);
      showToast('error', err instanceof Error ? err.message : 'Не удалось отметить ознакомление');
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setAcking(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleUpdateType = async (id: number) => {
    if (typeDraft === editingTypeOriginal) {
      setEditingTypeId(null);
      return;
    }
    setSavingType(true);
    try {
      const updated = await leaveRequestService.updateRequestType(id, typeDraft, editingTypeOriginal);
      queryClient.setQueriesData<ILeaveRequest[] | undefined>(
        { queryKey },
        (prev) => prev?.map(r => (r.id === id ? { ...r, request_type: updated?.request_type ?? typeDraft } : r)),
      );
      setEditingTypeId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
        // У согласованного заявления сменилась буква дня в табеле — сбрасываем все
        // семейства табеля (в TIMESHEET_FAMILY_KEYS есть и legacy-ключ 'timesheet-page').
        ...TIMESHEET_FAMILY_KEYS.map(key => queryClient.invalidateQueries({ queryKey: key })),
      ]);
    } catch (err) {
      console.error('update request type error:', err);
      // В т.ч. 409 «Категория уже изменена» — ресинк подтянет актуальную категорию.
      showToast('error', err instanceof Error ? err.message : 'Не удалось изменить категорию');
      await queryClient.invalidateQueries({ queryKey });
    } finally {
      setSavingType(false);
    }
  };

  const openAttachment = (att: ILeaveRequestAttachment) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type });
  };

  const startEditType = (r: ILeaveRequest) => {
    setEditingTypeId(r.id);
    // Фиксируем категорию, которую HR видит перед правкой: сервер
    // сверит её под локом (анти-гонка stale-UI двух редакторов).
    setEditingTypeOriginal(r.request_type);
    setTypeDraft(r.request_type);
  };

  const renderCard = (r: ILeaveRequest) => (
    <HrAckRequestCard
      key={r.id}
      request={r}
      variant={variant}
      canAcknowledge={canEdit}
      isAcking={acking.has(r.id)}
      onAcknowledge={(id) => { void handleAcknowledge(id); }}
      onStartEditType={canEditType(r) ? () => startEditType(r) : undefined}
      typeEditor={editingTypeId === r.id ? {
        draft: typeDraft,
        saving: savingType,
        onDraftChange: setTypeDraft,
        onSave: () => { void handleUpdateType(r.id); },
        onCancel: () => setEditingTypeId(null),
      } : undefined}
      onOpenAttachment={openAttachment}
    />
  );

  const totalEmployees = (items: ILeaveRequest[]) =>
    new Set(items.map(i => i.employee_id)).size;

  return (
    <div className="lrm-shell">
      <div className="lrm-page">
        {isLoading ? (
          <div className="lrm-loading">Загрузка...</div>
        ) : requests.length === 0 ? (
          <div className="lrm-empty">{cfg.emptyAll}</div>
        ) : (
          <>
            <div className="lrm-header">
              <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
              <select
                className="lrm-filter-select"
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                aria-label="Фильтр по отделу"
              >
                <option value="all">Все отделы</option>
                {deptOptions.map(key => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
              <div className="lrm-date-range">
                <span className="lrm-date-label">Период</span>
                <input
                  type="date"
                  className="lrm-date-input"
                  value={periodFrom}
                  max={periodTo || undefined}
                  onChange={e => handlePeriodFromChange(e.target.value)}
                  aria-label="Период с"
                />
                <span className="lrm-date-sep">—</span>
                <input
                  type="date"
                  className="lrm-date-input"
                  value={periodTo}
                  min={periodFrom || undefined}
                  onChange={e => handlePeriodToChange(e.target.value)}
                  aria-label="Период по"
                />
                {hasPeriod && (
                  <button
                    type="button"
                    className="lrm-date-clear"
                    onClick={resetPeriod}
                    aria-label="Сбросить период"
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="lrm-filter">
                <button
                  className={`lrm-filter-btn ${ackFilter === 'unacked' ? 'active' : ''}`}
                  onClick={() => setAckFilter('unacked')}
                >
                  Не ознакомлен
                </button>
                <button
                  className={`lrm-filter-btn ${ackFilter === 'acked' ? 'active' : ''}`}
                  onClick={() => setAckFilter('acked')}
                >
                  Ознакомлен
                </button>
              </div>
            </div>
            {grouped.length === 0 ? (
              <div className="lrm-empty">
                {isFiltering
                  ? 'Ничего не найдено'
                  : ackFilter === 'acked' ? cfg.emptyAcked : cfg.emptyUnacked}
              </div>
            ) : (
              <div className="lrm-list">
                {grouped.map(([department, items]) => {
                  const isCollapsed = collapsedDepts.has(department);
                  return (
                    <div
                      key={department}
                      className={`lrm-group${isCollapsed ? ' lrm-group--collapsed' : ''}`}
                    >
                      <button
                        type="button"
                        className="lrm-group-toggle"
                        onClick={() => toggleDept(department)}
                        aria-expanded={!isCollapsed}
                      >
                        {isCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                        <span className="lrm-group-name">{department}</span>
                        <span className="lrm-group-stats">
                          {items.length} · {totalEmployees(items)} чел
                        </span>
                      </button>
                      {!isCollapsed && items.map(renderCard)}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {preview && (
        <FilePreviewModal
          documentId={preview.documentId}
          fileName={preview.fileName}
          mimeType={preview.mimeType}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
};
