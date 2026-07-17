import { type FC, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Pencil, Plus } from 'lucide-react';
import { useToast } from '../../contexts/ToastContext';
import {
  adaptiveTestingService,
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
}

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
});

const coverageToEditor = (row: IAdaptiveCoverageRow): IEditorState => ({
  profileId: null,
  orgDepartmentId: row.departmentId,
  departmentName: row.departmentName ?? '',
  positionId: row.positionId,
  positionName: row.positionName,
  title: `${row.departmentName ?? 'Отдел'}${row.positionName ? ` — ${row.positionName}` : ''}`,
  dutiesText: '',
  competenciesText: '',
  isPublished: false,
});

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

  const profilesQuery = useQuery({ queryKey: PROFILES_KEY, queryFn: adaptiveTestingService.listProfiles, staleTime: 30_000 });
  const coverageQuery = useQuery({ queryKey: COVERAGE_KEY, queryFn: adaptiveTestingService.getCoverage, staleTime: 60_000 });

  const profiles = useMemo(() => profilesQuery.data ?? [], [profilesQuery.data]);
  const coverage = coverageQuery.data ?? [];

  const saveMutation = useMutation({
    mutationFn: async (state: IEditorState) => {
      const competencies = parseCompetencies(state.competenciesText);
      const input: IAdaptiveProfileInput = {
        orgDepartmentId: state.orgDepartmentId,
        positionId: state.positionId,
        title: state.title.trim(),
        dutiesText: state.dutiesText.trim(),
        competencies,
        isPublished: state.isPublished,
      };
      return state.profileId
        ? adaptiveTestingService.updateProfile(state.profileId, input)
        : adaptiveTestingService.createProfile(input);
    },
    onSuccess: () => {
      showToast('success', 'Профиль сохранён');
      setEditor(null);
      void queryClient.invalidateQueries({ queryKey: PROFILES_KEY });
      void queryClient.invalidateQueries({ queryKey: COVERAGE_KEY });
    },
    onError: (err: unknown) => {
      showToast('error', err instanceof Error ? err.message : 'Не удалось сохранить профиль');
    },
  });

  const findProfileForCoverage = (row: IAdaptiveCoverageRow): IAdaptiveProfile | undefined =>
    profiles.find(p => p.orgDepartmentId === row.departmentId
      && (p.positionId === row.positionId || (p.positionId === null && !row.hasExactProfile)));

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
        <div className={styles.editor}>
          <h3 className={styles.editorTitle}>
            {editor.profileId ? 'Профиль: ' : 'Новый профиль: '}
            {editor.departmentName}{editor.positionName ? ` · ${editor.positionName}` : ' · весь отдел'}
          </h3>
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
          <div className={styles.editorActions}>
            <button type="button" className={styles.secondaryBtn} onClick={() => setEditor(null)}>
              Отмена
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate(editor)}
            >
              {saveMutation.isPending ? 'Сохранение…' : 'Сохранить'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
