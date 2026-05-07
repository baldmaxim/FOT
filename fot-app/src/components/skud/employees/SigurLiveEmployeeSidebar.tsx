import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from 'react';
import {
  CalendarDays,
  Check,
  CreditCard,
  FolderTree,
  MoreVertical,
  Pencil,
  Plus,
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
import { CardReaderModal } from '../CardReaderModal';
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

interface IFieldRowProps {
  label: string;
  changed: boolean;
  saving: boolean;
  saved: boolean;
  canEdit: boolean;
  onSave: () => void;
  stacked?: boolean;
  children: ReactNode;
}

const FieldRow: FC<IFieldRowProps> = ({ label, changed, saving, saved, canEdit, onSave, stacked, children }) => (
  <div className={`ep-sigur-field-row ${stacked ? 'stacked' : ''}`}>
    <label className="ep-sigur-field-label">{label}</label>
    <div className="ep-sigur-field-control">
      {children}
      {canEdit && (
        <button
          className={`ep-sigur-field-save ${saved ? 'saved' : ''}`}
          type="button"
          onClick={onSave}
          disabled={saving || (!changed && !saved)}
          aria-label={`Сохранить ${label.toLowerCase()}`}
        >
          {saving ? <RefreshCw size={14} className="ep-sigur-spin" /> : saved ? <Check size={14} /> : <Save size={14} />}
        </button>
      )}
    </div>
  </div>
);

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
  const [fieldDrafts, setFieldDrafts] = useState<IEmployeeDraft>(profileToDraft(null));
  const [savingField, setSavingField] = useState<keyof IEmployeeDraft | null>(null);
  const [savedFieldFlash, setSavedFieldFlash] = useState<keyof IEmployeeDraft | null>(null);
  const [newPositionName, setNewPositionName] = useState('');
  const [creatingPosition, setCreatingPosition] = useState(false);

  const [cardDrafts, setCardDrafts] = useState<Record<number, string>>({});
  const [startDateDrafts, setStartDateDrafts] = useState<Record<number, string>>({});
  const [savingCardId, setSavingCardId] = useState<number | null>(null);
  const [cardSaveError, setCardSaveError] = useState('');

  const [accessPointSaving, setAccessPointSaving] = useState(false);
  const [accessPointSavedFlash, setAccessPointSavedFlash] = useState(false);
  const [accessPointError, setAccessPointError] = useState('');
  const [accessPointPickerOpen, setAccessPointPickerOpen] = useState(false);
  const accessPointPickerRef = useRef<HTMLDivElement | null>(null);

  const [savingRuleId, setSavingRuleId] = useState<number | null>(null);
  const [accessRuleSavedFlash, setAccessRuleSavedFlash] = useState(false);
  const [accessRuleError, setAccessRuleError] = useState('');

  const [runningAction, setRunningAction] = useState<'delete' | 'block' | 'unblock' | null>(null);

  const [actionsMenuOpen, setActionsMenuOpen] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const [cardReaderOpen, setCardReaderOpen] = useState(false);
  const [removingCardId, setRemovingCardId] = useState<number | null>(null);

  const departmentOptions = useMemo(() => flattenDepartments(departments), [departments]);

  useEffect(() => {
    if (!actionsMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!actionsMenuRef.current) return;
      if (!actionsMenuRef.current.contains(event.target as Node)) {
        setActionsMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [actionsMenuOpen]);

  const loadProfile = async (refresh = false, includeAccessPointCatalog = false) => {
    if (!sigurEmployeeId) return;

    try {
      setLoading(true);
      setProfileError('');
      const data = await sigurAdminService.getEmployeeProfile(sigurEmployeeId, { includeAccessPointCatalog });
      if (!refresh || data.sigurEmployeeId === sigurEmployeeId) {
        setProfile(data);
        setFieldDrafts(profileToDraft(data));
        const nextCardDrafts = Object.fromEntries(
          data.cards.map(card => [card.cardId, toDateInputValue(card.expirationDate)]),
        );
        setCardDrafts(nextCardDrafts);
        const nextStartDateDrafts = Object.fromEntries(
          data.cards.map(card => [card.cardId, toDateInputValue(card.startDate)]),
        );
        setStartDateDrafts(nextStartDateDrafts);
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
      setFieldDrafts(profileToDraft(null));
      setCardDrafts({});
      setStartDateDrafts({});
      setSavingField(null);
      setSavedFieldFlash(null);
      setAccessPointPickerOpen(false);
      setNewPositionName('');
      return;
    }
    void loadProfile(false, true);
  }, [sigurEmployeeId]);

  useEffect(() => {
    if (!accessPointPickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!accessPointPickerRef.current) return;
      if (!accessPointPickerRef.current.contains(event.target as Node)) {
        setAccessPointPickerOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAccessPointPickerOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [accessPointPickerOpen]);

  const fullName = profile?.profile.fullName || employee?.name || '—';
  const tabNumber = profile?.profile.tabNumber || employee?.tabId || '—';
  const isBlocked = profile?.profile.blocked === true || employee?.blocked === true;

  const summaryBadge = tabNumber && tabNumber !== '—' ? tabNumber.slice(0, 4) : getInitials(fullName);

  const boundAccessPointIds = useMemo(
    () => (profile?.accessPoints || []).map(point => point.accessPointId),
    [profile?.accessPoints],
  );
  const boundAccessPointSet = useMemo(() => new Set(boundAccessPointIds), [boundAccessPointIds]);
  const boundAccessRuleIds = useMemo(
    () => (profile?.accessRules || []).map(rule => rule.accessRuleId),
    [profile?.accessRules],
  );
  const boundAccessRuleSet = useMemo(() => new Set(boundAccessRuleIds), [boundAccessRuleIds]);
  const boundAccessPointGroups = useMemo(
    () => groupAccessPoints((profile?.accessPoints || []).map(bindingToViewItem)),
    [profile?.accessPoints],
  );
  const availableAccessPointGroups = useMemo(
    () => groupAccessPoints(
      (profile?.accessPointOptions || [])
        .map(optionToViewItem)
        .filter((point): point is IAccessPointViewItem => !!point && !boundAccessPointSet.has(point.id)),
    ),
    [profile?.accessPointOptions, boundAccessPointSet],
  );

  const profileBaseline = useMemo<IEmployeeDraft>(() => profileToDraft(profile), [profile]);

  const handleFieldDraftChange = <K extends keyof IEmployeeDraft>(key: K, value: IEmployeeDraft[K]) => {
    setFieldDrafts(prev => ({ ...prev, [key]: value }));
    if (savedFieldFlash === key) setSavedFieldFlash(null);
    setProfileError('');
  };

  const handleSaveField = async (field: keyof IEmployeeDraft) => {
    if (!sigurEmployeeId) return;

    const baseline = profileBaseline[field];
    const value = fieldDrafts[field];
    if (value === baseline) return;

    try {
      setSavingField(field);
      setProfileError('');
      const payload: Parameters<typeof sigurAdminService.updateEmployee>[1] = {};
      if (field === 'name') {
        payload.name = (value as string).trim();
      } else if (field === 'departmentId') {
        payload.departmentId = value ? Number(value) : null;
      } else if (field === 'positionId') {
        payload.positionId = value ? Number(value) : null;
      } else if (field === 'tabId') {
        payload.tabId = (value as string).trim() || null;
      } else if (field === 'description') {
        payload.description = (value as string).trim() || null;
      }
      const nextProfile = await sigurAdminService.updateEmployee(sigurEmployeeId, payload);
      setProfile(nextProfile);
      setFieldDrafts(profileToDraft(nextProfile));
      setSavedFieldFlash(field);
      window.setTimeout(() => {
        setSavedFieldFlash(prev => (prev === field ? null : prev));
      }, 2200);
      await onDirectoryChanged();
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : 'Не удалось сохранить изменения сотрудника');
    } finally {
      setSavingField(null);
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
      setFieldDrafts(prev => ({ ...prev, positionId: String(created.id) }));
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

  const handleStartDateDraftChange = (cardId: number, value: string) => {
    setStartDateDrafts(prev => ({ ...prev, [cardId]: value }));
    setCardSaveError('');
  };

  const handleSaveCardExpiration = async (card: SigurEmployeeCardSummary) => {
    if (!sigurEmployeeId) return;
    const expirationDraft = cardDrafts[card.cardId] || '';
    const startDraft = startDateDrafts[card.cardId] || '';
    if (!expirationDraft) {
      setCardSaveError('Укажите дату окончания срока действия карты.');
      return;
    }
    if (!startDraft) {
      setCardSaveError('Укажите дату начала доступа карты.');
      return;
    }

    try {
      setSavingCardId(card.cardId);
      setCardSaveError('');
      const updatedCard = await sigurAdminService.updateEmployeeCardBinding(
        sigurEmployeeId,
        card.cardId,
        new Date(`${startDraft}T00:00:00`).toISOString(),
        toExpirationIso(expirationDraft),
        undefined,
        card.format ?? undefined,
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

  const handleRemoveCard = async (card: SigurEmployeeCardSummary) => {
    if (!sigurEmployeeId) return;
    const label = card.cardNumber || `#${card.cardId}`;
    if (!confirm(`Удалить карту ${label} у сотрудника?`)) return;

    try {
      setRemovingCardId(card.cardId);
      setCardSaveError('');
      await sigurAdminService.deleteEmployeeCardBinding(sigurEmployeeId, card.cardId);
      setProfile(prev => (
        prev
          ? { ...prev, cards: prev.cards.filter(item => item.cardId !== card.cardId) }
          : prev
      ));
      setCardDrafts(prev => {
        const next = { ...prev };
        delete next[card.cardId];
        return next;
      });
      setStartDateDrafts(prev => {
        const next = { ...prev };
        delete next[card.cardId];
        return next;
      });
    } catch (error) {
      setCardSaveError(error instanceof Error ? error.message : 'Не удалось удалить карту');
    } finally {
      setRemovingCardId(null);
    }
  };

  const handleCardAssigned = () => {
    setCardReaderOpen(false);
    void loadProfile(true);
  };

  const persistAccessPointIds = async (nextIds: number[]) => {
    if (!sigurEmployeeId) return;

    try {
      setAccessPointSaving(true);
      setAccessPointError('');
      const result = await sigurAdminService.saveEmployeeAccessPoints(
        sigurEmployeeId,
        [...nextIds].sort((left, right) => left - right),
      );
      setProfile(prev => (
        prev
          ? { ...prev, accessPoints: result.bindings }
          : prev
      ));
      setAccessPointSavedFlash(true);
      window.setTimeout(() => setAccessPointSavedFlash(false), 2200);
    } catch (error) {
      setAccessPointError(error instanceof Error ? error.message : 'Не удалось сохранить точки доступа');
    } finally {
      setAccessPointSaving(false);
    }
  };

  const handleAddAccessPoint = async (accessPointId: number) => {
    if (boundAccessPointSet.has(accessPointId)) return;
    setAccessPointPickerOpen(false);
    await persistAccessPointIds([...boundAccessPointIds, accessPointId]);
  };

  const handleRemoveAccessPoint = async (accessPointId: number) => {
    if (!boundAccessPointSet.has(accessPointId)) return;
    await persistAccessPointIds(boundAccessPointIds.filter(id => id !== accessPointId));
  };

  const handleToggleAccessRule = async (accessRuleId: number) => {
    if (!sigurEmployeeId) return;
    const nextIds = boundAccessRuleSet.has(accessRuleId)
      ? boundAccessRuleIds.filter(id => id !== accessRuleId)
      : [...boundAccessRuleIds, accessRuleId];

    try {
      setSavingRuleId(accessRuleId);
      setAccessRuleError('');
      const result = await sigurAdminService.saveEmployeeAccessRules(
        sigurEmployeeId,
        [...nextIds].sort((left, right) => left - right),
      );
      setProfile(prev => (
        prev
          ? { ...prev, accessRules: result.bindings }
          : prev
      ));
      setAccessRuleSavedFlash(true);
      window.setTimeout(() => setAccessRuleSavedFlash(false), 2200);
    } catch (error) {
      setAccessRuleError(error instanceof Error ? error.message : 'Не удалось сохранить режимы доступа');
    } finally {
      setSavingRuleId(null);
    }
  };

  if (!sigurEmployeeId) {
    return null;
  }

  return (
    <aside className="ep-sigur-panel">
      <div className="ep-sigur-panel-header">
        <div className="ep-sigur-header-top">
          <div className="ep-sigur-header-actions">
            <button
              className="ep-sigur-tool"
              type="button"
              onClick={() => void loadProfile(true, true)}
              disabled={loading}
            >
              <RefreshCw size={14} />
              <span>Обновить</span>
            </button>
            {canEdit && (
              <div className="ep-sigur-kebab-wrap" ref={actionsMenuRef}>
                <button
                  className="ep-sigur-kebab-btn"
                  type="button"
                  aria-label="Дополнительно"
                  aria-haspopup="menu"
                  aria-expanded={actionsMenuOpen}
                  onClick={() => setActionsMenuOpen(prev => !prev)}
                >
                  <MoreVertical size={16} />
                </button>
                {actionsMenuOpen && (
                  <div className="ep-sigur-kebab-menu" role="menu">
                    <button
                      className="ep-sigur-kebab-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        void handleToggleBlocked();
                      }}
                      disabled={runningAction === 'block' || runningAction === 'unblock'}
                    >
                      {isBlocked ? <UserRoundCheck size={14} /> : <UserLock size={14} />}
                      <span>
                        {runningAction === 'block' || runningAction === 'unblock'
                          ? 'Сохранение...'
                          : isBlocked ? 'Разблокировать' : 'Заблокировать'}
                      </span>
                    </button>
                    <button
                      className="ep-sigur-kebab-item danger"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setActionsMenuOpen(false);
                        void handleDelete();
                      }}
                      disabled={runningAction === 'delete'}
                    >
                      <Trash2 size={14} />
                      <span>{runningAction === 'delete' ? 'Удаление...' : 'Удалить'}</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            <button className="ep-sigur-close" type="button" onClick={onClose} aria-label="Закрыть">
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      <div className="ep-sigur-scroll">
        <div className="ep-sigur-summary">
          <div className="ep-sigur-avatar">{summaryBadge}</div>
          <div className="ep-sigur-summary-main">
            <div className="ep-sigur-summary-name">{fullName}</div>
            <div className="ep-sigur-pill-row">
              <span className={`ep-sigur-pill ${isBlocked ? 'ep-sigur-pill--danger' : 'ep-sigur-pill--success'}`}>
                <ShieldCheck size={12} />
                {isBlocked ? 'Заблокирован' : 'Активен'}
              </span>
              <span className="ep-sigur-pill">
                <span className="ep-sigur-pill-key">ID</span>
                <span className="ep-sigur-pill-value">{sigurEmployeeId}</span>
              </span>
              <span className="ep-sigur-pill">
                <span className="ep-sigur-pill-key">Таб. №</span>
                <span className="ep-sigur-pill-value">{tabNumber}</span>
              </span>
            </div>
          </div>
        </div>

        {loading && !profile && (
          <div className="ep-sigur-placeholder">Загрузка данных Sigur...</div>
        )}
        {profileError && <div className="ep-sigur-inline-error">{profileError}</div>}

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <Pencil size={15} />
              <span>Профиль</span>
            </div>
          </div>
          <div className="ep-sigur-field-stack">
            <FieldRow
              label="Должность"
              changed={fieldDrafts.positionId !== profileBaseline.positionId}
              saving={savingField === 'positionId'}
              saved={savedFieldFlash === 'positionId'}
              canEdit={canEdit}
              onSave={() => void handleSaveField('positionId')}
            >
              <select
                className="ep-sigur-field-input"
                value={fieldDrafts.positionId}
                onChange={event => handleFieldDraftChange('positionId', event.target.value)}
                disabled={!canEdit || savingField === 'positionId' || (positionsLoading && positions.length === 0)}
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
            </FieldRow>
            {canEdit && (
              <div className="ep-sigur-field-create">
                <input
                  className="ep-sigur-field-input"
                  value={newPositionName}
                  onChange={event => setNewPositionName(event.target.value)}
                  placeholder="Новая должность..."
                  disabled={creatingPosition}
                />
                <button
                  className="ep-sigur-field-create-btn"
                  type="button"
                  onClick={() => void handleCreatePosition()}
                  disabled={creatingPosition || !newPositionName.trim()}
                >
                  {creatingPosition ? <RefreshCw size={13} className="ep-sigur-spin" /> : <Plus size={13} />}
                  <span>{creatingPosition ? 'Создание...' : 'Создать'}</span>
                </button>
              </div>
            )}

            <FieldRow
              label="Отдел"
              changed={fieldDrafts.departmentId !== profileBaseline.departmentId}
              saving={savingField === 'departmentId'}
              saved={savedFieldFlash === 'departmentId'}
              canEdit={canEdit}
              onSave={() => void handleSaveField('departmentId')}
            >
              <select
                className="ep-sigur-field-input"
                value={fieldDrafts.departmentId}
                onChange={event => handleFieldDraftChange('departmentId', event.target.value)}
                disabled={!canEdit || savingField === 'departmentId'}
              >
                  <option value="">—</option>
                  {departmentOptions.map(option => (
                    <option key={option.id} value={option.id}>
                      {'\u00A0\u00A0'.repeat(option.level)}{option.name}
                    </option>
                  ))}
              </select>
            </FieldRow>

            <FieldRow
              label="ФИО"
              changed={fieldDrafts.name !== profileBaseline.name}
              saving={savingField === 'name'}
              saved={savedFieldFlash === 'name'}
              canEdit={canEdit}
              onSave={() => void handleSaveField('name')}
            >
              <input
                className="ep-sigur-field-input"
                value={fieldDrafts.name}
                onChange={event => handleFieldDraftChange('name', event.target.value)}
                disabled={!canEdit || savingField === 'name'}
              />
            </FieldRow>

            <FieldRow
              label="Табельный номер"
              changed={fieldDrafts.tabId !== profileBaseline.tabId}
              saving={savingField === 'tabId'}
              saved={savedFieldFlash === 'tabId'}
              canEdit={canEdit}
              onSave={() => void handleSaveField('tabId')}
            >
              <input
                className="ep-sigur-field-input"
                value={fieldDrafts.tabId}
                onChange={event => handleFieldDraftChange('tabId', event.target.value)}
                disabled={!canEdit || savingField === 'tabId'}
              />
            </FieldRow>

            <FieldRow
              label="Описание"
              changed={fieldDrafts.description !== profileBaseline.description}
              saving={savingField === 'description'}
              saved={savedFieldFlash === 'description'}
              canEdit={canEdit}
              onSave={() => void handleSaveField('description')}
              stacked
            >
              <textarea
                className="ep-sigur-field-input"
                value={fieldDrafts.description}
                onChange={event => handleFieldDraftChange('description', event.target.value)}
                disabled={!canEdit || savingField === 'description'}
                rows={3}
              />
            </FieldRow>
          </div>
        </section>

        <section className="ep-sigur-section">
          <div className="ep-sigur-section-head">
            <div className="ep-sigur-section-title">
              <CreditCard size={15} />
              <span>Карты доступа</span>
            </div>
            <div className="ep-sigur-section-tools">
              <span className="ep-sigur-counter">{profile?.cards.length || 0}</span>
              {canEdit && (
                <button
                  className="ep-sigur-head-btn primary"
                  type="button"
                  onClick={() => setCardReaderOpen(true)}
                >
                  <Plus size={13} />
                  Сканировать
                </button>
              )}
            </div>
          </div>

          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
          ) : profile.cards.length === 0 ? (
            <div className="ep-sigur-placeholder">Карты не найдены.</div>
          ) : (
            <div className="ep-sigur-card-list">
              {profile.cards.map(card => {
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
                          {savingCardId === card.cardId ? <RefreshCw size={13} className="ep-sigur-spin" /> : <Save size={13} />}
                        </button>
                      )}
                      {canEdit && (
                        <button
                          className="ep-sigur-card-trash-btn"
                          type="button"
                          aria-label="Удалить карту"
                          onClick={() => void handleRemoveCard(card)}
                          disabled={removingCardId === card.cardId}
                        >
                          {removingCardId === card.cardId ? <RefreshCw size={13} className="ep-sigur-spin" /> : <Trash2 size={13} />}
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
              <span className="ep-sigur-counter">{boundAccessPointIds.length}</span>
            </div>
          </div>

          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
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
                        <div className="ep-sigur-access-item-actions">
                          {item.hasMapPreview && (
                            <AccessPointMapPreviewBadge
                              accessPointName={item.name}
                              enabled={item.hasMapPreview}
                            />
                          )}
                          {canEdit && (
                            <button
                              className="ep-sigur-access-remove-btn"
                              type="button"
                              aria-label={`Удалить ${item.name}`}
                              onClick={() => void handleRemoveAccessPoint(item.id)}
                              disabled={accessPointSaving}
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit && profile && (
            <div className="ep-sigur-access-add-wrap" ref={accessPointPickerRef}>
              <button
                className="ep-sigur-access-add-btn"
                type="button"
                onClick={() => setAccessPointPickerOpen(prev => !prev)}
                disabled={accessPointSaving}
              >
                <Plus size={14} />
                <span>Добавить точку доступа</span>
              </button>
              {accessPointPickerOpen && (
                <div className="ep-sigur-access-picker">
                  {availableAccessPointGroups.length === 0 ? (
                    <div className="ep-sigur-placeholder">Нет доступных точек для добавления.</div>
                  ) : (
                    availableAccessPointGroups.map(group => (
                      <div key={group.key} className="ep-sigur-access-group">
                        <div className="ep-sigur-access-title">{group.title}</div>
                        <div className="ep-sigur-access-list">
                          {group.items.map(item => (
                            <button
                              key={item.id}
                              className="ep-sigur-access-pick-btn"
                              type="button"
                              onClick={() => void handleAddAccessPoint(item.id)}
                              disabled={accessPointSaving}
                            >
                              <Plus size={13} />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
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
              <span className="ep-sigur-counter">{boundAccessRuleIds.length}</span>
            </div>
          </div>
          {!profile ? (
            <div className="ep-sigur-placeholder">Данные ещё не загружены.</div>
          ) : profile.accessRuleOptions.length === 0 ? (
            <div className="ep-sigur-placeholder">Режимы доступа не настроены в Sigur.</div>
          ) : (
            <div className="ep-sigur-access-list selectable">
              {profile.accessRuleOptions.map(rule => (
                <label
                  key={rule.accessRuleId}
                  className={`ep-sigur-access-check ${boundAccessRuleSet.has(rule.accessRuleId) ? 'checked' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={boundAccessRuleSet.has(rule.accessRuleId)}
                    onChange={() => void handleToggleAccessRule(rule.accessRuleId)}
                    disabled={!canEdit || savingRuleId !== null}
                  />
                  <span>{rule.accessRuleName || `Режим #${rule.accessRuleId}`}</span>
                  {savingRuleId === rule.accessRuleId && (
                    <RefreshCw size={13} className="ep-sigur-spin" />
                  )}
                </label>
              ))}
            </div>
          )}
          {accessRuleError && <div className="ep-sigur-inline-error">{accessRuleError}</div>}
        </section>
      </div>

      {cardReaderOpen && sigurEmployeeId && (
        <CardReaderModal
          title="Привязать карту к сотруднику"
          mode={{
            kind: 'assign-to-sigur',
            presetSigurEmployeeId: sigurEmployeeId,
            presetEmployeeName: fullName,
            onAssigned: handleCardAssigned,
          }}
          onClose={() => setCardReaderOpen(false)}
        />
      )}
    </aside>
  );
};
