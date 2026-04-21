import { useCallback, useEffect, useMemo, useState, type FC } from 'react';
import {
  CalendarDays,
  Check,
  CreditCard,
  FolderTree,
  MoveRight,
  RefreshCw,
  Save,
  ShieldCheck,
  SquarePen,
  UserRoundX,
  X,
} from 'lucide-react';
import { sigurService } from '../../services/sigurService';
import type {
  AccessPointOption,
  Employee,
  SigurEmployeeAccessPointBinding,
  SigurEmployeeCardSummary,
  SigurEmployeeProfileState,
} from '../../types';
import { AccessPointMapPreviewBadge } from './AccessPointMapPreviewBadge';
import './EmployeeSigurSidebar.css';

interface IEmployeeSigurSidebarProps {
  employeeId: number | null;
  employee: Employee | null;
  canEdit: boolean;
  canPreviewAccessPointMap: boolean;
  onClose: () => void;
  onOpenFullCard: (employeeId: number) => void;
  onMove: (employeeId: number) => void;
  onFire: (employee: Employee) => void;
  onRehire: (employee: Employee) => void;
}

interface IAccessPointViewItem {
  id: number;
  name: string;
  label: string;
  objectId: string | null;
  objectName: string | null;
  hasMapPreview: boolean;
}

interface IAccessPointGroup {
  key: string;
  title: string;
  items: IAccessPointViewItem[];
}

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return (parts[0]?.slice(0, 2) || '?').toUpperCase();
};

const formatDisplayDate = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('ru-RU');
};

const toDateInputValue = (value: string | null): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toExpirationIso = (value: string): string => new Date(`${value}T23:59:59`).toISOString();

const isExpired = (value: string | null): boolean => {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() < Date.now();
};

const getAccessPointLabel = (name: string, id: number): string => `${name} (${id})`;

const bindingToViewItem = (binding: SigurEmployeeAccessPointBinding): IAccessPointViewItem => ({
  id: binding.accessPointId,
  name: binding.accessPointName || `Точка ${binding.accessPointId}`,
  label: getAccessPointLabel(binding.accessPointName || `Точка ${binding.accessPointId}`, binding.accessPointId),
  objectId: binding.objectId || null,
  objectName: binding.objectName || null,
  hasMapPreview: binding.hasMapPreview === true,
});

const optionToViewItem = (option: AccessPointOption): IAccessPointViewItem | null => {
  if (option.id == null) return null;
  return {
    id: option.id,
    name: option.name,
    label: getAccessPointLabel(option.name, option.id),
    objectId: option.objectId || null,
    objectName: option.objectName || null,
    hasMapPreview: option.hasMapPreview === true,
  };
};

const groupAccessPoints = (items: IAccessPointViewItem[]): IAccessPointGroup[] => {
  const groups = new Map<string, IAccessPointGroup>();
  const sortedItems = [...items].sort((left, right) => left.label.localeCompare(right.label, 'ru'));

  for (const item of sortedItems) {
    const title = item.objectName || 'Без объекта';
    const key = item.objectId || `unassigned:${title}`;
    const current = groups.get(key) || { key, title, items: [] };
    current.items.push(item);
    groups.set(key, current);
  }

  return [...groups.values()].sort((left, right) => {
    if (left.title === 'Без объекта') return 1;
    if (right.title === 'Без объекта') return -1;
    return left.title.localeCompare(right.title, 'ru');
  });
};

export const EmployeeSigurSidebar: FC<IEmployeeSigurSidebarProps> = ({
  employeeId,
  employee,
  canEdit,
  canPreviewAccessPointMap,
  onClose,
  onOpenFullCard,
  onMove,
  onFire,
  onRehire,
}) => {
  const [profile, setProfile] = useState<SigurEmployeeProfileState | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [cardDrafts, setCardDrafts] = useState<Record<number, string>>({});
  const [startDateDrafts, setStartDateDrafts] = useState<Record<number, string>>({});
  const [savingCardId, setSavingCardId] = useState<number | null>(null);
  const [cardSaveError, setCardSaveError] = useState('');
  const [accessPointEditMode, setAccessPointEditMode] = useState(false);
  const [accessPointCatalog, setAccessPointCatalog] = useState<AccessPointOption[]>([]);
  const [accessPointCatalogLoading, setAccessPointCatalogLoading] = useState(false);
  const [accessPointCatalogError, setAccessPointCatalogError] = useState('');
  const [accessPointInitialIds, setAccessPointInitialIds] = useState<number[]>([]);
  const [accessPointDraftIds, setAccessPointDraftIds] = useState<number[]>([]);
  const [accessPointSaving, setAccessPointSaving] = useState(false);
  const [accessPointSavedFlash, setAccessPointSavedFlash] = useState(false);

  const activeProfile = profile && profile.employeeId === employeeId ? profile : null;

  const loadProfile = useCallback(async (refresh = false) => {
    if (!employeeId) return;

    try {
      setProfileLoading(true);
      setProfileError('');
      setCardSaveError('');
      const data = await sigurService.getEmployeeProfile(employeeId, undefined, refresh);
      setProfile(data);
      setCardDrafts(Object.fromEntries(
        data.cards.map(card => [card.cardId, toDateInputValue(card.expirationDate)]),
      ));
      setStartDateDrafts(Object.fromEntries(
        data.cards.map(card => [card.cardId, toDateInputValue(card.startDate)]),
      ));
      const boundIds = data.accessPoints.map(point => point.accessPointId).sort((left, right) => left - right);
      setAccessPointInitialIds(boundIds);
      setAccessPointDraftIds(boundIds);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось загрузить данные Sigur');
    } finally {
      setProfileLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    if (!employeeId) {
      setProfile(null);
      setProfileLoading(false);
      setProfileError('');
      setCardDrafts({});
      setStartDateDrafts({});
      setCardSaveError('');
      setSavingCardId(null);
      setAccessPointEditMode(false);
      setAccessPointCatalog([]);
      setAccessPointCatalogLoading(false);
      setAccessPointCatalogError('');
      setAccessPointInitialIds([]);
      setAccessPointDraftIds([]);
      setAccessPointSaving(false);
      setAccessPointSavedFlash(false);
      return;
    }

    setProfile(null);
    setAccessPointEditMode(false);
    setAccessPointCatalog([]);
    setAccessPointCatalogError('');
    setAccessPointSavedFlash(false);
    void loadProfile(false);
  }, [employeeId, loadProfile]);

  const loadAccessPointCatalog = useCallback(async (refresh = false) => {
    if (!employeeId) return;

    try {
      setAccessPointCatalogLoading(true);
      setAccessPointCatalogError('');
      const data = await sigurService.getEmployeeAccessPoints(employeeId, undefined, true, refresh);
      setAccessPointCatalog(data.accessPoints);
      const nextSelectedIds = data.bindings.map(binding => binding.accessPointId).sort((left, right) => left - right);
      setAccessPointInitialIds(nextSelectedIds);
      setAccessPointDraftIds(nextSelectedIds);
    } catch (error) {
      setAccessPointCatalogError(error instanceof Error ? error.message : 'Не удалось загрузить точки доступа');
    } finally {
      setAccessPointCatalogLoading(false);
    }
  }, [employeeId]);

  useEffect(() => {
    if (!canEdit || !employeeId || !activeProfile?.linked) return;
    if (profileLoading || accessPointCatalogLoading || accessPointCatalog.length > 0) return;
    void loadAccessPointCatalog(false);
  }, [
    accessPointCatalog.length,
    accessPointCatalogLoading,
    activeProfile?.linked,
    canEdit,
    employeeId,
    loadAccessPointCatalog,
    profileLoading,
  ]);

  const handleReload = () => {
    setAccessPointEditMode(false);
    setAccessPointCatalog([]);
    setAccessPointSavedFlash(false);
    void loadProfile(true);
  };

  const openAccessPointEditor = () => {
    setAccessPointEditMode(true);
    setAccessPointCatalogError('');
    if (accessPointCatalog.length === 0 && !accessPointCatalogLoading) {
      void loadAccessPointCatalog(false);
    }
  };

  const cancelAccessPointEdit = () => {
    setAccessPointEditMode(false);
    setAccessPointCatalogError('');
    setAccessPointDraftIds(accessPointInitialIds);
  };

  const toggleAccessPointDraft = (accessPointId: number) => {
    setAccessPointDraftIds(prev => (
      prev.includes(accessPointId)
        ? prev.filter(id => id !== accessPointId)
        : [...prev, accessPointId]
    ));
    setAccessPointSavedFlash(false);
  };

  const handleSaveAccessPoints = async () => {
    if (!employeeId) return;

    try {
      setAccessPointSaving(true);
      setAccessPointCatalogError('');
      const result = await sigurService.saveEmployeeAccessPoints(
        employeeId,
        [...accessPointDraftIds].sort((left, right) => left - right),
      );
      const nextIds = result.bindings.map(binding => binding.accessPointId).sort((left, right) => left - right);
      setAccessPointInitialIds(nextIds);
      setAccessPointDraftIds(nextIds);
      setProfile(prev => (
        prev && prev.employeeId === employeeId
          ? { ...prev, accessPoints: result.bindings }
          : prev
      ));
      setAccessPointSavedFlash(true);
      setAccessPointEditMode(false);
      window.setTimeout(() => setAccessPointSavedFlash(false), 2200);
    } catch (error) {
      setAccessPointCatalogError(error instanceof Error ? error.message : 'Не удалось сохранить точки доступа');
    } finally {
      setAccessPointSaving(false);
    }
  };

  const fullName = activeProfile?.profile.fullName || employee?.full_name || '—';
  const positionName = activeProfile?.profile.positionName || employee?.position_name || '—';
  const departmentName = activeProfile?.profile.departmentName || employee?.department || '—';
  const tabNumber = activeProfile?.profile.tabNumber || employee?.tab_number || '—';
  const sigurId = activeProfile?.sigurEmployeeId ?? employee?.sigur_employee_id ?? null;
  const isLinked = activeProfile?.linked ?? !!employee?.sigur_employee_id;
  const isBlocked = activeProfile?.profile.blocked === true;
  const isFired = employee?.employment_status === 'fired';
  const summaryBadge = tabNumber && tabNumber !== '—' ? tabNumber.slice(0, 4) : getInitials(fullName);
  const statusLabel = isFired ? 'Уволен' : isBlocked ? 'Заблокирован' : 'Активен';

  const boundAccessPointGroups = useMemo(
    () => groupAccessPoints((activeProfile?.accessPoints || []).map(bindingToViewItem)),
    [activeProfile?.accessPoints],
  );
  const catalogAccessPointGroups = useMemo(
    () => groupAccessPoints(
      accessPointCatalog
        .map(optionToViewItem)
        .filter((point): point is IAccessPointViewItem => !!point),
    ),
    [accessPointCatalog],
  );
  const accessPointDraftSet = useMemo(() => new Set(accessPointDraftIds), [accessPointDraftIds]);
  const accessPointHasChanges = useMemo(() => {
    if (accessPointInitialIds.length !== accessPointDraftIds.length) return true;
    const stableDraft = [...accessPointDraftIds].sort((left, right) => left - right);
    return stableDraft.some((value, index) => value !== accessPointInitialIds[index]);
  }, [accessPointDraftIds, accessPointInitialIds]);

  const handleCardDraftChange = (cardId: number, value: string) => {
    setCardDrafts(prev => ({ ...prev, [cardId]: value }));
    setCardSaveError('');
  };

  const handleStartDateDraftChange = (cardId: number, value: string) => {
    setStartDateDrafts(prev => ({ ...prev, [cardId]: value }));
    setCardSaveError('');
  };

  const handleSaveCardExpiration = async (card: SigurEmployeeCardSummary) => {
    if (!employeeId) return;
    const expirationDraft = cardDrafts[card.cardId] || '';
    const startDraft = startDateDrafts[card.cardId] || '';
    if (!expirationDraft) {
      setCardSaveError('Укажите дату окончания срока действия пропуска.');
      return;
    }
    if (!startDraft) {
      setCardSaveError('Укажите дату начала доступа пропуска.');
      return;
    }

    try {
      setSavingCardId(card.cardId);
      setCardSaveError('');
      const updatedCard = await sigurService.updateEmployeeCardBinding(
        employeeId,
        card.cardId,
        new Date(`${startDraft}T00:00:00`).toISOString(),
        toExpirationIso(expirationDraft),
        undefined,
        card.format ?? undefined,
      );

      setProfile(prev => {
        if (!prev || prev.employeeId !== employeeId) return prev;
        return {
          ...prev,
          cards: prev.cards.map(item => (
            item.cardId === card.cardId
              ? {
                ...item,
                cardNumber: updatedCard.cardNumber ?? item.cardNumber,
                status: updatedCard.status ?? item.status,
                startDate: updatedCard.startDate,
                expirationDate: updatedCard.expirationDate,
              }
              : item
          )),
        };
      });

      setCardDrafts(prev => ({
        ...prev,
        [card.cardId]: toDateInputValue(updatedCard.expirationDate),
      }));
      setStartDateDrafts(prev => ({
        ...prev,
        [card.cardId]: toDateInputValue(updatedCard.startDate),
      }));
    } catch (error) {
      setCardSaveError(error instanceof Error ? error.message : 'Не удалось сохранить даты карты');
    } finally {
      setSavingCardId(null);
    }
  };

  if (!employeeId || !employee) {
    return null;
  }

  return (
    <aside className="ep-sigur-panel">
      <div className="ep-sigur-panel-header">
        <div className="ep-sigur-header-top">
          <div className="ep-sigur-kicker">SIGUR</div>
          <div className="ep-sigur-header-actions">
            {canEdit && !isFired && (
              <button className="ep-sigur-tool danger" type="button" onClick={() => onFire(employee)}>
                <UserRoundX size={14} />
                <span>Уволить</span>
              </button>
            )}
            {canEdit && isFired && (
              <button className="ep-sigur-tool accent" type="button" onClick={() => onRehire(employee)}>
                <ShieldCheck size={14} />
                <span>Восстановить</span>
              </button>
            )}
            <button
              className="ep-sigur-tool"
              type="button"
              onClick={handleReload}
              disabled={profileLoading}
            >
              <RefreshCw size={14} />
              <span>Обновить</span>
            </button>
            <button className="ep-sigur-close" type="button" onClick={onClose} aria-label="Закрыть">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="ep-sigur-panel-heading">
          <h3>Профиль сотрудника</h3>
          <p className="ep-sigur-subtitle">Должность, доступы, карты и срок их действия.</p>
        </div>
      </div>

      <div className="ep-sigur-scroll">
        <div className="ep-sigur-summary">
          <div className="ep-sigur-avatar">{summaryBadge}</div>
          <div className="ep-sigur-summary-main">
            <div className="ep-sigur-summary-name">{fullName}</div>
            <div className="ep-sigur-summary-role">{positionName}</div>
            <div className="ep-sigur-summary-dept">
              <FolderTree size={13} />
              <span>{departmentName}</span>
            </div>
          </div>
        </div>

        <div className="ep-sigur-top-actions">
          {canEdit && !isFired && (
            <button className="ep-sigur-action" type="button" onClick={() => onMove(employee.id)}>
              <MoveRight size={14} />
              Переместить
            </button>
          )}
          <button className="ep-sigur-action" type="button" onClick={() => onOpenFullCard(employee.id)}>
            <SquarePen size={14} />
            Полная карточка
          </button>
        </div>

        <div className="ep-sigur-tags">
          <span className={`ep-sigur-tag ${isLinked ? 'accent' : ''}`}>
            <ShieldCheck size={13} />
            {isLinked ? 'Связан с Sigur' : 'Без связи с Sigur'}
          </span>
          <span className={`ep-sigur-tag ${isFired || isBlocked ? 'danger' : ''}`}>
            <UserRoundX size={13} />
            {statusLabel}
          </span>
        </div>

        <div className="ep-sigur-meta">
          <div className="ep-sigur-meta-row">
            <span>Sigur ID</span>
            <strong>{sigurId ?? '—'}</strong>
          </div>
          <div className="ep-sigur-meta-row">
            <span>Табельный номер</span>
            <strong>{tabNumber}</strong>
          </div>
          <div className="ep-sigur-meta-row">
            <span>Должность</span>
            <strong>{positionName}</strong>
          </div>
          <div className="ep-sigur-meta-row">
            <span>Отдел</span>
            <strong>{departmentName}</strong>
          </div>
        </div>

        {activeProfile?.profile.description && (
          <div className="ep-sigur-note">{activeProfile.profile.description}</div>
        )}

        {profileError && <div className="ep-sigur-inline-error">{profileError}</div>}

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <CreditCard size={15} />
              <span>Карты доступа</span>
            </div>
            <span className="ep-sigur-counter">{activeProfile?.cards.length || 0}</span>
          </div>

          {profileLoading && !activeProfile ? (
            <div className="ep-sigur-placeholder">Загрузка данных Sigur...</div>
          ) : (activeProfile?.cards.length || 0) === 0 ? (
            <div className="ep-sigur-placeholder">Карты не найдены.</div>
          ) : (
            <div className="ep-sigur-card-list">
              {activeProfile?.cards.map(card => {
                const expirationDraft = cardDrafts[card.cardId] || '';
                const startDraft = startDateDrafts[card.cardId] || '';
                const initialExpiration = toDateInputValue(card.expirationDate);
                const initialStart = toDateInputValue(card.startDate);
                const changed = expirationDraft !== initialExpiration || startDraft !== initialStart;
                return (
                  <div key={card.cardId} className="ep-sigur-card-row">
                    <div className="ep-sigur-card-main">
                      <div className="ep-sigur-card-name">{card.cardNumber || `Карта #${card.cardId}`}</div>
                      <div className={`ep-sigur-card-state ${isExpired(card.expirationDate) ? 'expired' : ''}`}>
                        {card.status || 'Активна'}
                        <span>{formatDisplayDate(card.expirationDate)}</span>
                      </div>
                    </div>
                    <div className="ep-sigur-card-edit">
                      <div className="ep-sigur-date-input-wrap">
                        <CalendarDays size={13} />
                        <input
                          type="date"
                          title="Дата начала доступа"
                          value={startDraft}
                          onChange={event => handleStartDateDraftChange(card.cardId, event.target.value)}
                          disabled={!canEdit || savingCardId === card.cardId}
                        />
                      </div>
                      <div className="ep-sigur-date-input-wrap">
                        <CalendarDays size={13} />
                        <input
                          type="date"
                          title="Срок действия"
                          value={expirationDraft}
                          onChange={event => handleCardDraftChange(card.cardId, event.target.value)}
                          disabled={!canEdit || savingCardId === card.cardId}
                        />
                      </div>
                      {canEdit && (
                        <button
                          className="ep-sigur-save-btn"
                          type="button"
                          onClick={() => void handleSaveCardExpiration(card)}
                          disabled={!changed || savingCardId === card.cardId}
                        >
                          <Save size={13} />
                          <span>{savingCardId === card.cardId ? '...' : 'Сохранить'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {cardSaveError && <div className="ep-sigur-inline-error compact">{cardSaveError}</div>}
        </section>

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <ShieldCheck size={15} />
              <span>Правила доступа</span>
            </div>
            <span className="ep-sigur-counter">{activeProfile?.accessRules.length || 0}</span>
          </div>
          {profileLoading && !activeProfile ? (
            <div className="ep-sigur-placeholder">Загрузка данных Sigur...</div>
          ) : (activeProfile?.accessRules.length || 0) === 0 ? (
            <div className="ep-sigur-placeholder">Правила не назначены.</div>
          ) : (
            <div className="ep-sigur-chip-list">
              {activeProfile?.accessRules.map(rule => (
                <span key={rule.accessRuleId} className="ep-sigur-mini-chip">
                  {rule.accessRuleName || `Правило #${rule.accessRuleId}`}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <ShieldCheck size={15} />
              <span>Точки доступа</span>
            </div>
            <div className="ep-sigur-section-tools">
              <span className="ep-sigur-counter">
                {accessPointEditMode ? accessPointDraftIds.length : (activeProfile?.accessPoints.length || 0)}
              </span>
              {isLinked && canEdit && !accessPointEditMode && (
                <button
                  className="ep-sigur-icon-btn"
                  type="button"
                  onClick={openAccessPointEditor}
                  aria-label="Редактировать точки доступа"
                >
                  <SquarePen size={13} />
                </button>
              )}
            </div>
          </div>

          {accessPointEditMode ? (
            <>
              <div className="ep-sigur-edit-actions">
                <button
                  className="ep-sigur-head-btn"
                  type="button"
                  onClick={cancelAccessPointEdit}
                  disabled={accessPointSaving}
                >
                  Отмена
                </button>
                <button
                  className={`ep-sigur-head-btn primary ${accessPointSavedFlash ? 'saved' : ''}`}
                  type="button"
                  onClick={() => void handleSaveAccessPoints()}
                  disabled={accessPointSaving || !accessPointHasChanges}
                >
                  {accessPointSavedFlash ? (
                    <>
                      <Check size={13} />
                      <span>Сохранено</span>
                    </>
                  ) : (
                    <>
                      <Save size={13} />
                      <span>{accessPointSaving ? 'Сохранение...' : 'Сохранить'}</span>
                    </>
                  )}
                </button>
              </div>

              {accessPointCatalogError && <div className="ep-sigur-inline-error compact">{accessPointCatalogError}</div>}

              {accessPointCatalogLoading ? (
                <div className="ep-sigur-placeholder">Загрузка списка точек доступа...</div>
              ) : catalogAccessPointGroups.length === 0 ? (
                <div className="ep-sigur-placeholder">В Sigur не найдено доступных точек доступа.</div>
              ) : (
                <div className="ep-sigur-point-groups">
                  {catalogAccessPointGroups.map(group => (
                    <div key={group.key} className="ep-sigur-point-group">
                      <div className="ep-sigur-point-group-head">
                        <span>{group.title}</span>
                        <span className="ep-sigur-point-group-count">{group.items.length}</span>
                      </div>
                      <div className="ep-sigur-point-editor-list">
                        {group.items.map(point => {
                          const checked = accessPointDraftSet.has(point.id);
                          return (
                            <label
                              key={point.id}
                              className={`ep-sigur-point-option ${checked ? 'selected' : ''}`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAccessPointDraft(point.id)}
                                disabled={accessPointSaving}
                              />
                              <span className="ep-sigur-point-option-label">{point.label}</span>
                              <AccessPointMapPreviewBadge
                                accessPointName={point.name}
                                enabled={canPreviewAccessPointMap && point.hasMapPreview}
                              />
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : profileLoading && !activeProfile ? (
            <div className="ep-sigur-placeholder">Загрузка привязок Sigur...</div>
          ) : boundAccessPointGroups.length === 0 ? (
            <div className="ep-sigur-placeholder">Прямые точки доступа не назначены.</div>
          ) : (
            <div className="ep-sigur-point-groups">
              {boundAccessPointGroups.map(group => (
                <div key={group.key} className="ep-sigur-point-group">
                  <div className="ep-sigur-point-group-head">
                    <span>{group.title}</span>
                    <span className="ep-sigur-point-group-count">{group.items.length}</span>
                  </div>
                  <div className="ep-sigur-point-list">
                    {group.items.map(point => (
                      <div key={point.id} className="ep-sigur-point-chip">
                        <span>{point.label}</span>
                        <AccessPointMapPreviewBadge
                          accessPointName={point.name}
                          enabled={canPreviewAccessPointMap && point.hasMapPreview}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
};
