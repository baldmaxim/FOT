import { type FC, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
  leaveRequestService,
  REQUEST_TYPE_LABELS,
  isValidCorrectionHours,
  type ILeaveRequest,
  type ILeaveRequestAttachment,
  type LeaveRequestType,
} from '../services/leaveRequestService';
import { useLeaveRequestsManage } from '../hooks/usePortalData';
import { useLeaveRequestBulkActions } from '../hooks/useLeaveRequestBulkActions';
import { FilePreviewModal } from '../components/documents/FilePreviewModal';
import { SearchInput } from '../components/ui/SearchInput';
import { LeaveRequestRow } from '../components/leave-requests/LeaveRequestRow';
import { LeaveRequestsBulkBar } from '../components/leave-requests/LeaveRequestsBulkBar';
import { LeaveRequestsGroup } from '../components/leave-requests/LeaveRequestsGroup';
import { leaveRequestOverlapsPeriod } from '../utils/leaveRequestDates';
import './LeaveRequestsManagePage.css';

const EMPTY_REQUESTS: ILeaveRequest[] = [];
const NO_DEPARTMENT_KEY = 'Без отдела';
const DIRECT_REPORTS_KEY = '__direct_reports__';
const DIRECT_REPORTS_TITLE = 'Непосредственные подчинённые';

// Единый ключ группы отдела — и для группировки списка, и для фильтра по отделам.
const groupKeyOf = (r: ILeaveRequest) =>
  (r.is_direct_subordinate ? DIRECT_REPORTS_KEY : (r.department_name?.trim() || NO_DEPARTMENT_KEY));

// «Без отдела» и «Непосредственные подчинённые» — в конце, остальные по алфавиту.
const compareGroupKeys = (a: string, b: string) => {
  if (a === DIRECT_REPORTS_KEY) return 1;
  if (b === DIRECT_REPORTS_KEY) return -1;
  if (a === NO_DEPARTMENT_KEY) return 1;
  if (b === NO_DEPARTMENT_KEY) return -1;
  return a.localeCompare(b, 'ru');
};

interface IPreviewState {
  documentId: number;
  fileName: string;
  mimeType: string | null;
}

export const LeaveRequestsManagePage: FC = () => {
  const { hasPermission, profile, canEditPage } = useAuth();
  const { showToast } = useToast();
  const isDepartmentScope = hasPermission('data.scope.department') && !hasPermission('data.scope.all');
  const scope = isDepartmentScope ? 'department' : 'all';
  // Страница доступна и с одним лишь 'view' — правку часов показываем только редакторам.
  // Права на конкретную заявку окончательно проверяет бэк (canDecideLeaveRequest).
  const canEditRequests = canEditPage('/leave-requests');
  const queryClient = useQueryClient();

  // «Сегодня» в Europe/Moscow (как на бэке) — для показа кнопки отмены только на будущих отпусках.
  const todayIso = useMemo(() => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }), []);

  const [filter, setFilter] = useState<'pending' | 'all'>('pending');
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<LeaveRequestType | 'all'>('all');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [revokeId, setRevokeId] = useState<number | null>(null);
  const [revokeReason, setRevokeReason] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [editingHoursId, setEditingHoursId] = useState<number | null>(null);
  const [hoursDraft, setHoursDraft] = useState('');
  const [savingHours, setSavingHours] = useState(false);
  const [preview, setPreview] = useState<IPreviewState | null>(null);
  const [collapsedDepts, setCollapsedDepts] = useState<Set<string>>(new Set());
  const {
    data, isLoading, isPlaceholderData, isError, fetchStatus, refetch,
  } = useLeaveRequestsManage(scope, filter);
  const requests = data ?? EMPTY_REQUESTS;
  // placeholderData живёт только пока запрос нового ключа не завершён (status: pending).
  // fetching — идёт загрузка; paused — Network Mode считает браузер offline и запрос
  // не стартует вовсе. В обоих случаях на экране старые данные — действия над ними
  // блокируем, но обязаны показать, что происходит, и дать «Повторить».
  const stalePlaceholder = isPlaceholderData && fetchStatus !== 'idle';
  const isPaused = fetchStatus === 'paused';

  const baseRequests = useMemo(
    () => (filter === 'pending' && isDepartmentScope ? requests.filter(r => r.status === 'pending') : requests),
    [filter, isDepartmentScope, requests],
  );

  // Опции фильтра по отделам — из списка ДО поиска/фильтров, чтобы селект не сужался при фильтрации.
  const deptOptions = useMemo(
    () => Array.from(new Set(baseRequests.map(groupKeyOf))).sort(compareGroupKeys),
    [baseRequests],
  );

  const query = search.trim().toLowerCase();
  const hasPeriod = periodFrom !== '' || periodTo !== '';
  const isFiltering = query !== '' || deptFilter !== 'all' || typeFilter !== 'all' || hasPeriod;

  const filteredRequests = useMemo(() => {
    if (!isFiltering) return baseRequests;
    return baseRequests.filter(r =>
      (typeFilter === 'all' || r.request_type === typeFilter)
      && (deptFilter === 'all' || groupKeyOf(r) === deptFilter)
      && (!hasPeriod || leaveRequestOverlapsPeriod(r, periodFrom, periodTo))
      && (query === '' || (r.employee_name ?? '').toLowerCase().includes(query)));
  }, [baseRequests, isFiltering, typeFilter, deptFilter, hasPeriod, periodFrom, periodTo, query]);

  // Массовый режим — только на вкладке «Ожидающие» и только у тех, кто может согласовывать.
  const bulkMode = filter === 'pending' && canEditRequests;
  // Единственный источник выбора: реально ожидающие решения заявления из текущего
  // списка. Кэш отдаёт placeholderData от прошлой вкладки, где статусы уже другие.
  const selectableRequests = useMemo(
    () => (bulkMode ? filteredRequests.filter(r => r.status === 'pending') : EMPTY_REQUESTS),
    [bulkMode, filteredRequests],
  );
  const selectableIds = useMemo(() => selectableRequests.map(r => r.id), [selectableRequests]);
  const bulk = useLeaveRequestBulkActions({ scope, selectableIds });

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
    for (const r of filteredRequests) {
      // Непосредственные подчинённые (вне subtree отдела руководителя) — в
      // отдельную псевдо-группу в конце списка.
      const key = groupKeyOf(r);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => compareGroupKeys(a, b));
  }, [filteredRequests]);

  const baseRequestsRef = useRef(baseRequests);
  baseRequestsRef.current = baseRequests;
  const hasData = data !== undefined;

  useEffect(() => {
    // Дефолтное сворачивание (>2 групп — свернуть все) — только при первичной
    // загрузке и смене «Ожидающие/Все» (по реальным данным вкладки, не по
    // placeholder). Approve/reject/refetch и клиентские фильтры (тип/отдел/
    // поиск) раскрытые отделы не трогают — пользователь управляет ими сам.
    if (!hasData || isPlaceholderData) return;
    const keys = new Set(baseRequestsRef.current.map(groupKeyOf));
    setCollapsedDepts(keys.size > 2 ? keys : new Set());
  }, [hasData, isPlaceholderData, scope, filter]);

  const queryActive = query !== '';
  useEffect(() => {
    // Начало поиска раскрывает группы, чтобы совпадения были видны;
    // свернуть обратно можно вручную — доввод символов не раскрывает повторно.
    if (queryActive) setCollapsedDepts(new Set());
  }, [queryActive]);

  const toggleExpanded = (id: number) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDept = (key: string) => {
    setCollapsedDepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Правка часов корректировки: сотрудник заявил 10ч, руководитель согласовывает 9ч.
  // На pending строки в табеле ещё нет (создаётся при approve), у согласованного бэк
  // точечно переписывает её сам — здесь достаточно инвалидировать табель.
  const handleUpdateHours = async (id: number) => {
    const raw = hoursDraft.trim();
    // Number('') === 0 — очищенное поле иначе молча ушло бы как «0 часов».
    if (!raw) {
      showToast('error', 'Укажите количество часов');
      return;
    }
    const hours = Number(raw);
    if (!isValidCorrectionHours(hours)) {
      showToast('error', 'Часы: от 0 до 24 с шагом 0.5');
      return;
    }
    setSavingHours(true);
    try {
      const updated = await leaveRequestService.updateCorrectionHours(id, hours);
      queryClient.setQueriesData<ILeaveRequest[] | undefined>(
        { queryKey: ['leave-requests-manage'] },
        (prev) => (prev
          ? prev.map(r => (r.id === id ? { ...r, correction_hours: updated?.correction_hours ?? hours } : r))
          : prev),
      );
      setEditingHoursId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['leave-request-history', id] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
      ]);
    } catch (err) {
      console.error('Update correction hours error:', err);
      showToast('error', err instanceof Error ? err.message : 'Не удалось изменить часы');
    } finally {
      setSavingHours(false);
    }
  };

  const handleRevoke = async (id: number) => {
    setRevoking(true);
    try {
      await leaveRequestService.revokeApproval(id, revokeReason.trim() || undefined);
      setRevokeId(null);
      setRevokeReason('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] }),
        queryClient.invalidateQueries({ queryKey: ['my-leave-requests'] }),
        queryClient.invalidateQueries({ queryKey: ['leave-requests-vacations'] }),
        queryClient.invalidateQueries({ queryKey: ['leave-request-history', id] }),
        queryClient.invalidateQueries({ queryKey: ['timesheet-page'] }),
      ]);
    } catch (err) {
      console.error('Revoke error:', err);
      // Гард закрытого табеля отвечает 409 — без тоста кнопка выглядела бы «мёртвой».
      showToast('error', err instanceof Error ? err.message : 'Не удалось отменить согласование');
      await queryClient.invalidateQueries({ queryKey: ['leave-requests-manage'] });
    } finally {
      setRevoking(false);
    }
  };

  const openAttachment = (att: ILeaveRequestAttachment) => {
    setPreview({ documentId: att.id, fileName: att.file_name, mimeType: att.mime_type });
  };

  // Во время массовой операции, на placeholder-данных и offline одиночные действия
  // и чекбоксы заблокированы: иначе можно решить по заявке, которая уже в пакете,
  // или по списку, который баннер уже объявил неактуальным.
  const actionsLocked = bulk.bulkPending || (bulkMode && (stalePlaceholder || isPaused));

  // Баннер состояния списка (см. матрицу: fetching / paused / ошибка с кэшем).
  // Ошибка без данных рендерится вместо списка ниже.
  const banner = (() => {
    if (isPaused) {
      return { kind: 'warn' as const, text: 'Нет соединения — действия недоступны', retry: true };
    }
    if (stalePlaceholder) {
      return { kind: 'info' as const, text: 'Обновляем список…', retry: false };
    }
    if (isError && hasData) {
      return { kind: 'error' as const, text: 'Не удалось обновить список', retry: true };
    }
    return null;
  })();

  const renderRow = (r: ILeaveRequest) => (
    <LeaveRequestRow
      key={r.id}
      request={r}
      isAdmin={!!profile?.is_admin}
      currentUserId={profile?.id}
      canEditRequests={canEditRequests}
      todayIso={todayIso}
      actionsDisabled={actionsLocked}
      selectable={bulkMode && r.status === 'pending'}
      selected={bulk.selectedIds.has(r.id)}
      onToggleSelect={bulk.toggleId}
      expanded={expandedIds.has(r.id)}
      onToggleExpanded={toggleExpanded}
      showPendingStatus={filter === 'all'}
      onApprove={bulk.approveOne}
      onReject={bulk.rejectOne}
      onOpenAttachment={openAttachment}
      editingHoursId={editingHoursId}
      hoursDraft={hoursDraft}
      savingHours={savingHours}
      onStartEditHours={(id, hours) => { setEditingHoursId(id); setHoursDraft(String(Number(hours))); }}
      onHoursDraftChange={setHoursDraft}
      onSaveHours={handleUpdateHours}
      onCancelEditHours={() => setEditingHoursId(null)}
      revokeId={revokeId}
      revokeReason={revokeReason}
      revoking={revoking}
      onStartRevoke={(id) => { setRevokeId(id); setRevokeReason(''); }}
      onRevokeReasonChange={setRevokeReason}
      onRevoke={handleRevoke}
      onCancelRevoke={() => { setRevokeId(null); setRevokeReason(''); }}
    />
  );

  return (
    <div className="lrm-shell">
      <div className="lrm-page">
        <div className="lrm-header">
          {scope === 'all' && (
            <>
              <SearchInput value={search} onValueChange={setSearch} placeholder="Поиск по ФИО..." />
              <select
                className="lrm-filter-select"
                value={deptFilter}
                onChange={e => setDeptFilter(e.target.value)}
                aria-label="Фильтр по отделу"
              >
                <option value="all">Все отделы</option>
                {deptOptions.map(key => (
                  <option key={key} value={key}>
                    {key === DIRECT_REPORTS_KEY ? DIRECT_REPORTS_TITLE : key}
                  </option>
                ))}
              </select>
              <select
                className="lrm-filter-select"
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value as LeaveRequestType | 'all')}
                aria-label="Фильтр по типу заявления"
              >
                <option value="all">Все типы</option>
                {Object.entries(REQUEST_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
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
            </>
          )}
          <div className="lrm-filter">
            <button className={`lrm-filter-btn ${filter === 'pending' ? 'active' : ''}`} onClick={() => setFilter('pending')}>
              Ожидающие
            </button>
            <button className={`lrm-filter-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              Все
            </button>
          </div>
        </div>

        {bulkMode && selectableIds.length > 0 && (
          <LeaveRequestsBulkBar
            selectableCount={selectableIds.length}
            selectedCount={bulk.selectedCount}
            selectionState={bulk.allSelectionState}
            onToggleAll={bulk.toggleAll}
            onClearSelection={bulk.clearSelection}
            comment={bulk.comment}
            onCommentChange={bulk.setComment}
            onApprove={bulk.approveSelected}
            onReject={bulk.rejectSelected}
            disabled={actionsLocked}
          />
        )}

        {banner && (
          <div className={`lrm-banner lrm-banner--${banner.kind}`} role="status">
            <span className="lrm-banner-text">{banner.text}</span>
            {banner.retry && (
              <button type="button" className="lrm-banner-retry" onClick={() => { void refetch(); }}>
                Повторить
              </button>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="lrm-loading">Загрузка...</div>
        ) : isError && !hasData ? (
          <div className="lrm-empty lrm-empty--error">
            Не удалось загрузить заявления
            <button type="button" className="lrm-banner-retry" onClick={() => { void refetch(); }}>
              Повторить
            </button>
          </div>
        ) : filteredRequests.length === 0 ? (
          <div className="lrm-empty">{isFiltering ? 'Ничего не найдено' : 'Нет заявлений'}</div>
        ) : (
          <div className="lrm-list">
            {grouped.map(([department, items]) => {
              const isDirectReports = department === DIRECT_REPORTS_KEY;
              const groupSelectableIds = items.filter(i => i.status === 'pending').map(i => i.id);
              return (
                <LeaveRequestsGroup
                  key={department}
                  label={isDirectReports ? DIRECT_REPORTS_TITLE : department}
                  items={items}
                  isCollapsed={collapsedDepts.has(department)}
                  onToggleCollapse={() => toggleDept(department)}
                  isDirectReports={isDirectReports}
                  selectableIds={groupSelectableIds}
                  selectionState={bulk.selectionStateOf(groupSelectableIds)}
                  onToggleGroup={bulk.toggleMany}
                  bulkMode={bulkMode}
                  disabled={actionsLocked}
                  renderRow={renderRow}
                />
              );
            })}
          </div>
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
