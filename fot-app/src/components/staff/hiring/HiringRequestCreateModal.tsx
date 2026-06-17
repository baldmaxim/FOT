import { useState, type FC } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { hiringRequestService, type IHiringRequestDetail } from '../../../services/hiringRequestService';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { useToast } from '../../../contexts/ToastContext';
import { HIRING_QK } from './HiringRequestsBoard';
import styles from './hiring.module.css';

interface IProps {
  onClose: () => void;
  request?: IHiringRequestDetail; // режим редактирования
}

export const HiringRequestCreateModal: FC<IProps> = ({ onClose, request }) => {
  const dismiss = useOverlayDismiss(onClose);
  const toast = useToast();
  const qc = useQueryClient();
  const isEdit = !!request;

  const [f, setF] = useState({
    position_title: request?.position_title ?? '',
    customer_name: request?.customer_name ?? '',
    headcount: request?.headcount ?? 1,
    start_work_date: request?.start_work_date ?? '',
    deadline: request?.deadline ?? '',
    duties: request?.duties ?? '',
    experience: request?.experience ?? '',
    requirements: request?.requirements ?? '',
    software: request?.software ?? '',
    gender: request?.gender ?? 'any',
    salary_level: request?.salary_level ?? '',
    hh_vacancy_url: request?.hh_vacancy_url ?? '',
  });
  const set = (k: keyof typeof f, v: string | number) => setF(p => ({ ...p, [k]: v }));

  const mutation = useMutation({
    mutationFn: async () => {
      const body = { ...f, headcount: Number(f.headcount) || 1, gender: f.gender as 'any' | 'male' | 'female' };
      if (isEdit && request) return hiringRequestService.update(request.id, body);
      return hiringRequestService.create(body);
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Заявка обновлена' : 'Заявка создана');
      qc.invalidateQueries({ queryKey: HIRING_QK });
      if (isEdit && request) qc.invalidateQueries({ queryKey: ['hiring-request', request.id] });
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ошибка сохранения'),
  });

  const submit = () => {
    if (!f.position_title.trim()) { toast.error('Укажите должность'); return; }
    if (!f.deadline && !isEdit) { /* deadline желателен, но не обязателен */ }
    mutation.mutate();
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <div>
            <h3>{isEdit ? 'Редактирование заявки' : 'Заявка на поиск сотрудника'}</h3>
            <p>Поля с <span className={styles.req}>*</span> обязательны. Серый текст — пример заполнения.</p>
          </div>
          <button className={styles.x} onClick={onClose}>✕</button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label>Дата поступления в работу</label>
              <input type="date" value={f.start_work_date ?? ''} onChange={e => set('start_work_date', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Заказчик ФИО</label>
              <input placeholder="Иванов Иван Иванович" value={f.customer_name} onChange={e => set('customer_name', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Должность <span className={styles.req}>*</span></label>
              <input placeholder="инженер контроля качества по фасадным работам" value={f.position_title} onChange={e => set('position_title', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Сколько человек требуется <span className={styles.req}>*</span></label>
              <input type="number" min={1} placeholder="1" value={f.headcount} onChange={e => set('headcount', Number(e.target.value))} />
            </div>
            <div className={`${styles.field} ${styles.full}`}>
              <label>Обязанности</label>
              <textarea placeholder="операционный контроль качества всех видов СМР по СПК и НВФ, сдача работ Заказчику, выдача замечаний/предписаний, входной контроль материалов и т.д." value={f.duties} onChange={e => set('duties', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Опыт работы</label>
              <input placeholder="От 3 лет" value={f.experience} onChange={e => set('experience', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Пол</label>
              <select value={f.gender} onChange={e => set('gender', e.target.value)}>
                <option value="any">Не важно</option>
                <option value="male">Мужской</option>
                <option value="female">Женский</option>
              </select>
            </div>
            <div className={`${styles.field} ${styles.full}`}>
              <label>Требования</label>
              <textarea placeholder="высшее образование" value={f.requirements} onChange={e => set('requirements', e.target.value)} />
            </div>
            <div className={`${styles.field} ${styles.full}`}>
              <label>Программы</label>
              <input placeholder="AutoCad, Excel, Word и другие" value={f.software} onChange={e => set('software', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Срок закрытия (дедлайн)</label>
              <input type="date" value={f.deadline ?? ''} onChange={e => set('deadline', e.target.value)} />
            </div>
            <div className={styles.field}>
              <label>Ссылка на вакансию HH</label>
              <input placeholder="https://hh.kz/vacancy/..." value={f.hh_vacancy_url} onChange={e => set('hh_vacancy_url', e.target.value)} />
            </div>
            <div className={`${styles.field} ${styles.full}`}>
              <label>Уровень заработной платы</label>
              <textarea placeholder="по договорённости: … на испытательный срок, … после испытательного срока" value={f.salary_level} onChange={e => set('salary_level', e.target.value)} />
            </div>
          </div>
        </div>

        <div className={styles.modalFoot}>
          <button className={styles.btnGhost} onClick={onClose}>Отмена</button>
          <button className={styles.btnPrimary} disabled={mutation.isPending} onClick={submit}>
            {isEdit ? 'Сохранить' : 'Создать заявку'}
          </button>
        </div>
      </div>
    </div>
  );
};
