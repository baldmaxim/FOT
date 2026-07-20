import { type ChangeEvent, type FC, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, FileText, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import { ModalShell } from '../ui/ModalShell';
import {
  adaptiveTestingService,
  SKILL_MD_MAX_CHARS,
  type IAdaptiveCoverageRow,
  type IAdaptiveProfile,
  type IAdaptiveProfileInput,
} from '../../services/adaptiveTestingService';
import styles from './AdaptiveProfilesPanel.module.css';

const PROFILES_KEY = ['adaptive-testing', 'profiles'] as const;
const COVERAGE_KEY = ['adaptive-testing', 'coverage'] as const;

interface IEditorState {
  profileId: string | null;
  orgDepartmentId: string;
  departmentName: string;
  positionId: string | null;
  positionName: string | null;
  title: string;
  dutiesText: string;
  /** Одна компетенция на строку: «Название — описание». */
  competenciesText: string;
  isPublished: boolean;
  /** Содержимое загруженного .md; null — файла нет. */
  skillMd: string | null;
  skillMdFilename: string | null;
  /** Должность строки покрытия — чтобы вернуться к охвату «только должность». */
  sourcePositionId: string | null;
  sourcePositionName: string | null;
}

/** Название по умолчанию — зависит от охвата, поэтому меняется вместе с ним. */
const autoTitle = (departmentName: string, positionName: string | null): string =>
  `${departmentName || 'Отдел'}${positionName ? ` — ${positionName}` : ' — весь отдел'}`;

const profileToEditor = (p: IAdaptiveProfile): IEditorState => ({
  profileId: p.id,
  orgDepartmentId: p.orgDepartmentId,
  departmentName: p.departmentName ?? '',
  positionId: p.positionId,
  positionName: p.positionName,
  title: p.title,
  dutiesText: p.dutiesText,
  competenciesText: p.competencies
    .map(c => (c.description ? `${c.name} — ${c.description}` : c.name))
    .join('\n'),
  isPublished: p.isPublished,
  skillMd: p.skillMd,
  skillMdFilename: p.skillMdFilename,
  sourcePositionId: p.positionId,
  sourcePositionName: p.positionName,
});

const coverageToEditor = (row: IAdaptiveCoverageRow): IEditorState => ({
  profileId: null,
  orgDepartmentId: row.departmentId,
  departmentName: row.departmentName ?? '',
  positionId: row.positionId,
  positionName: row.positionName,
  title: autoTitle(row.departmentName ?? '', row.positionName),
  dutiesText: '',
  competenciesText: '',
  isPublished: false,
  skillMd: null,
  skillMdFilename: null,
  sourcePositionId: row.positionId,
  sourcePositionName: row.positionName,
});

const formatChars = (n: number): string => n.toLocaleString('ru-RU');

/** Строки «Название — описание» → компетенции с ключами c1..cN. */
const parseCompetencies = (text: string): IAdaptiveProfileInput['competencies'] =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const [name, ...rest] = line.split('—');
      const description = rest.join('—').trim();
      return {
        key: `c${i + 1}`,
        name: name.trim(),
        ...(description ? { description } : {}),
      };
    });

export const AdaptiveProfilesPanel: FC = () => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [editor, setEditor] = useState<IEditorState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Смена охвата: «только должность» ↔ «весь отдел» (positionId = null).
   * Название подставляем заново, только если пользователь его не правил.
   */
  const handleScopeChange = (wholeDepartment: boolean) => {
    if (!editor) return;
    const nextPositionId = wholeDepartment ? null : editor.sourcePositionId;
    const nextPositionName = wholeDepartment ? null : editor.sourcePositionName;
    const wasAutoTitle = editor.title.trim() === autoTitle(editor.departmentName, editor.positionName).trim();
    setEditor({
      ...editor,
      positionId: nextPositionId,
      positionName: nextPositionName,
      title: wasAutoTitle ? autoTitle(editor.departmentName, nextPositionName) : editor.title,
    });
  };

  /**
   * Чтение .md на клиенте: содержимое уходит строкой вместе с профилем
   * (express.json допускает до 10 МБ), поэтому multipart-загрузка не нужна.
   */
  const handleSkillMdPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Сбрасываем input сразу: иначе повторный выбор того же файла не сработает.
    e.target.value = '';
    if (!file || !editor) return;

    if (!/\.(md|markdown)$/i.test(file.name)) {
      showToast('error', 'Нужен файл .md или .markdown');
      return;
    }
    try {
      const text = await file.text();
      const trimmed = text.trim();
      if (!trimmed) {
        showToast('error', 'Файл пустой');
        return;
      }
      if (trimmed.length > SKILL_MD_MAX_CHARS) {
        showToast('error', `Файл слишком большой: ${formatChars(trimmed.length)} символов, максимум ${formatChars(SKILL_MD_MAX_CHARS)}`);
        return;
      }
      setEditor({ ...editor, skillMd: text, skillMdFilename: file.name });
      showToast('success', `Файл «${file.name}» прикреплён — не забудьте сохранить`);
    } catch {
      showToast('error', 'Не удалось прочитать файл');
    }
  };

  const profilesQuery = useQuery({ queryKey: PROFILES_KEY, queryFn: adaptiveTestingService.listProfiles, staleTime: 30_000 });
  const coverageQuery = useQuery({ queryKey: COVERAGE_KEY, queryFn: adaptiveTestingService.getCoverage, staleTime: 60_000 });

  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  const coverage = coverageQuery.data ?? [];

  const saveMutation = useMutation({
    // requestClose приходит из ModalShell — закрываем с exit-анимацией,
    // размонтирование делает сам ModalShell через onClose.
    mutationFn: async ({ state }: { state: IEditorState; requestClose: () => void }) => {
      const competencies = parseCompetencies(state.competenciesText);
      const input: IAdaptiveProfileInput = {
        orgDepartmentId: state.orgDepartmentId,
        positionId: state.positionId,
        title: state.title.trim(),
        dutiesText: state.dutiesText.trim(),
        competencies,
        isPublished: state.isPublished,
        skillMd: state.skillMd,
        skillMdFilename: state.skillMdFilename,
      };
      return state.profileId
        ? adaptiveTestingService.updateProfile(state.profileId, input)
        : adaptiveTestingService.createProfile(input);
    },
    onSuccess: (_data, variables) => {
      showToast('success', 'Профиль сохранён');
      variables.requestClose();
      void queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
      void queryClient.invalidateQueries({ queryKey: COVERAGE_KEY });
    },
    onError: (err: unknown) => {
      showToast('error', err instanceof Error ? err.message : 'Не удалось сохранить профиль');
    },
  });

  /**
   * Строгое совпадение по скоупу строки: кнопка в таблице всегда работает с
   * профилем именно этой должности. Отделский профиль редактируется из списка
   * «Skill-профили» выше — иначе «Изменить» открывало бы чужой по охвату профиль.
   */
  const findProfileForCoverage = (row: IAdaptiveCoverageRow): IAdaptiveProfile | undefined =>
    profiles.find(p => p.orgDepartmentId === row.departmentId && p.positionId === row.positionId);

  return (
    <div className={styles.panel}>
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>Skill-профили</h3>
        </div>
        {profiles.length === 0 ? (
          <div className={styles.empty}>Профилей пока нет — создайте из таблицы покрытия ниже.</div>
        ) : (
          <div className={styles.profileList}>
            {profiles.map(p => (
              <div key={p.id} className={styles.profileRow}>
                <div className={styles.profileInfo}>
                  <span className={styles.profileTitle}>{p.title}</span>
                  <span className={styles.profileScope}>
                    {p.departmentName ?? '—'}{p.positionName ? ` · ${p.positionName}` : ' · весь отдел'}
                    {' · '}{p.competencies.length} комп.
                    {p.skillMdChars > 0 && (
                      <span className={styles.fileBadge}>
                        <FileText size={12} /> {p.skillMdFilename ?? 'skill.md'}
                      </span>
                    )}
                  </span>
                </div>
                <div className={styles.profileActions}>
                  {p.isPublished
                    ? <span className={styles.published}><CheckCircle2 size={14} /> Опубликован</span>
                    : <span className={styles.draft}>Черновик</span>}
                  <button type="button" className={styles.iconBtn} onClick={() => setEditor(profileToEditor(p))}>
                    <Pencil size={14} /> Изменить
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <h3>Покрытие профилями</h3>
          <span className={styles.sectionHint}>Активные сотрудники по отделам и должностям</span>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Отдел</th>
                <th>Должность</th>
                <th>Сотр.</th>
                <th>Профиль</th>
                <th aria-label="Действие" />
              </tr>
            </thead>
            <tbody>
              {coverage.map(row => {
                const covered = row.hasExactProfile || row.hasDepartmentProfile;
                const existing = findProfileForCoverage(row);
                return (
                  <tr key={`${row.departmentId}:${row.positionId ?? 'none'}`}>
                    <td>{row.departmentName ?? '—'}</td>
                    <td>{row.positionName ?? '—'}</td>
                    <td>{row.employees}</td>
                    <td>
                      {covered ? (
                        <span className={styles.published}>
                          <CheckCircle2 size={14} /> {row.hasExactProfile ? 'Точный' : 'Отдела'}
                        </span>
                      ) : (
                        <span className={styles.uncovered}><CircleAlert size={14} /> Нет</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => setEditor(existing ? profileToEditor(existing) : coverageToEditor(row))}
                      >
                        {existing ? <Pencil size={14} /> : <Plus size={14} />}
                        {existing ? 'Изменить' : 'Создать'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editor && (
        <ModalShell
          onClose={() => setEditor(null)}
          overlayClassName={styles.editorOverlay}
          containerClassName={styles.editorModal}
          aria-label="Профиль тестирования"
        >
          {({ requestClose }) => (
            <>
              <div className={styles.editorHead}>
                <h3 className={styles.editorTitle}>
                  {editor.profileId ? 'Профиль: ' : 'Новый профиль: '}
                  {editor.departmentName}{editor.positionName ? ` · ${editor.positionName}` : ' · весь отдел'}
                </h3>
                <button
                  type="button"
                  className={styles.editorClose}
                  onClick={requestClose}
                  disabled={saveMutation.isPending}
                  aria-label="Закрыть"
                >
                  <X size={18} />
                </button>
              </div>

              <div className={styles.editorBody}>
                {editor.sourcePositionId && (
                  <div className={styles.field}>
                    <span>Охват профиля</span>
                    <div className={styles.scopeSwitch}>
                      <button
                        type="button"
                        className={`${styles.scopeBtn} ${editor.positionId ? styles.scopeActive : ''}`}
                        onClick={() => handleScopeChange(false)}
                      >
                        Только должность «{editor.sourcePositionName ?? '—'}»
                      </button>
                      <button
                        type="button"
                        className={`${styles.scopeBtn} ${editor.positionId ? '' : styles.scopeActive}`}
                        onClick={() => handleScopeChange(true)}
                      >
                        Весь отдел
                      </button>
                    </div>
                    <span className={styles.fieldHint}>
                      {editor.positionId
                        ? 'Профиль применяется только к этой должности.'
                        : 'Профиль применяется ко всем должностям отдела, у которых нет собственного профиля.'}
                    </span>
                  </div>
                )}

                <label className={styles.field}>
                  <span>Название</span>
                  <input
                    value={editor.title}
                    onChange={e => setEditor({ ...editor, title: e.target.value })}
                    maxLength={300}
                  />
                </label>
                <label className={styles.field}>
                  <span>Обязанности и знания (источник вопросов для LLM)</span>
                  <textarea
                    value={editor.dutiesText}
                    onChange={e => setEditor({ ...editor, dutiesText: e.target.value })}
                    rows={8}
                    maxLength={8000}
                    placeholder="Опишите обязанности, регламенты и знания, которыми должен владеть сотрудник…"
                  />
                </label>
                <div className={styles.field}>
                  <span>Файл скилла (.md) — развёрнутое описание для ИИ</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".md,.markdown,text/markdown"
                    className={styles.hiddenFileInput}
                    onChange={handleSkillMdPick}
                  />
                  {editor.skillMd ? (
                    <div className={styles.fileCard}>
                      <FileText size={16} className={styles.fileIcon} />
                      <div className={styles.fileInfo}>
                        <span className={styles.fileName}>{editor.skillMdFilename ?? 'skill.md'}</span>
                        <span className={styles.fileMeta}>{formatChars(editor.skillMd.trim().length)} символов</span>
                      </div>
                      <div className={styles.fileActions}>
                        <button type="button" className={styles.iconBtn} onClick={() => fileInputRef.current?.click()}>
                          <Upload size={14} /> Заменить
                        </button>
                        <button
                          type="button"
                          className={styles.iconBtn}
                          onClick={() => setEditor({ ...editor, skillMd: null, skillMdFilename: null })}
                        >
                          <Trash2 size={14} /> Удалить
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" className={styles.uploadBtn} onClick={() => fileInputRef.current?.click()}>
                      <Upload size={16} /> Загрузить .md
                    </button>
                  )}
                  <span className={styles.fieldHint}>
                    Файл целиком передаётся ИИ при составлении каждого вопроса. Не загружайте документы
                    с паролями, токенами и персональными данными. Максимум {formatChars(SKILL_MD_MAX_CHARS)} символов.
                  </span>
                  {editor.skillMd && (
                    <details className={styles.preview}>
                      <summary>Предпросмотр</summary>
                      <pre className={styles.previewBody}>
                        {editor.skillMd.trim().slice(0, 2000)}
                        {editor.skillMd.trim().length > 2000 ? '\n\n…' : ''}
                      </pre>
                    </details>
                  )}
                </div>

                <label className={styles.field}>
                  <span>Компетенции — одна на строку: «Название — описание» (до 15)</span>
                  <textarea
                    value={editor.competenciesText}
                    onChange={e => setEditor({ ...editor, competenciesText: e.target.value })}
                    rows={6}
                    placeholder={'Оформление документов — порядок и сроки оформления\nВзаимодействие с подрядчиками — правила и эскалация'}
                  />
                </label>
                <label className={styles.checkboxField}>
                  <input
                    type="checkbox"
                    checked={editor.isPublished}
                    onChange={e => setEditor({ ...editor, isPublished: e.target.checked })}
                  />
                  <span>Опубликован (используется в тестировании)</span>
                </label>
              </div>

              <div className={styles.editorActions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={requestClose}
                  disabled={saveMutation.isPending}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate({ state: editor, requestClose })}
                >
                  {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
                </button>
              </div>
            </>
          )}
        </ModalShell>
      )}
    </div>
  );
};
