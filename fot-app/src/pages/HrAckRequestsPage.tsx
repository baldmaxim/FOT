import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  leaveRequestService,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestType,
} from '../services/leaveRequestService';
import { correctionLeaveService, type HrCorrectionItem } from '../services/correctionLeaveService';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  useHrAckLeaveRequests,
  getHrAckLeaveRequestsQueryKey,
  useHrCorrectionLeaves,
  type HrAckRequestsVariant,
} from '../hooks/usePortalData';
import { useHrCorrectionLeaveActions } from '../hooks/useHrCorrectionLeaveActions';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { SearchInput } from '../components/ui/SearchInput';
import { SearchableSelect } from '../components/ui/SearchableSelect';
import { HrAckRequestCard } from '../components/leave-requests/HrAckRequestCard';
import { HrCorrectionLeaveCard } from '../components/leave-requests/HrCorrectionLeaveCard';
import { HrCorrectionRejectModal } from '../components/leave-requests/HrCorrectionRejectModal';
import { isLeaveRequestFullyFuture } from '../utils/leaveRequestDates';
import {
  NO_DEPARTMENT_KEY,
  itemDeptKey,
  itemEmployeeId,
  itemEmployeeName,
  itemIsAcked,
  itemOverlapsPeriod,
  mergeHrAckItems,
  type HrAckItem,
} from '../utils/hrAckItems';
import { TIMESHEET_FAMILY_KEYS } from '../api/queryKeys';
import './LeaveRequestsManagePage.css';

const EMPTY_REQUESTS: ILeaveRequest[] = [];
const EMPTY_CORRECTIONS: HrCorrectionItem[] = [];

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

const compareDeptKeys = (a: string, b: string) => {
  if (a === NO_DEPARTMENT_KEY) return 1;
  if (b === NO_DEPARTMENT_KEY) return -1;
  return a.localeCompare(b, 'ru');
};

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
  /** Файл корректировки табеля: ссылку отдаёт эндпоинт вкладки «Отпуска». */
  correction: boolean;
}

interface IHrAckRequestsPageProps {
  variant: HrAckRequestsVariant;
}

/**
 * Вкладки отдела кадров в «Заявлениях»: «Отпуска» и «Увольнения».
 * Общий список по организации, по умолчанию «Не ознакомлен», фильтры ФИО/отдел/период,
 * группировка по отделам, отметка «Ознакомлен» (hr_acknowledged_at/by).
 * Редактор категории — только у отпусков. В «Отпусках» в общем списке — и отпуска,
 * поставленные корректировкой табеля (миграция 311): «Ознакомлен» / «Отказать».
 */
export const HrAckRequestsPage: FC<IHrAckRequestsPageProps> = ({ variant }) => {
  const cfg = VARIANT_CONFIG[variant];
  const queryClient = useQueryClient();
  const { canEditPage } = useAuth();
  const { showToast } = useToast();
  const isVacations = variant === 'vacations';
  const { data, isLoading, isError } = useHrAckLeaveRequests(variant);
  const corrections = useHrCorrectionLeaves(isVacations);
  const requests = data ?? EMPTY_REQUESTS;
  const correctionItems = (isVacations ? corrections.data : undefined) ?? EMPTY_CORRECTIONS;
  const items = useMemo(() => mergeHrAckItems(requests, correctionItems), [requests, correctionItems]);
  const loading = isLoading || (isVacations && corrections.isLoading);
  const loadError = isError || (isVacations && corrections.isError);
  const canEdit = canEditPage(cfg.accessPath);
  const queryKey = getHrAckLeaveRequestsQueryKey(variant);

  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  // Ключи элементов (lr:/tc:/rm:) — id заявлений и корректировок пересекаются.
  const [acking, setAcking] = useState<Set<string>>(new Set());
  const [editingTypeKey, setEditingTypeKey] = useState<string | null>(null);
  // Категория на момент ОТКРЫТИЯ редактора — уходит на сервер как expected_request_type:
  // если другой HR успел её сменить, сервер ответит 409 вместо молчаливой перезаписи.
  const [editingTypeOriginal, setEditingTypeOriginal] = useState<LeaveRequestType>('vacation');
  const [typeDraft, setTypeDraft] = useState<LeaveRequestType>('vacation');
  const [savingType, setSavingType] = useState(false);
  // Под-вкладки: «Не ознакомлен» (hr_acknowledged_at пусто) / «Ознакомлен».
  const [ackFilter, setAckFilter] = useState<'unacked' | 'acked'>('unacked');
  const [search, setSearch] = useState('');
  // '' — все отделы.
  const [deptFilter, setDeptFilter] = useState('');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');

  const ackFiltered = useMemo(
    () => items.filter(item => (ackFilter === 'acked' ? itemIsAcked(item) : !itemIsAcked(item))),
    [items, ackFilter],
  );

  // Опции фильтра по отделам — из списка ДО поиска/фильтра, чтобы селект не сужался при фильтрации.
  const deptOptions = useMemo(
    () => Array.from(new Set(ackFiltered.map(itemDeptKey))).sort(compareDeptKeys),
    [ackFiltered],
  );
  const deptSelectOptions = useMemo(
    () => deptOptions.map(key => ({ value: key, label: key })),
    [deptOptions],
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
  const isFiltering = query !== '' || deptFilter !== '' || hasPeriod;

  const filtered = useMemo(() => {
    if (!isFiltering) return ackFiltered;
    return ackFiltered.filter(item =>
      (deptFilter === '' || itemDeptKey(item) === deptFilter)
      && (!hasPeriod || itemOverlapsPeriod(item, periodFrom, periodTo))
      && (query === '' || itemEmployeeName(item).toLowerCase().includes(query)));
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
    const map = new Map<string, HrAckItem[]>();
    for (const item of filtered) {
      const key = itemDeptKey(item);
      const list = map.get(key) ?? [];
      list.push(item);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => compareDeptKeys(a, b));
  }, [filtered]);

  const ackFilteredRef = useRef(ackFiltered);
  ackFilteredRef.current = ackFiltered;
  const hasData = data !== undefined && (!isVacations || corrections.data !== undefined);

  useEffect(() => {
    // Дефолтное сворачивание (>2 групп — свернуть все) — только при первичной
    // загрузке и смене под-вкладки «Не ознакомлен/Ознакомлен». Изменения данных
    // (отметка «Ознакомлен», refetch) раскрытые отделы не трогают.
    if (!hasData) return;
    const keys = new Set(ackFilteredRef.current.map(itemDeptKey));
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

  const markBusy = (key: string, busy: boolean) => {
    setAcking(prev => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const correctionActions = useHrCorrectionLeaveActions(markBusy);

  const handleAcknowledge = async (id: number) => {
    const key = `lr:${id}`;
    markBusy(key, true);
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
      markBusy(key, false);
    }
  };

  const handleUpdateType = async (id: number) => {
    if (typeDraft === editingTypeOriginal) {
      setEditingTypeKey(null);
      return;
    }
    setSavingType(true);
    try {
      const updated = await leaveRequestService.updateRequestType(id, typeDraft, editingTypeOriginal);
      queryClient.setQueriesData<ILeaveRequest[] | undefined>(
        { queryKey },
        (prev) => prev?.map(r => (r.id === id ? { ...r, request_type: updated?.request_type ?? typeDraft } : r)),
      );
      setEditingTypeKey(null);
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

  const openAttachment = (att: ILeaveRequestAttachment, correction: boolean) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type, correction });
  };

  const startEditType = (r: ILeaveRequest) => {
    setEditingTypeKey(`lr:${r.id}`);
    // Фиксируем категорию, которую HR видит перед правкой: сервер
    // сверит её под локом (анти-гонка stale-UI двух редакторов).
    setEditingTypeOriginal(r.request_type);
    setTypeDraft(r.request_type);
  };

  const renderCard = (item: HrAckItem) => {
    if (item.kind !== 'request') {
      return (
        <HrCorrectionLeaveCard
          key={item.key}
          item={item}
          canEdit={canEdit}
          isBusy={acking.has(item.key)}
          onAcknowledge={(target) => { void correctionActions.acknowledge(target); }}
          onReject={correctionActions.startReject}
          onOpenAttachment={(att) => openAttachment(att, true)}
        />
      );
    }
    const r = item.request;
    return (
      <HrAckRequestCard
        key={item.key}
        request={r}
        variant={variant}
        canAcknowledge={canEdit}
        isAcking={acking.has(item.key)}
        onAcknowledge={(id) => { void handleAcknowledge(id); }}
        onStartEditType={canEditType(r) ? () => startEditType(r) : undefined}
        typeEditor={editingTypeKey === item.key ? {
          draft: typeDraft,
          saving: savingType,
          onDraftChange: setTypeDraft,
          onSave: () => { void handleUpdateType(r.id); },
          onCancel: () => setEditingTypeKey(null),
        } : undefined}
        onOpenAttachment={(att) => openAttachment(att, false)}
      />
    );
  };

  const totalEmployees = (list: HrAckItem[]) =>
    new Set(list.map(itemEmployeeId)).size;

  return (
    <div className="lrm-shell">
      <div className="lrm-page">
        {loading ? (
          <div className="lrm-loading">Загрузка...</div>
        ) : items.length === 0 ? (
          <div className="lrm-empty">{loadError ? 'Не удалось загрузить список — обновите страницу' : cfg.emptyAll}</div>
        ) : (
          <>
            {loadError && <div className="lrm-empty">Часть списка не загрузилась — обновите страницу</div>}
            <div className="lrm-header">
              <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
              <div className="lrm-dept-filter">
                <SearchableSelect
                  options={deptSelectOptions}
                  value={deptFilter}
                  onChange={setDeptFilter}
                  allLabel="Все отделы"
                  placeholder="Поиск отдела..."
                  ariaLabel="Фильтр по отделу"
                />
              </div>
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
                {grouped.map(([department, groupItems]) => {
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
                          {groupItems.length} · {totalEmployees(groupItems)} чел
                        </span>
                      </button>
                      {!isCollapsed && groupItems.map(renderCard)}
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
          urlLoader={preview.correction
            ? (disposition) => correctionLeaveService.getFileUrl(preview.documentId, disposition)
            : undefined}
          onClose={() => setPreview(null)}
        />
      )}

      {correctionActions.rejecting && (
        <HrCorrectionRejectModal
          item={correctionActions.rejecting}
          onClose={correctionActions.cancelReject}
          onSubmit={correctionActions.reject}
        />
      )}
    </div>
  );
};
