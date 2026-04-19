import { useEffect, useMemo, useState, type FC } from 'react';
import {
  CalendarDays,
  Check,
  CreditCard,
  FolderTree,
  Pencil,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserLock,
  UserRoundCheck,
  X,
} from 'lucide-react';
import { sigurAdminService } from '../../../services/sigurAdminService';
import type {
  AccessPointOption,
  SigurDepartmentNode,
  SigurEmployeeCardSummary,
  SigurEmployeeSummary,
  SigurLiveEmployeeProfile,
  SigurPositionSummary,
} from '../../../types';
import { AccessPointMapPreviewBadge } from '../../employees/AccessPointMapPreviewBadge';
import '../../employees/EmployeeSigurSidebar.css';

interface ISigurLiveEmployeeSidebarProps {
  sigurEmployeeId: number | null;
  employee: SigurEmployeeSummary | null;
  canEdit: boolean;
  departments: SigurDepartmentNode[];
  positions: SigurPositionSummary[];
  positionsLoading: boolean;
  onClose: () => void;
  onDirectoryChanged: () => Promise<void> | void;
  onPositionsChanged: () => Promise<void> | void;
  onDeleted: (sigurEmployeeId: number) => void;
}

interface IEmployeeDraft {
  name: string;
  departmentId: string;
  positionId: string;
  tabId: string;
  description: string;
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

const bindingToViewItem = (
  binding: {
    accessPointId: number;
    accessPointName: string | null;
    objectId?: string | null;
    objectName?: string | null;
    hasMapPreview?: boolean;
  },
): IAccessPointViewItem => ({
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

const flattenDepartments = (
  nodes: SigurDepartmentNode[],
  level = 0,
): Array<{ id: number; name: string; level: number }> => (
  nodes.flatMap(node => [
    { id: node.id, name: node.name, level },
    ...flattenDepartments(node.children || [], level + 1),
  ])
);

const profileToDraft = (profile: SigurLiveEmployeeProfile | null): IEmployeeDraft => ({
  name: profile?.profile.fullName || '',
  departmentId: profile?.profile.departmentId != null ? String(profile.profile.departmentId) : '',
  positionId: profile?.profile.positionId != null ? String(profile.profile.positionId) : '',
  tabId: profile?.profile.tabNumber || '',
  description: profile?.profile.description || '',
});

export const SigurLiveEmployeeSidebar: FC<ISigurLiveEmployeeSidebarProps> = ({
  sigurEmployeeId,
  employee,
  canEdit,
  departments,
  positions,
  positionsLoading,
  onClose,
  onDirectoryChanged,
  onPositionsChanged,
  onDeleted,
}) => {
  const [profile, setProfile] = useState<SigurLiveEmployeeProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [draft, setDraft] = useState<IEmployeeDraft>(profileToDraft(null));
  const [newPositionName, setNewPositionName] = useState('');
  const [creatingPosition, setCreatingPosition] = useState(false);

  const [cardDrafts, setCardDrafts] = useState<Record<number, string>>({});
  const [savingCardId, setSavingCardId] = useState<number | null>(null);
  const [cardSaveError, setCardSaveError] = useState('');

  const [accessPointEditMode, setAccessPointEditMode] = useState(false);
  const [accessPointDraftIds, setAccessPointDraftIds] = useState<number[]>([]);
  const [accessPointInitialIds, setAccessPointInitialIds] = useState<number[]>([]);
  const [accessPointSaving, setAccessPointSaving] = useState(false);
  const [accessPointSavedFlash, setAccessPointSavedFlash] = useState(false);
  const [accessPointError, setAccessPointError] = useState('');
  const [accessRuleEditMode, setAccessRuleEditMode] = useState(false);
  const [accessRuleDraftIds, setAccessRuleDraftIds] = useState<number[]>([]);
  const [accessRuleInitialIds, setAccessRuleInitialIds] = useState<number[]>([]);
  const [accessRuleSaving, setAccessRuleSaving] = useState(false);
  const [accessRuleSavedFlash, setAccessRuleSavedFlash] = useState(false);
  const [accessRuleError, setAccessRuleError] = useState('');

  const [runningAction, setRunningAction] = useState<'delete' | 'block' | 'unblock' | null>(null);

  const departmentOptions = useMemo(() => flattenDepartments(departments), [departments]);

  const loadProfile = async (refresh = false, includeAccessPointCatalog = false) => {
    if (!sigurEmployeeId) return;

    try {
      setLoading(true);
      setProfileError('');
      const data = await sigurAdminService.getEmployeeProfile(sigurEmployeeId, { includeAccessPointCatalog });
      if (!refresh || data.sigurEmployeeId === sigurEmployeeId) {
        setProfile(data);
        setDraft(profileToDraft(data));
        const nextCardDrafts = Object.fromEntries(
          data.cards.map(card => [card.cardId, toDateInputValue(card.expirationDate)]),
        );
        setCardDrafts(nextCardDrafts);
        const boundIds = data.accessPoints.map(point => point.accessPointId).sort((left, right) => left - right);
        setAccessPointInitialIds(boundIds);
        setAccessPointDraftIds(boundIds);
        const ruleIds = data.accessRules.map(rule => rule.accessRuleId).sort((left, right) => left - right);
        setAccessRuleInitialIds(ruleIds);
        setAccessRuleDraftIds(ruleIds);
      }
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось загрузить профиль Sigur');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!sigurEmployeeId) {
      setProfile(null);
      setDraft(profileToDraft(null));
      setCardDrafts({});
      setAccessPointDraftIds([]);
      setAccessPointInitialIds([]);
      setAccessRuleDraftIds([]);
      setAccessRuleInitialIds([]);
      setEditMode(false);
      setAccessPointEditMode(false);
      setAccessRuleEditMode(false);
      setNewPositionName('');
      return;
    }
    void loadProfile(false);
  }, [sigurEmployeeId]);

  useEffect(() => {
    if (!sigurEmployeeId || !accessPointEditMode) return;
    if ((profile?.accessPointOptions.length || 0) > 0) return;
    void loadProfile(true, true);
  }, [accessPointEditMode, profile?.accessPointOptions.length, sigurEmployeeId]);

  const fullName = profile?.profile.fullName || employee?.name || '—';
  const positionName = profile?.profile.positionName || employee?.positionName || '—';
  const departmentName = profile?.profile.departmentName || employee?.departmentName || '—';
  const tabNumber = profile?.profile.tabNumber || employee?.tabId || '—';
  const isBlocked = profile?.profile.blocked === true || employee?.blocked === true;

  const summaryBadge = tabNumber && tabNumber !== '—' ? tabNumber.slice(0, 4) : getInitials(fullName);

  const boundAccessPointGroups = useMemo(
    () => groupAccessPoints((profile?.accessPoints || []).map(bindingToViewItem)),
    [profile?.accessPoints],
  );
  const catalogAccessPointGroups = useMemo(
    () => groupAccessPoints(
      (profile?.accessPointOptions || [])
        .map(optionToViewItem)
        .filter((point): point is IAccessPointViewItem => !!point),
    ),
    [profile?.accessPointOptions],
  );
  const accessPointDraftSet = useMemo(() => new Set(accessPointDraftIds), [accessPointDraftIds]);
  const accessPointHasChanges = useMemo(() => {
    if (accessPointInitialIds.length !== accessPointDraftIds.length) return true;
    const stableDraft = [...accessPointDraftIds].sort((left, right) => left - right);
    return stableDraft.some((value, index) => value !== accessPointInitialIds[index]);
  }, [accessPointDraftIds, accessPointInitialIds]);
  const accessRuleDraftSet = useMemo(() => new Set(accessRuleDraftIds), [accessRuleDraftIds]);
  const accessRuleHasChanges = useMemo(() => {
    if (accessRuleInitialIds.length !== accessRuleDraftIds.length) return true;
    const stableDraft = [...accessRuleDraftIds].sort((left, right) => left - right);
    return stableDraft.some((value, index) => value !== accessRuleInitialIds[index]);
  }, [accessRuleDraftIds, accessRuleInitialIds]);

  const handleDraftChange = <K extends keyof IEmployeeDraft>(key: K, value: IEmployeeDraft[K]) => {
    setDraft(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveProfile = async () => {
    if (!sigurEmployeeId) return;

    try {
      setSavingProfile(true);
      setProfileError('');
      const nextProfile = await sigurAdminService.updateEmployee(sigurEmployeeId, {
        name: draft.name.trim(),
        departmentId: draft.departmentId ? Number(draft.departmentId) : null,
        positionId: draft.positionId ? Number(draft.positionId) : null,
        tabId: draft.tabId.trim() || null,
        description: draft.description.trim() || null,
      });
      setProfile(nextProfile);
      setDraft(profileToDraft(nextProfile));
      setEditMode(false);
      await onDirectoryChanged();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось сохранить изменения сотрудника');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleCreatePosition = async () => {
    const name = newPositionName.trim();
    if (!name) {
      setProfileError('Введите название должности');
      return;
    }

    try {
      setCreatingPosition(true);
      setProfileError('');
      const created = await sigurAdminService.createPosition(name);
      setDraft(prev => ({ ...prev, positionId: String(created.id) }));
      setNewPositionName('');
      await onPositionsChanged();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось создать должность Sigur');
    } finally {
      setCreatingPosition(false);
    }
  };

  const handleToggleBlocked = async () => {
    if (!sigurEmployeeId) return;

    try {
      setRunningAction(isBlocked ? 'unblock' : 'block');
      setProfileError('');
      const nextProfile = isBlocked
        ? await sigurAdminService.unblockEmployee(sigurEmployeeId)
        : await sigurAdminService.blockEmployee(sigurEmployeeId);
      setProfile(nextProfile);
      await onDirectoryChanged();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось изменить статус блокировки');
    } finally {
      setRunningAction(null);
    }
  };

  const handleDelete = async () => {
    if (!sigurEmployeeId) return;
    if (!confirm(`Удалить сотрудника "${fullName}" из Sigur?`)) return;

    try {
      setRunningAction('delete');
      setProfileError('');
      await sigurAdminService.deleteEmployee(sigurEmployeeId);
      await onDirectoryChanged();
      onDeleted(sigurEmployeeId);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось удалить сотрудника');
    } finally {
      setRunningAction(null);
    }
  };

  const handleCardDraftChange = (cardId: number, value: string) => {
    setCardDrafts(prev => ({ ...prev, [cardId]: value }));
    setCardSaveError('');
  };

  const handleSaveCardExpiration = async (card: SigurEmployeeCardSummary) => {
    if (!sigurEmployeeId) return;
    const draftValue = cardDrafts[card.cardId] || '';
    if (!draftValue) {
      setCardSaveError('Укажите дату окончания срока действия карты.');
      return;
    }

    try {
      setSavingCardId(card.cardId);
      setCardSaveError('');
      const updatedCard = await sigurAdminService.updateEmployeeCardExpiration(
        sigurEmployeeId,
        card.cardId,
        toExpirationIso(draftValue),
      );
      setProfile(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          cards: prev.cards.map(item => (
            item.cardId === card.cardId
              ? {
                ...item,
                cardNumber: updatedCard.cardNumber ?? item.cardNumber,
                status: updatedCard.status ?? item.status,
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
    } catch (error) {
      setCardSaveError(error instanceof Error ? error.message : 'Не удалось сохранить срок действия карты');
    } finally {
      setSavingCardId(null);
    }
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
    if (!sigurEmployeeId) return;

    try {
      setAccessPointSaving(true);
      setAccessPointError('');
      const result = await sigurAdminService.saveEmployeeAccessPoints(
        sigurEmployeeId,
        [...accessPointDraftIds].sort((left, right) => left - right),
      );
      const nextIds = result.bindings.map(binding => binding.accessPointId).sort((left, right) => left - right);
      setAccessPointInitialIds(nextIds);
      setAccessPointDraftIds(nextIds);
      setProfile(prev => (
        prev
          ? { ...prev, accessPoints: result.bindings }
          : prev
      ));
      setAccessPointSavedFlash(true);
      setAccessPointEditMode(false);
      window.setTimeout(() => setAccessPointSavedFlash(false), 2200);
    } catch (error) {
      setAccessPointError(error instanceof Error ? error.message : 'Не удалось сохранить точки доступа');
    } finally {
      setAccessPointSaving(false);
    }
  };

  const toggleAccessRuleDraft = (accessRuleId: number) => {
    setAccessRuleDraftIds(prev => (
      prev.includes(accessRuleId)
        ? prev.filter(id => id !== accessRuleId)
        : [...prev, accessRuleId]
    ));
    setAccessRuleSavedFlash(false);
  };

  const handleSaveAccessRules = async () => {
    if (!sigurEmployeeId) return;

    try {
      setAccessRuleSaving(true);
      setAccessRuleError('');
      const result = await sigurAdminService.saveEmployeeAccessRules(
        sigurEmployeeId,
        [...accessRuleDraftIds].sort((left, right) => left - right),
      );
      const nextIds = result.bindings.map(binding => binding.accessRuleId).sort((left, right) => left - right);
      setAccessRuleInitialIds(nextIds);
      setAccessRuleDraftIds(nextIds);
      setProfile(prev => (
        prev
          ? { ...prev, accessRules: result.bindings }
          : prev
      ));
      setAccessRuleSavedFlash(true);
      setAccessRuleEditMode(false);
      window.setTimeout(() => setAccessRuleSavedFlash(false), 2200);
    } catch (error) {
      setAccessRuleError(error instanceof Error ? error.message : 'Не удалось сохранить режимы доступа');
    } finally {
      setAccessRuleSaving(false);
    }
  };

  if (!sigurEmployeeId) {
    return null;
  }

  return (
    <aside className="ep-sigur-panel">
      <div className="ep-sigur-panel-header">
        <div className="ep-sigur-header-top">
          <div className="ep-sigur-kicker">SIGUR LIVE</div>
          <div className="ep-sigur-header-actions">
            <button
              className="ep-sigur-tool"
              type="button"
              onClick={() => void loadProfile(true)}
              disabled={loading}
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
          <h3>Сотрудник Sigur</h3>
          <p className="ep-sigur-subtitle">Live-профиль, базовые поля, карты, режимы и прямые точки доступа.</p>
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
          {canEdit && (
            <button className="ep-sigur-action" type="button" onClick={() => setEditMode(prev => !prev)}>
              <Pencil size={14} />
              {editMode ? 'Свернуть форму' : 'Редактировать'}
            </button>
          )}
          {canEdit && (
            <button className="ep-sigur-action" type="button" onClick={() => void handleToggleBlocked()}>
              {isBlocked ? <UserRoundCheck size={14} /> : <UserLock size={14} />}
              {runningAction === 'block' || runningAction === 'unblock'
                ? 'Сохранение...'
                : isBlocked ? 'Разблокировать' : 'Заблокировать'}
            </button>
          )}
          {canEdit && (
            <button className="ep-sigur-action danger" type="button" onClick={() => void handleDelete()}>
              <Trash2 size={14} />
              {runningAction === 'delete' ? 'Удаление...' : 'Удалить'}
            </button>
          )}
        </div>

        <div className="ep-sigur-tags">
          <span className={`ep-sigur-tag ${isBlocked ? 'danger' : 'accent'}`}>
            <ShieldCheck size={13} />
            {isBlocked ? 'Заблокирован' : 'Активен'}
          </span>
        </div>

        <div className="ep-sigur-meta">
          <div className="ep-sigur-meta-row">
            <span>Sigur ID</span>
            <strong>{sigurEmployeeId}</strong>
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

        {profile?.profile.description && (
          <div className="ep-sigur-note">{profile.profile.description}</div>
        )}

        {loading && !profile && (
          <div className="ep-sigur-placeholder">Загрузка данных Sigur...</div>
        )}
        {profileError && <div className="ep-sigur-inline-error">{profileError}</div>}

        {editMode && (
          <section className="ep-sigur-section">
            <div className="ep-sigur-section-head">
              <div className="ep-sigur-section-title">
                <Pencil size={15} />
                <span>Редактирование</span>
              </div>
            </div>
            <div className="ep-modal-stack">
              <label>
                ФИО
                <input
                  className="ep-modal-input"
                  value={draft.name}
                  onChange={event => handleDraftChange('name', event.target.value)}
                  disabled={!canEdit || savingProfile}
                />
              </label>
              <label>
                Отдел
                <select
                  className="ep-modal-select"
                  value={draft.departmentId}
                  onChange={event => handleDraftChange('departmentId', event.target.value)}
                  disabled={!canEdit || savingProfile}
                >
                  <option value="">—</option>
                  {departmentOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {'\u00A0\u00A0'.repeat(option.level)}{option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Должность
                <select
                  className="ep-modal-select"
                  value={draft.positionId}
                  onChange={event => handleDraftChange('positionId', event.target.value)}
                  disabled={!canEdit || savingProfile || (positionsLoading && positions.length === 0)}
                >
                  {positionsLoading && positions.length === 0 ? (
                    <option value="" disabled>Загрузка...</option>
                  ) : (
                    <>
                      <option value="">—</option>
                      {positions.map(position => (
                        <option key={position.id} value={position.id}>{position.name}</option>
                      ))}
                    </>
                  )}
                </select>
              </label>
              {canEdit && (
                <div className="sigur-live-inline-create">
                  <input
                    className="ep-modal-input"
                    value={newPositionName}
                    onChange={event => setNewPositionName(event.target.value)}
                    placeholder="Новая должность..."
                    disabled={creatingPosition || savingProfile}
                  />
                  <button
                    className="ep-modal-btn secondary"
                    type="button"
                    onClick={() => void handleCreatePosition()}
                    disabled={creatingPosition || savingProfile}
                  >
                    {creatingPosition ? 'Создание...' : 'Создать'}
                  </button>
                </div>
              )}
              <label>
                Табельный номер
                <input
                  className="ep-modal-input"
                  value={draft.tabId}
                  onChange={event => handleDraftChange('tabId', event.target.value)}
                  disabled={!canEdit || savingProfile}
                />
              </label>
              <label>
                Описание
                <textarea
                  className="ep-modal-input"
                  value={draft.description}
                  onChange={event => handleDraftChange('description', event.target.value)}
                  disabled={!canEdit || savingProfile}
                  rows={4}
                />
              </label>
            </div>
            <div className="ep-modal-footer">
              <button className="ep-modal-btn secondary" type="button" onClick={() => setEditMode(false)}>
                Отмена
              </button>
              <button className="ep-modal-btn primary" type="button" onClick={() => void handleSaveProfile()} disabled={savingProfile}>
                <Save size={14} />
                {savingProfile ? 'Сохранение...' : 'Сохранить'}
              </button>
            </div>
          </section>
        )}

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <CreditCard size={15} />
              <span>Карты доступа</span>
            </div>
            <span className="ep-sigur-counter">{profile?.cards.length || 0}</span>
          </div>

          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
          ) : profile.cards.length === 0 ? (
            <div className="ep-sigur-placeholder">Карты не найдены.</div>
          ) : (
            <div className="ep-sigur-card-list">
              {profile.cards.map(card => {
                const draftValue = cardDrafts[card.cardId] || '';
                const initialValue = toDateInputValue(card.expirationDate);
                const changed = draftValue !== initialValue;

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
                          value={draftValue}
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
                          {savingCardId === card.cardId ? <RefreshCw size={13} className="ep-sigur-spin" /> : <Save size={13} />}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {cardSaveError && <div className="ep-sigur-inline-error">{cardSaveError}</div>}
        </section>

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <FolderTree size={15} />
              <span>Прямые точки доступа</span>
            </div>
            <div className="ep-sigur-section-tools">
              {accessPointSavedFlash && (
                <span className="ep-sigur-head-btn primary saved">
                  <Check size={13} />
                  Сохранено
                </span>
              )}
              {canEdit && (
                <button
                  className="ep-sigur-head-btn primary"
                  type="button"
                  onClick={() => setAccessPointEditMode(prev => !prev)}
                >
                  {accessPointEditMode ? <X size={13} /> : <Pencil size={13} />}
                  {accessPointEditMode ? 'Закрыть' : 'Изменить'}
                </button>
              )}
            </div>
          </div>

          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
          ) : accessPointEditMode ? (
            <>
              <div className="ep-sigur-access-groups">
                {catalogAccessPointGroups.map(group => (
                  <div key={group.key} className="ep-sigur-access-group">
                    <div className="ep-sigur-access-title">{group.title}</div>
                    <div className="ep-sigur-access-list selectable">
                      {group.items.map(item => (
                        <label key={item.id} className="ep-sigur-access-check">
                          <input
                            type="checkbox"
                            checked={accessPointDraftSet.has(item.id)}
                            onChange={() => toggleAccessPointDraft(item.id)}
                            disabled={accessPointSaving}
                          />
                          <span>{item.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="ep-modal-footer">
                <button className="ep-modal-btn secondary" type="button" onClick={() => setAccessPointEditMode(false)}>
                  Отмена
                </button>
                <button
                  className="ep-modal-btn primary"
                  type="button"
                  onClick={() => void handleSaveAccessPoints()}
                  disabled={accessPointSaving || !accessPointHasChanges}
                >
                  <Save size={14} />
                  {accessPointSaving ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </>
          ) : boundAccessPointGroups.length === 0 ? (
            <div className="ep-sigur-placeholder">Прямые точки доступа не назначены.</div>
          ) : (
            <div className="ep-sigur-access-groups">
              {boundAccessPointGroups.map(group => (
                <div key={group.key} className="ep-sigur-access-group">
                  <div className="ep-sigur-access-title">{group.title}</div>
                  <div className="ep-sigur-access-list">
                    {group.items.map(item => (
                      <div key={item.id} className="ep-sigur-access-item">
                        <span>{item.label}</span>
                        {item.hasMapPreview && (
                          <AccessPointMapPreviewBadge
                            accessPointName={item.name}
                            enabled={item.hasMapPreview}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {accessPointError && <div className="ep-sigur-inline-error">{accessPointError}</div>}
        </section>

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <ShieldCheck size={15} />
              <span>Режимы доступа</span>
            </div>
            <div className="ep-sigur-section-tools">
              {accessRuleSavedFlash && (
                <span className="ep-sigur-head-btn primary saved">
                  <Check size={13} />
                  Сохранено
                </span>
              )}
              <span className="ep-sigur-counter">{profile?.accessRules.length || 0}</span>
              {canEdit && (
                <button
                  className="ep-sigur-head-btn primary"
                  type="button"
                  onClick={() => setAccessRuleEditMode(prev => !prev)}
                >
                  {accessRuleEditMode ? <X size={13} /> : <Pencil size={13} />}
                  {accessRuleEditMode ? 'Закрыть' : 'Изменить'}
                </button>
              )}
            </div>
          </div>
          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
          ) : accessRuleEditMode ? (
            <>
              <div className="ep-sigur-access-list selectable">
                {profile.accessRuleOptions.map(rule => (
                  <label key={rule.accessRuleId} className="ep-sigur-access-check">
                    <input
                      type="checkbox"
                      checked={accessRuleDraftSet.has(rule.accessRuleId)}
                      onChange={() => toggleAccessRuleDraft(rule.accessRuleId)}
                      disabled={accessRuleSaving}
                    />
                    <span>{rule.accessRuleName || `Режим #${rule.accessRuleId}`}</span>
                  </label>
                ))}
              </div>
              <div className="ep-modal-footer">
                <button className="ep-modal-btn secondary" type="button" onClick={() => setAccessRuleEditMode(false)}>
                  Отмена
                </button>
                <button
                  className="ep-modal-btn primary"
                  type="button"
                  onClick={() => void handleSaveAccessRules()}
                  disabled={accessRuleSaving || !accessRuleHasChanges}
                >
                  <Save size={14} />
                  {accessRuleSaving ? 'Сохранение...' : 'Сохранить'}
                </button>
              </div>
            </>
          ) : profile.accessRules.length === 0 ? (
            <div className="ep-sigur-placeholder">Режимы доступа не назначены.</div>
          ) : (
            <div className="ep-sigur-simple-list">
              {profile.accessRules.map(rule => (
                <div key={rule.accessRuleId} className="ep-sigur-simple-row">
                  <span>{rule.accessRuleName || `Режим #${rule.accessRuleId}`}</span>
                  <strong>{rule.accessRuleId}</strong>
                </div>
              ))}
            </div>
          )}
          {accessRuleError && <div className="ep-sigur-inline-error">{accessRuleError}</div>}
        </section>
      </div>
    </aside>
  );
};
