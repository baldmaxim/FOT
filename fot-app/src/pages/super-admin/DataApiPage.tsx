import { useMemo, useState, type FC } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../contexts/ToastContext';
import {
  dataApiService,
  type DataApiKey,
  type DataApiKeyTable,
  type DataApiSchemaTable,
  type DataApiRequestLog,
  type CreateKeyResult,
} from '../../services/dataApiService';
import {
  TABLE_GROUPS,
  OTHER_GROUP_ID,
  OTHER_GROUP_TITLE,
  getTableLabel,
  getTableGroupId,
  getTableOrder,
} from './dataApiTableGroups';
import styles from './DataApiPage.module.css';

interface IGroupedSchema {
  id: string;
  title: string;
  tables: DataApiSchemaTable[];
}

const KEYS_QUERY_KEY = ['data-api-keys'] as const;

const formatDate = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

interface IKeyStatus {
  label: string;
  className: string;
}

const getKeyStatus = (key: DataApiKey): IKeyStatus => {
  if (key.revoked_at) return { label: 'Отозван', className: styles.tagRevoked };
  if (key.expires_at && new Date(key.expires_at).getTime() <= Date.now()) {
    return { label: 'Истёк', className: styles.tagExpired };
  }
  return { label: 'Активен', className: styles.tagActive };
};

interface ICreateModalProps {
  onClose: () => void;
  onCreated: (result: CreateKeyResult) => void;
}

const CreateKeyModal: FC<ICreateModalProps> = ({ onClose, onCreated }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rateLimit, setRateLimit] = useState(60);
  const [expiresAt, setExpiresAt] = useState('');

  const mutation = useMutation({
    mutationFn: () => dataApiService.createKey({
      name: name.trim(),
      description: description.trim() || null,
      rate_limit_per_minute: rateLimit,
      expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    }),
    onSuccess: result => {
      toast.success('Ключ создан');
      queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
      onCreated(result);
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'Ошибка создания ключа'),
  });

  const handleSubmit = () => {
    if (!name.trim()) {
      toast.error('Укажите название ключа');
      return;
    }
    if (rateLimit < 1) {
      toast.error('Лимит запросов в минуту должен быть не меньше 1');
      return;
    }
    mutation.mutate();
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h3>Новый API-ключ</h3>
        <div className={styles.formRow}>
          <label>Название</label>
          <input
            className={styles.input}
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Например, integration-stub"
            maxLength={120}
          />
        </div>
        <div className={styles.formRow}>
          <label>Описание</label>
          <textarea
            className={styles.textarea}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Кому выдан и зачем"
            maxLength={500}
          />
        </div>
        <div className={styles.formRow}>
          <label>Лимит запросов в минуту</label>
          <input
            className={styles.input}
            type="number"
            min={1}
            max={10000}
            value={rateLimit}
            onChange={e => setRateLimit(Number(e.target.value) || 1)}
          />
        </div>
        <div className={styles.formRow}>
          <label>Действует до (необязательно)</label>
          <input
            className={styles.input}
            type="datetime-local"
            value={expiresAt}
            onChange={e => setExpiresAt(e.target.value)}
          />
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btn} onClick={onClose}>Отмена</button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={mutation.isPending}
            onClick={handleSubmit}
          >
            {mutation.isPending ? 'Создание…' : 'Создать ключ'}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ITokenModalProps {
  result: CreateKeyResult;
  onClose: () => void;
}

const TokenRevealModal: FC<ITokenModalProps> = ({ result, onClose }) => {
  const toast = useToast();
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(result.plaintext_token);
      toast.success('Скопировано в буфер обмена');
    } catch {
      toast.error('Не удалось скопировать');
    }
  };

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <h3>Сохраните токен</h3>
        <div className={styles.tokenBox}>
          <span className={styles.tokenWarn}>
            Токен показывается только сейчас. После закрытия окна восстановить его невозможно — придётся создать новый.
          </span>
          <div className={styles.tokenValue}>{result.plaintext_token}</div>
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleCopy}>
            Скопировать
          </button>
        </div>
        <div className={styles.muted}>
          Префикс <code className={styles.mono}>{result.prefix}</code> — публичный идентификатор, его видно в логах
          и списке ключей.
        </div>
        <div className={styles.modalFooter}>
          <button type="button" className={styles.btn} onClick={onClose}>Закрыть</button>
        </div>
      </div>
    </div>
  );
};

interface IAccessEditorProps {
  apiKey: DataApiKey;
  onClose: () => void;
}

const AccessEditorModal: FC<IAccessEditorProps> = ({ apiKey, onClose }) => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'access' | 'logs'>('access');

  const tablesQuery = useQuery({
    queryKey: ['data-api-key', apiKey.id, 'tables'],
    queryFn: () => dataApiService.getKeyTables(apiKey.id),
    staleTime: 30_000,
  });

  const schemaQuery = useQuery<DataApiSchemaTable[]>({
    queryKey: ['data-api-db-schema'],
    queryFn: () => dataApiService.getDbSchema(),
    staleTime: 60_000,
  });

  const logsQuery = useQuery<DataApiRequestLog[]>({
    queryKey: ['data-api-key', apiKey.id, 'logs'],
    queryFn: () => dataApiService.getKeyLogs(apiKey.id, 100),
    enabled: tab === 'logs',
    staleTime: 10_000,
  });

  const [selection, setSelection] = useState<Map<string, Set<string>> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');

  const initialSelection = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const row of tablesQuery.data ?? []) {
      map.set(row.table_name, new Set(row.allowed_fields));
    }
    return map;
  }, [tablesQuery.data]);

  const effectiveSelection = selection ?? initialSelection;

  const setTableField = (tableName: string, field: string, checked: boolean) => {
    const next = new Map(effectiveSelection);
    const fields = new Set(next.get(tableName) ?? []);
    if (checked) {
      fields.add(field);
    } else {
      fields.delete(field);
    }
    if (fields.size > 0) {
      next.set(tableName, fields);
    } else {
      next.delete(tableName);
    }
    setSelection(next);
  };

  const toggleAllFields = (tableName: string, allFields: string[], checked: boolean) => {
    const next = new Map(effectiveSelection);
    if (checked) {
      next.set(tableName, new Set(allFields));
    } else {
      next.delete(tableName);
    }
    setSelection(next);
  };

  const toggleExpand = (tableName: string) => {
    const next = new Set(expanded);
    if (next.has(tableName)) next.delete(tableName);
    else next.add(tableName);
    setExpanded(next);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const payload: DataApiKeyTable[] = [...effectiveSelection.entries()]
        .filter(([, fields]) => fields.size > 0)
        .map(([table_name, fields]) => ({
          table_name,
          allowed_fields: [...fields].sort(),
        }));
      return dataApiService.updateKeyTables(apiKey.id, payload);
    },
    onSuccess: () => {
      toast.success('Доступы сохранены');
      queryClient.invalidateQueries({ queryKey: ['data-api-key', apiKey.id, 'tables'] });
      onClose();
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'Ошибка сохранения'),
  });

  const filteredGroups = useMemo<IGroupedSchema[]>(() => {
    const all = schemaQuery.data ?? [];
    const term = search.trim().toLowerCase();

    const matches = (table: DataApiSchemaTable): boolean => {
      if (!term) return true;
      if (table.name.toLowerCase().includes(term)) return true;
      const warm = getTableLabel(table.name);
      if (warm && warm.toLowerCase().includes(term)) return true;
      return table.columns.some(c => c.name.toLowerCase().includes(term));
    };

    const buckets = new Map<string, DataApiSchemaTable[]>();
    for (const table of all) {
      if (!matches(table)) continue;
      const groupId = getTableGroupId(table.name);
      const arr = buckets.get(groupId) ?? [];
      arr.push(table);
      buckets.set(groupId, arr);
    }

    const groups: IGroupedSchema[] = [];
    for (const group of TABLE_GROUPS) {
      const tables = buckets.get(group.id);
      if (!tables || tables.length === 0) continue;
      tables.sort((a, b) => getTableOrder(a.name) - getTableOrder(b.name));
      groups.push({ id: group.id, title: group.title, tables });
    }

    const otherTables = buckets.get(OTHER_GROUP_ID);
    if (otherTables && otherTables.length > 0) {
      otherTables.sort((a, b) => a.name.localeCompare(b.name));
      groups.push({ id: OTHER_GROUP_ID, title: OTHER_GROUP_TITLE, tables: otherTables });
    }

    return groups;
  }, [schemaQuery.data, search]);

  const totalFiltered = useMemo(
    () => filteredGroups.reduce((sum, g) => sum + g.tables.length, 0),
    [filteredGroups],
  );

  return (
    <div className={styles.modalBackdrop} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.toolbar}>
          <h3>Ключ: {apiKey.name}</h3>
          <span className={styles.muted}>
            <code className={styles.mono}>{apiKey.key_prefix}</code>
          </span>
        </div>

        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'access' ? styles.tabActive : ''}`}
            onClick={() => setTab('access')}
          >
            Доступы
          </button>
          <button
            type="button"
            className={`${styles.tab} ${tab === 'logs' ? styles.tabActive : ''}`}
            onClick={() => setTab('logs')}
          >
            Лог запросов
          </button>
        </div>

        {tab === 'access' && (
          <>
            {tablesQuery.isLoading || schemaQuery.isLoading ? (
              <div className={styles.loading}>Загрузка…</div>
            ) : (
              <>
                <input
                  className={styles.toolbarSearch}
                  placeholder="Поиск по таблице или полю"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
                <div className={styles.tableList}>
                  {filteredGroups.map(group => (
                    <div key={group.id} className={styles.groupBlock}>
                      <div className={styles.groupHeader}>{group.title}</div>
                      {group.tables.map(table => {
                        const warmLabel = getTableLabel(table.name);
                        const selectedFields = effectiveSelection.get(table.name);
                        const allChecked = !!selectedFields && selectedFields.size === table.columns.length;
                        const partial = !!selectedFields && selectedFields.size > 0 && !allChecked;
                        const isOpen = expanded.has(table.name) || partial;
                        return (
                          <div key={table.name} className={styles.tableItem}>
                            <div className={styles.tableHeader}>
                              <input
                                type="checkbox"
                                checked={allChecked}
                                ref={el => {
                                  if (el) el.indeterminate = partial;
                                }}
                                onChange={e => toggleAllFields(table.name, table.columns.map(c => c.name), e.target.checked)}
                              />
                              <div className={styles.tableHeaderTitle}>
                                <strong>{warmLabel ?? table.name}</strong>
                                {warmLabel && (
                                  <div className={styles.tableSubname}>
                                    <code className={styles.mono}>{table.name}</code>
                                  </div>
                                )}
                              </div>
                              <span className={styles.muted}>
                                {selectedFields ? `${selectedFields.size} / ${table.columns.length}` : `0 / ${table.columns.length}`}
                              </span>
                              <span className={styles.spacer} />
                              <button type="button" className={styles.btn} onClick={() => toggleExpand(table.name)}>
                                {isOpen ? 'Свернуть' : 'Поля'}
                              </button>
                            </div>
                            {isOpen && (
                              <div className={styles.fieldsGrid}>
                                {table.columns.map(column => {
                                  const checked = selectedFields?.has(column.name) ?? false;
                                  return (
                                    <label key={column.name}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={e => setTableField(table.name, column.name, e.target.checked)}
                                      />
                                      {column.name}
                                      <span className={styles.muted}> · {column.data_type}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {totalFiltered === 0 && (
                    <div className={styles.empty}>Ничего не найдено</div>
                  )}
                </div>
                <div className={styles.modalFooter}>
                  <button type="button" className={styles.btn} onClick={onClose}>Отмена</button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => saveMutation.mutate()}
                    disabled={saveMutation.isPending}
                  >
                    {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {tab === 'logs' && (
          <>
            {logsQuery.isLoading ? (
              <div className={styles.loading}>Загрузка…</div>
            ) : !logsQuery.data || logsQuery.data.length === 0 ? (
              <div className={styles.empty}>Запросов пока не было</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>Время</th>
                      <th>Таблица</th>
                      <th>IP</th>
                      <th>Статус</th>
                      <th>Latency, мс</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logsQuery.data.map(log => (
                      <tr key={log.id}>
                        <td>{formatDate(log.created_at)}</td>
                        <td>{log.table_name ?? <span className={styles.muted}>—</span>}</td>
                        <td><code className={styles.mono}>{log.ip ?? '—'}</code></td>
                        <td>
                          <span className={`${styles.tag} ${log.status_code >= 400 ? styles.tagRevoked : styles.tagActive}`}>
                            {log.status_code}
                          </span>
                        </td>
                        <td>{log.latency_ms ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className={styles.modalFooter}>
              <button type="button" className={styles.btn} onClick={onClose}>Закрыть</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export const DataApiPage: FC = () => {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<CreateKeyResult | null>(null);
  const [editingKey, setEditingKey] = useState<DataApiKey | null>(null);

  const keysQuery = useQuery({
    queryKey: KEYS_QUERY_KEY,
    queryFn: () => dataApiService.listKeys(),
    staleTime: 30_000,
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => dataApiService.revokeKey(id),
    onSuccess: () => {
      toast.success('Ключ отозван');
      queryClient.invalidateQueries({ queryKey: KEYS_QUERY_KEY });
    },
    onError: error => toast.error(error instanceof Error ? error.message : 'Не удалось отозвать ключ'),
  });

  const handleRevoke = (key: DataApiKey) => {
    if (key.revoked_at) return;
    if (!confirm(`Отозвать ключ «${key.name}»? Это действие нельзя отменить.`)) return;
    revokeMutation.mutate(key.id);
  };

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <h2>API-ключи</h2>
        <span className={styles.spacer} />
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => setShowCreate(true)}
        >
          Новый ключ
        </button>
      </div>

      {keysQuery.isLoading ? (
        <div className={styles.loading}>Загрузка…</div>
      ) : keysQuery.error ? (
        <div className={styles.error}>
          {keysQuery.error instanceof Error ? keysQuery.error.message : 'Ошибка загрузки ключей'}
        </div>
      ) : !keysQuery.data || keysQuery.data.length === 0 ? (
        <div className={styles.empty}>Ключей пока нет. Создайте первый.</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Название</th>
                <th>Префикс</th>
                <th>Лимит/мин</th>
                <th>Создан</th>
                <th>Истекает</th>
                <th>Последний запрос</th>
                <th>Статус</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {keysQuery.data.map(key => {
                const status = getKeyStatus(key);
                return (
                  <tr key={key.id}>
                    <td>
                      <strong>{key.name}</strong>
                      {key.description && (
                        <div className={styles.muted}>{key.description}</div>
                      )}
                    </td>
                    <td><code className={styles.mono}>{key.key_prefix}</code></td>
                    <td>{key.rate_limit_per_minute}</td>
                    <td>{formatDate(key.created_at)}</td>
                    <td>{key.expires_at ? formatDate(key.expires_at) : <span className={styles.muted}>—</span>}</td>
                    <td>{key.last_used_at ? formatDate(key.last_used_at) : <span className={styles.muted}>никогда</span>}</td>
                    <td>
                      <span className={`${styles.tag} ${status.className}`}>{status.label}</span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className={styles.btn}
                          onClick={() => setEditingKey(key)}
                        >
                          Доступы
                        </button>
                        {!key.revoked_at && (
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            onClick={() => handleRevoke(key)}
                          >
                            Отозвать
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateKeyModal
          onClose={() => setShowCreate(false)}
          onCreated={result => {
            setShowCreate(false);
            setCreatedToken(result);
          }}
        />
      )}

      {createdToken && (
        <TokenRevealModal
          result={createdToken}
          onClose={() => setCreatedToken(null)}
        />
      )}

      {editingKey && (
        <AccessEditorModal
          apiKey={editingKey}
          onClose={() => setEditingKey(null)}
        />
      )}
    </div>
  );
};
