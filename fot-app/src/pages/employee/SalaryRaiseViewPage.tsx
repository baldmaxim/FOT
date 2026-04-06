import { type FC, useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  salaryRaiseService,
  REQUEST_TYPE_LABELS,
  STATUS_LABELS,
  STATUS_COLORS,
  RATING_OPTIONS,
  IMPACT_OPTIONS,
  RECOMMENDATION_OPTIONS,
  type ISalaryRaiseRequest,
  type ISupervisorReview,
  type IHrReview,
  type IFinanceReview,
} from '../../services/salaryRaiseService';
import styles from './SalaryRaiseViewPage.module.css';

const formatSalary = (v: number | null | undefined) =>
  v != null ? new Intl.NumberFormat('ru-RU').format(v) + ' ₽' : '—';
const formatDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('ru-RU') : '—';

const EMPTY_SUPERVISOR: ISupervisorReview = {
  support: true, recommended_salary: 0, argumentation: '',
  employee_year_rating: 'средний', reliability_rating: 'средний',
  loss_risk: 'средний', replaceable: false, confirmed_new_duties: false,
  impact_deadlines: 'умеренное', impact_quality: 'умеренное',
  impact_safety: 'незначительное', impact_contractors: 'незначительное',
  systemic_issues: false, recommendation: 'support',
};

const EMPTY_HR: IHrReview = {
  rules_compliance: true, previous_review_date: '', grade_compliance: true,
  salary_range_position: '', comparison_with_peers: '', hr_restrictions: 'нет',
  market_assessment: '', hr_recommendation: 'support',
};

const EMPTY_FINANCE: IFinanceReview = {
  current_budget: 0, monthly_fot_load: 0, yearly_fot_load: 0,
  coverage_source_exists: true, fits_department_limit: true, recommendation: 'approve',
};

export const SalaryRaiseViewPage: FC = () => {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { user, canAccess } = useAuth();

  const [request, setRequest] = useState<ISalaryRaiseRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Review forms
  const [supReview, setSupReview] = useState<ISupervisorReview>({ ...EMPTY_SUPERVISOR });
  const [hrReview, setHrReview] = useState<IHrReview>({ ...EMPTY_HR });
  const [finReview, setFinReview] = useState<IFinanceReview>({ ...EMPTY_FINANCE });

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await salaryRaiseService.getById(Number(id));
      setRequest(data);
      if (data.supervisor_review) setSupReview(data.supervisor_review as ISupervisorReview);
      if (data.hr_review) setHrReview(data.hr_review as IHrReview);
      if (data.finance_review) setFinReview(data.finance_review as IFinanceReview);
    } catch {
      navigate('/employee/salary-raise');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className={styles.loading}>Загрузка...</div>;
  if (!request) return null;

  const snapshot = request.employee_snapshot;
  const isAuthor = user?.id === request.author_user_id;
  const canCancel = isAuthor && ['draft', 'supervisor_review'].includes(request.status);
  const canEdit = isAuthor && request.status === 'draft';

  // Determine review permissions
  const showSupervisorForm = request.status === 'supervisor_review' && (canAccess('header') || canAccess('admin'));
  const showHrForm = request.status === 'hr_review' && canAccess('hr');
  const showFinanceForm = request.status === 'finance_review' && canAccess('admin');

  const handleReview = async (
    type: 'supervisor' | 'hr' | 'finance',
    action: 'approve' | 'reject',
  ) => {
    setSubmitting(true);
    try {
      if (type === 'supervisor') {
        await salaryRaiseService.supervisorReview(request.id, action, supReview);
      } else if (type === 'hr') {
        await salaryRaiseService.hrReview(request.id, action, hrReview);
      } else {
        await salaryRaiseService.financeReview(request.id, action, finReview);
      }
      await load();
    } catch (err) {
      console.error('Review error:', err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    setSubmitting(true);
    try {
      await salaryRaiseService.cancel(request.id);
      await load();
    } catch (err) {
      console.error('Cancel error:', err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.page}>
      <span className={styles.backLink} onClick={() => navigate('/employee/salary-raise')}>
        ← Назад к заявкам
      </span>

      {/* Status bar */}
      <div className={styles.statusBar}>
        <div className={styles.statusInfo}>
          <span className={styles.statusBadge} style={{
            background: STATUS_COLORS[request.status] + '18',
            color: STATUS_COLORS[request.status],
          }}>
            {STATUS_LABELS[request.status]}
          </span>
          <span className={styles.statusDate}>
            Создана: {formatDate(request.created_at)}
          </span>
        </div>
        <div className={styles.statusActions}>
          {canEdit && (
            <button className={styles.btnEdit} onClick={() => navigate(`/employee/salary-raise/${request.id}/edit`)}>
              Редактировать
            </button>
          )}
          {canCancel && (
            <button className={styles.btnCancel} onClick={handleCancel} disabled={submitting}>
              Отменить
            </button>
          )}
        </div>
      </div>

      {/* Блок А — Данные сотрудника */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={`${styles.sectionLabel} ${styles.sectionLabelBlue}`}>А</span> Данные сотрудника
        </h3>
        <div className={styles.infoGrid}>
          <div className={styles.infoItem}><span className={styles.infoLabel}>ФИО</span><span className={styles.infoValue}>{snapshot.full_name}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Должность</span><span className={styles.infoValue}>{snapshot.position_name || '—'}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Отдел</span><span className={styles.infoValue}>{snapshot.department_name || '—'}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Объект</span><span className={styles.infoValue}>{snapshot.work_object || '—'}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Текущий оклад</span><span className={styles.infoValue}>{formatSalary(snapshot.salary_actual ?? snapshot.current_salary)}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Руководитель</span><span className={styles.infoValue}>{snapshot.supervisor_name || '—'}</span></div>
        </div>
      </div>

      {/* Блок Б — Параметры */}
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>
          <span className={`${styles.sectionLabel} ${styles.sectionLabelBlue}`}>Б</span> Параметры заявки
        </h3>
        <div className={styles.infoGrid}>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Тип</span><span className={styles.infoValue}>{REQUEST_TYPE_LABELS[request.request_type]}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Запрашиваемый оклад</span><span className={styles.infoValue}>{formatSalary(request.requested_salary)} (+{request.raise_percentage}%)</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Желаемая дата</span><span className={styles.infoValue}>{formatDate(request.desired_effective_date)}</span></div>
          <div className={styles.infoItem}><span className={styles.infoLabel}>Дата найма</span><span className={styles.infoValue}>{formatDate(snapshot.hire_date)}</span></div>
          <div className={styles.infoValueFull}><span className={styles.infoLabel}>Причина</span><p>{request.reason_brief}</p></div>
        </div>
      </div>

      {/* Блок В — Достижения */}
      {request.achievements.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelBlue}`}>В</span> Достижения
          </h3>
          {request.achievements.map((a, idx) => (
            <div key={idx} className={styles.achievementCard}>
              <div className={styles.achievementTitle}>{a.task || `Достижение ${idx + 1}`}</div>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Период</span><span className={styles.infoValue}>{a.period || '—'}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Эффект</span><span className={styles.infoValue}>{a.effect || '—'}</span></div>
              </div>
              {a.description && <p className={styles.infoValueFull} style={{ marginTop: 8 }}>{a.description}</p>}
              {a.result && <div className={styles.infoItem} style={{ marginTop: 4 }}><span className={styles.infoLabel}>Результат</span><span className={styles.infoValue}>{a.result}</span></div>}
            </div>
          ))}
        </div>
      )}

      {/* Блок Г — Обязанности (read-only) */}
      {request.responsibility_changes && Object.values(request.responsibility_changes).some(Boolean) && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelBlue}`}>Г</span> Изменение обязанностей
          </h3>
          {[
            { key: 'new_functions', label: 'Новые функции' },
            { key: 'team_growth', label: 'Рост команды' },
            { key: 'complexity_increase', label: 'Рост сложности' },
            { key: 'cross_functional', label: 'Кросс-функциональность' },
          ].map(({ key, label }) => {
            const rc = request.responsibility_changes as Record<string, unknown>;
            if (!rc[key]) return null;
            return (
              <div key={key} className={styles.toggleItem}>
                <span className={styles.toggleIcon}>&#10003;</span>
                <div>
                  <div className={styles.toggleText}>{label}</div>
                  {rc[`${key}_desc`] && <div className={styles.toggleDesc}>{rc[`${key}_desc`] as string}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Блок Д — Самооценка (read-only) */}
      {request.self_assessment && Object.values(request.self_assessment).some(Boolean) && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelBlue}`}>Д</span> Самооценка
          </h3>
          {[
            { key: 'strengths', label: 'Сильные стороны' },
            { key: 'development_areas', label: 'Области развития' },
            { key: 'career_goals', label: 'Карьерные цели' },
          ].map(({ key, label }) => {
            const sa = request.self_assessment as Record<string, string>;
            if (!sa[key]) return null;
            return (
              <div key={key} className={styles.infoItem} style={{ marginBottom: 12 }}>
                <span className={styles.infoLabel}>{label}</span>
                <span className={styles.infoValue} style={{ whiteSpace: 'pre-wrap' }}>{sa[key]}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Блок Е — Рецензия руководителя */}
      {(request.supervisor_review || showSupervisorForm) && (
        <div className={`${styles.reviewSection} ${showSupervisorForm ? styles.active : request.supervisor_review ? styles.completed : ''}`}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelAmber}`}>Е</span> Рецензия руководителя
          </h3>
          {request.supervisor_review && !showSupervisorForm ? (
            <>
              <div className={styles.reviewerInfo}>
                Рецензент: {request.supervisor_reviewer_id} | {formatDate(request.supervisor_reviewed_at)}
              </div>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Поддерживает</span><span className={styles.infoValue}>{(request.supervisor_review as ISupervisorReview).support ? 'Да' : 'Нет'}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Рекомендуемый оклад</span><span className={styles.infoValue}>{formatSalary((request.supervisor_review as ISupervisorReview).recommended_salary)}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Оценка сотрудника</span><span className={styles.infoValue}>{(request.supervisor_review as ISupervisorReview).employee_year_rating}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Риск потери</span><span className={styles.infoValue}>{(request.supervisor_review as ISupervisorReview).loss_risk}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Рекомендация</span><span className={styles.infoValue}>{RECOMMENDATION_OPTIONS.find(o => o.value === (request.supervisor_review as ISupervisorReview).recommendation)?.label}</span></div>
              </div>
              {(request.supervisor_review as ISupervisorReview).argumentation && (
                <div className={styles.infoValueFull} style={{ marginTop: 12 }}>
                  <span className={styles.infoLabel}>Аргументация</span>
                  <p>{(request.supervisor_review as ISupervisorReview).argumentation}</p>
                </div>
              )}
            </>
          ) : showSupervisorForm ? (
            <>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Рекомендуемый оклад (₽)</label>
                  <input type="number" className={styles.formInput} value={supReview.recommended_salary || ''}
                    onChange={e => setSupReview(p => ({ ...p, recommended_salary: Number(e.target.value) }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Оценка за год</label>
                  <select className={styles.formSelect} value={supReview.employee_year_rating}
                    onChange={e => setSupReview(p => ({ ...p, employee_year_rating: e.target.value }))}>
                    {RATING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Надёжность</label>
                  <select className={styles.formSelect} value={supReview.reliability_rating}
                    onChange={e => setSupReview(p => ({ ...p, reliability_rating: e.target.value }))}>
                    {RATING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Риск потери</label>
                  <select className={styles.formSelect} value={supReview.loss_risk}
                    onChange={e => setSupReview(p => ({ ...p, loss_risk: e.target.value }))}>
                    {RATING_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Влияние на сроки</label>
                  <select className={styles.formSelect} value={supReview.impact_deadlines}
                    onChange={e => setSupReview(p => ({ ...p, impact_deadlines: e.target.value }))}>
                    {IMPACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Влияние на качество</label>
                  <select className={styles.formSelect} value={supReview.impact_quality}
                    onChange={e => setSupReview(p => ({ ...p, impact_quality: e.target.value }))}>
                    {IMPACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Рекомендация</label>
                  <select className={styles.formSelect} value={supReview.recommendation}
                    onChange={e => setSupReview(p => ({ ...p, recommendation: e.target.value }))}>
                    {RECOMMENDATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className={styles.formGroupFull}>
                  <label className={styles.formLabel}>Аргументация</label>
                  <textarea className={styles.formTextarea} value={supReview.argumentation}
                    onChange={e => setSupReview(p => ({ ...p, argumentation: e.target.value }))}
                    placeholder="Обоснование вашего решения" />
                </div>
              </div>
              <div className={styles.reviewActions}>
                <button className={styles.btnApprove} onClick={() => handleReview('supervisor', 'approve')} disabled={submitting}>Одобрить</button>
                <button className={styles.btnReject} onClick={() => handleReview('supervisor', 'reject')} disabled={submitting}>Отклонить</button>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Блок З — Рецензия HR */}
      {(request.hr_review || showHrForm) && (
        <div className={`${styles.reviewSection} ${showHrForm ? styles.active : request.hr_review ? styles.completed : ''}`}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelPurple}`}>З</span> Рецензия HR
          </h3>
          {request.hr_review && !showHrForm ? (
            <>
              <div className={styles.reviewerInfo}>
                Рецензент: {request.hr_reviewer_id} | {formatDate(request.hr_reviewed_at)}
              </div>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Соответствие правилам</span><span className={styles.infoValue}>{(request.hr_review as IHrReview).rules_compliance ? 'Да' : 'Нет'}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Соответствие грейду</span><span className={styles.infoValue}>{(request.hr_review as IHrReview).grade_compliance ? 'Да' : 'Нет'}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Рыночная оценка</span><span className={styles.infoValue}>{(request.hr_review as IHrReview).market_assessment || '—'}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Рекомендация</span><span className={styles.infoValue}>{RECOMMENDATION_OPTIONS.find(o => o.value === (request.hr_review as IHrReview).hr_recommendation)?.label}</span></div>
              </div>
            </>
          ) : showHrForm ? (
            <>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Позиция в вилке оклада</label>
                  <input className={styles.formInput} value={hrReview.salary_range_position}
                    onChange={e => setHrReview(p => ({ ...p, salary_range_position: e.target.value }))} placeholder="Нижняя / средняя / верхняя" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Сравнение с коллегами</label>
                  <input className={styles.formInput} value={hrReview.comparison_with_peers}
                    onChange={e => setHrReview(p => ({ ...p, comparison_with_peers: e.target.value }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Рыночная оценка</label>
                  <input className={styles.formInput} value={hrReview.market_assessment}
                    onChange={e => setHrReview(p => ({ ...p, market_assessment: e.target.value }))} placeholder="Оценка рыночного уровня" />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>HR ограничения</label>
                  <input className={styles.formInput} value={hrReview.hr_restrictions}
                    onChange={e => setHrReview(p => ({ ...p, hr_restrictions: e.target.value }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Рекомендация</label>
                  <select className={styles.formSelect} value={hrReview.hr_recommendation}
                    onChange={e => setHrReview(p => ({ ...p, hr_recommendation: e.target.value }))}>
                    {RECOMMENDATION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </div>
              <div className={styles.reviewActions}>
                <button className={styles.btnApprove} onClick={() => handleReview('hr', 'approve')} disabled={submitting}>Одобрить</button>
                <button className={styles.btnReject} onClick={() => handleReview('hr', 'reject')} disabled={submitting}>Отклонить</button>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* Блок И — Рецензия финансов */}
      {(request.finance_review || showFinanceForm) && (
        <div className={`${styles.reviewSection} ${showFinanceForm ? styles.active : request.finance_review ? styles.completed : ''}`}>
          <h3 className={styles.sectionTitle}>
            <span className={`${styles.sectionLabel} ${styles.sectionLabelGreen}`}>И</span> Финансовое согласование
          </h3>
          {request.finance_review && !showFinanceForm ? (
            <>
              <div className={styles.reviewerInfo}>
                Рецензент: {request.finance_reviewer_id} | {formatDate(request.finance_reviewed_at)}
              </div>
              <div className={styles.infoGrid}>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Бюджет</span><span className={styles.infoValue}>{formatSalary((request.finance_review as IFinanceReview).current_budget)}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Нагрузка на ФОТ (мес)</span><span className={styles.infoValue}>{formatSalary((request.finance_review as IFinanceReview).monthly_fot_load)}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Нагрузка на ФОТ (год)</span><span className={styles.infoValue}>{formatSalary((request.finance_review as IFinanceReview).yearly_fot_load)}</span></div>
                <div className={styles.infoItem}><span className={styles.infoLabel}>Укладывается в лимит</span><span className={styles.infoValue}>{(request.finance_review as IFinanceReview).fits_department_limit ? 'Да' : 'Нет'}</span></div>
              </div>
            </>
          ) : showFinanceForm ? (
            <>
              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Текущий бюджет (₽)</label>
                  <input type="number" className={styles.formInput} value={finReview.current_budget || ''}
                    onChange={e => setFinReview(p => ({ ...p, current_budget: Number(e.target.value) }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Нагрузка на ФОТ (мес, ₽)</label>
                  <input type="number" className={styles.formInput} value={finReview.monthly_fot_load || ''}
                    onChange={e => setFinReview(p => ({ ...p, monthly_fot_load: Number(e.target.value) }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Нагрузка на ФОТ (год, ₽)</label>
                  <input type="number" className={styles.formInput} value={finReview.yearly_fot_load || ''}
                    onChange={e => setFinReview(p => ({ ...p, yearly_fot_load: Number(e.target.value) }))} />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>Решение</label>
                  <select className={styles.formSelect} value={finReview.recommendation}
                    onChange={e => setFinReview(p => ({ ...p, recommendation: e.target.value }))}>
                    <option value="approve">Одобрить</option>
                    <option value="reject">Отклонить</option>
                  </select>
                </div>
              </div>
              <div className={styles.reviewActions}>
                <button className={styles.btnApprove} onClick={() => handleReview('finance', 'approve')} disabled={submitting}>Одобрить</button>
                <button className={styles.btnReject} onClick={() => handleReview('finance', 'reject')} disabled={submitting}>Отклонить</button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
};
