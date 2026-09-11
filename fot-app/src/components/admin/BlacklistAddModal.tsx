import { useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { ModalShell } from '../ui/ModalShell';
import { ApiError } from '../../api/client';
import { useToast } from '../../contexts/ToastContext';
import {
  adminService,
  type IBlacklistAddInput,
  type IBlacklistPerson,
  type IBlacklistResolved,
} from '../../services/adminService';
import { MEMO_ACCEPT, formatFileSize, uploadMemoFiles } from './blacklistMemoUpload';
import styles from '../../pages/admin/Admin.module.css';

const errMsg = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

interface IBlacklistAddModalProps {
  onClose: () => void;
  onDone: () => Promise<void> | void;
}

type Mode = 'search' | 'manual';

interface IAutofill {
  birthDate: boolean;
  passport: boolean;
  snils: boolean;
  note: string | null;
}

const EMPTY_AUTOFILL: IAutofill = { birthDate: false, passport: false, snils: false, note: null };

/**
 * Добавление в чёрный список. Главный путь — выбор человека поиском: тогда
 * идентификаторы приезжают из БД (сервер читает их сам по ref_id), а не с
 * клавиатуры, и сопоставление получается точным. Ручной ввод — для тех, кого
 * в базе нет вообще.
 */
export const BlacklistAddModal: FC<IBlacklistAddModalProps> = ({ onClose, onDone }) => {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('search');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<IBlacklistPerson[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<IBlacklistPerson | null>(null);
  const [resolved, setResolved] = useState<IBlacklistResolved | null>(null);
  const [confirmedWeak, setConfirmedWeak] = useState<number[]>([]);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  // Служебные записки (необязательно). Загружаются ПОСЛЕ создания записи отдельными
  // запросами: запрет не должен ждать файл, а повтор загрузки безопасен.
  const [memoFiles, setMemoFiles] = useState<File[]>([]);

  // Ручной ввод и дополнения к выбранному человеку.
  const [manualName, setManualName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [snils, setSnils] = useState('');
  const [email, setEmail] = useState('');
  const [passport, setPassport] = useState('');

  // Поля, подставленные из базы по выбранному человеку. Они заблокированы: при
  // сохранении сервер всё равно берёт значения из БД, а ручной ввод лишь
  // заполняет пустые поля — редактируемое, но игнорируемое поле сбивало бы с толку.
  const [autofilled, setAutofilled] = useState<IAutofill>(EMPTY_AUTOFILL);
  // Номер последнего выбора: ответ по устаревшему выбору игнорируем.
  const pickSeq = useRef(0);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Снимает подставленные значения; введённое вручную не трогаем. */
  const clearAutofill = () => {
    pickSeq.current += 1;
    if (autofilled.birthDate) setBirthDate('');
    if (autofilled.passport) setPassport('');
    if (autofilled.snils) setSnils('');
    setAutofilled(EMPTY_AUTOFILL);
  };

  useEffect(() => {
    if (mode !== 'search') return;
    if (search.trim().length < 2) {
      setResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await adminService.searchBlacklistPersons(search.trim()));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, mode]);

  const buildInput = (): IBlacklistAddInput => {
    const extra = {
      birth_date: birthDate || null,
      snils: snils.trim() || null,
      passport_series_number: passport.trim() || null,
    };
    if (mode === 'search' && picked) {
      return { person: { kind: picked.kind, ref_id: picked.ref_id }, extra, reason };
    }
    return {
      manual: {
        full_name: manualName.trim(),
        birth_date: birthDate || null,
        snils: snils.trim() || null,
        email: email.trim() || null,
        passport_series_number: passport.trim() || null,
      },
      reason,
    };
  };

  const handlePick = async (person: IBlacklistPerson) => {
    clearAutofill();
    const seq = pickSeq.current;
    setPicked(person);
    setResults([]);
    setSearch(person.full_name);
    try {
      const data = await adminService.resolveBlacklistTargets({
        person: { kind: person.kind, ref_id: person.ref_id },
        reason: 'предпросмотр',
      });
      // Пока ждали ответ, выбрали другого человека или начали новый поиск.
      if (seq !== pickSeq.current) return;
      setResolved(data);
      setConfirmedWeak([]);

      // Подставляем документы выбранного человека, если они в базе есть.
      const found = data.person;
      if (found.birth_date) setBirthDate(found.birth_date);
      if (found.passport_series_number) setPassport(found.passport_series_number);
      if (found.snils) setSnils(found.snils);
      setAutofilled({
        birthDate: !!found.birth_date,
        passport: !!found.passport_series_number,
        snils: !!found.snils,
        note: found.birth_date || found.passport_series_number || found.snils ? found.source_note : null,
      });
    } catch (e) {
      if (seq !== pickSeq.current) return;
      toast.error(errMsg(e, 'Не удалось определить, что будет заблокировано'));
    }
  };

  const handleSubmit = async () => {
    if (reason.trim().length < 3) {
      toast.error('Укажите причину внесения');
      return;
    }
    if (mode === 'search' && !picked) {
      toast.error('Выберите человека из списка');
      return;
    }
    if (mode === 'manual' && manualName.trim().length < 2) {
      toast.error('Укажите ФИО');
      return;
    }
    setSaving(true);
    try {
      const input = buildInput();
      const result = await adminService.addToBlacklist({
        ...input,
        confirmed_weak_sigur_ids: confirmedWeak,
      });
      if (result.created) toast.success('Внесён в чёрный список');
      else toast.info('Этот человек уже в чёрном списке');

      // Две независимые операции: запись уже создана (или переиспользована), файлы
      // прикладываются к ней. Сбой загрузки запись не отменяет.
      if (memoFiles.length > 0) {
        const summary = await uploadMemoFiles(result.data.id, memoFiles);
        if (summary.added.length > 0) toast.success(`Приложено служебных записок: ${summary.added.length}`);
        if (summary.duplicates.length > 0) toast.info(`Уже приложены ранее: ${summary.duplicates.join(', ')}`);
        if (summary.failed.length > 0) {
          toast.error(
            `Запись в чёрном списке, но не приложены: ${summary.failed.map(f => `${f.name} (${f.error})`).join('; ')}. `
            + 'Приложите их через «Записки» в строке — дубля не будет.',
          );
        }
      }
      await onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Не удалось добавить в чёрный список'));
    } finally {
      setSaving(false);
    }
  };

  // Без паспорта и даты рождения запрет не сработает при подаче через подрядчика:
  // у подрядного пропуска нет ни СНИЛС, ни почты, а одно ФИО только предупреждает.
  // Поля уже содержат и подставленные, и вписанные вручную значения.
  const weakIdentification = mode === 'manual'
    ? !birthDate && !passport.trim() && !snils.trim() && !email.trim()
    : !!resolved && !passport.trim() && !birthDate;

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    clearAutofill();
    setPicked(null);
    setResolved(null);
    setMode(next);
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.modalOverlay}
      containerClassName={styles.blacklistModal}
    >
      {({ requestClose }) => (
        <>
          <div className={styles.blacklistModalHeader}>
            <h2>Добавить в чёрный список</h2>
          </div>

          <div className={styles.blacklistModalTabs}>
            <button
              className={`${styles.tab} ${mode === 'search' ? styles.active : ''}`}
              onClick={() => switchMode('search')}
            >
              Выбрать человека
            </button>
            <button
              className={`${styles.tab} ${mode === 'manual' ? styles.active : ''}`}
              onClick={() => switchMode('manual')}
            >
              Ввести вручную
            </button>
          </div>

          <div className={styles.blacklistModalBody}>
            {mode === 'search' && (
              <>
                <label className={styles.blacklistField}>
                  <span>ФИО</span>
                  <input
                    type="text"
                    value={search}
                    placeholder="Начните вводить фамилию"
                    onChange={e => {
                      setSearch(e.target.value);
                      if (picked) clearAutofill();
                      setPicked(null);
                      setResolved(null);
                    }}
                  />
                </label>
                {searching && <div className={styles.blacklistHint}>Поиск…</div>}
                {results.length > 0 && (
                  <div className={styles.blacklistResults}>
                    {results.map(person2 => (
                      <button
                        key={`${person2.kind}:${person2.ref_id}`}
                        className={styles.blacklistResultRow}
                        onClick={() => handlePick(person2)}
                      >
                        <span className={styles.blacklistResultName}>{person2.full_name}</span>
                        <span className={styles.blacklistResultMeta}>
                          {person2.kind === 'contractor_pass'
                            ? `пропуск ${person2.pass_number ?? '—'} · ${person2.org_name ?? 'без организации'}`
                            : `сотрудник · ${person2.extra ?? ''}`}
                          {person2.birth_date ? ` · ${person2.birth_date}` : ''}
                          {person2.has_passport ? ' · паспорт есть' : ''}
                          {person2.has_snils ? ' · СНИЛС есть' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {picked && (
                  <div className={styles.blacklistPicked}>
                    Выбран: <strong>{picked.full_name}</strong>
                    {picked.pass_number ? ` (пропуск ${picked.pass_number})` : ''}
                  </div>
                )}
              </>
            )}

            {mode === 'manual' && (
              <label className={styles.blacklistField}>
                <span>ФИО</span>
                <input
                  type="text"
                  value={manualName}
                  onChange={e => setManualName(e.target.value)}
                  placeholder="Иванов Иван Иванович"
                />
              </label>
            )}

            <div className={styles.blacklistFieldRow}>
              <label className={styles.blacklistField}>
                <span>Дата рождения</span>
                <input
                  type="date"
                  value={birthDate}
                  readOnly={autofilled.birthDate}
                  onChange={e => setBirthDate(e.target.value)}
                />
              </label>
              <label className={styles.blacklistField}>
                <span>Паспорт</span>
                <input
                  type="text"
                  value={passport}
                  readOnly={autofilled.passport}
                  onChange={e => setPassport(e.target.value)}
                  placeholder="серия и номер"
                />
              </label>
            </div>

            <div className={styles.blacklistFieldRow}>
              <label className={styles.blacklistField}>
                <span>СНИЛС</span>
                <input
                  type="text"
                  value={snils}
                  readOnly={autofilled.snils}
                  onChange={e => setSnils(e.target.value)}
                  placeholder="123-456-789 00"
                />
              </label>
              {mode === 'manual' && (
                <label className={styles.blacklistField}>
                  <span>Почта</span>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} />
                </label>
              )}
            </div>

            {autofilled.note && (
              <div className={styles.blacklistHint}>
                Данные подставлены {autofilled.note}. Пустые поля можно заполнить вручную.
              </div>
            )}

            <label className={styles.blacklistField}>
              <span>Причина</span>
              <textarea
                rows={3}
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="Почему человек внесён в чёрный список"
              />
            </label>

            <div className={styles.blacklistField}>
              <span>Служебная записка (необязательно)</span>
              <input
                type="file"
                multiple
                accept={MEMO_ACCEPT}
                onChange={e => {
                  const picked = e.target.files ? Array.from(e.target.files) : [];
                  // Повторный выбор добавляет файлы, одинаковые по имени и размеру не дублирует.
                  setMemoFiles(prev => [
                    ...prev,
                    ...picked.filter(f => !prev.some(p => p.name === f.name && p.size === f.size)),
                  ]);
                  e.target.value = '';
                }}
              />
              {memoFiles.length > 0 && (
                <ul className={styles.blacklistMemoList}>
                  {memoFiles.map(file => (
                    <li key={`${file.name}:${file.size}`} className={styles.blacklistMemoItem}>
                      <div className={styles.blacklistMemoInfo}>
                        <span className={styles.blacklistMemoName}>{file.name}</span>
                        <span className={styles.blacklistSub}>{formatFileSize(file.size)}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.cancelBtn}
                        onClick={() => setMemoFiles(prev => prev.filter(p => p !== file))}
                        disabled={saving}
                      >
                        Убрать
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <span className={styles.blacklistSub}>
                PDF, JPEG, PNG, WebP, DOC или DOCX до 25 МБ. Можно приложить и позже — через «Записки» в строке.
              </span>
            </div>

            {weakIdentification && (
              <div className={styles.blacklistWarning}>
                Не заполнены паспорт и дата рождения. Запрет не сработает, если человека
                подадут через подрядную организацию — там сопоставить его можно только
                по этим документам. Впишите паспорт, если он известен.
              </div>
            )}

            {resolved && (resolved.strong.length > 0 || resolved.weak.length > 0) && (
              <div className={styles.blacklistTargets}>
                <div className={styles.blacklistHint}>Будет заблокировано в Sigur:</div>
                {resolved.strong.map(t => (
                  <div key={t.sigur_employee_id} className={styles.blacklistTargetRow}>
                    <span>
                      {t.kind === 'contractor_pass'
                        ? `пропуск ${t.pass_number ?? '—'} · ${t.org_name ?? ''}`
                        : 'карточка сотрудника'}
                      {` — ${t.label}`}
                    </span>
                    <span className={styles.blacklistSub}>по {t.match_reason}</span>
                  </div>
                ))}
                {resolved.weak.length > 0 && (
                  <>
                    <div className={styles.blacklistHint}>
                      Совпадение только по ФИО — подтвердите, если это тот же человек:
                    </div>
                    {resolved.weak.map(t => (
                      <label key={t.sigur_employee_id} className={styles.blacklistTargetRow}>
                        <input
                          type="checkbox"
                          checked={confirmedWeak.includes(t.sigur_employee_id)}
                          onChange={e => setConfirmedWeak(prev => (
                            e.target.checked
                              ? [...prev, t.sigur_employee_id]
                              : prev.filter(id => id !== t.sigur_employee_id)
                          ))}
                        />
                        <span>
                          {t.kind === 'contractor_pass'
                            ? `пропуск ${t.pass_number ?? '—'} · ${t.org_name ?? ''}`
                            : 'карточка сотрудника'}
                          {` — ${t.label}`}
                        </span>
                      </label>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>

          <div className={styles.blacklistModalFooter}>
            <button className={styles.cancelBtn} onClick={requestClose} disabled={saving}>
              Отмена
            </button>
            <button className={styles.primaryBtn} onClick={handleSubmit} disabled={saving}>
              {saving ? 'Добавление...' : 'Добавить'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
