import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { documentService } from '../../services/documentService';
import { employeeService } from '../../services/employeeService';
import { officialMemoService, MEMO_STATUS_LABELS, type IOfficialMemo } from '../../services/officialMemoService';
import type { Employee } from '../../types/employee';

const pageStyle: CSSProperties = {
  minHeight: '100vh',
  background: 'var(--bg-primary)',
  padding: '24px 16px 48px',
  display: 'flex',
  justifyContent: 'center',
};

const containerStyle: CSSProperties = {
  width: '100%',
  maxWidth: 720,
  display: 'grid',
  gap: 20,
};

const cardStyle: CSSProperties = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-primary)',
  borderRadius: 20,
  padding: 20,
  display: 'grid',
  gap: 12,
};

const labelStyle: CSSProperties = { color: 'var(--text-secondary)', fontSize: 13 };
const valueStyle: CSSProperties = { fontSize: 18, fontWeight: 600 };

const primaryButton: CSSProperties = {
  padding: '14px 20px',
  borderRadius: 14,
  border: 'none',
  background: 'var(--accent-primary, #4b6cff)',
  color: '#fff',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButton: CSSProperties = {
  ...primaryButton,
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-primary)',
};

const dangerLinkButton: CSSProperties = {
  ...secondaryButton,
  borderColor: 'transparent',
  color: 'var(--text-secondary)',
  fontSize: 14,
  padding: '10px 12px',
};

const statusBadgeStyle = (status: IOfficialMemo['status']): CSSProperties => {
  const palette: Record<IOfficialMemo['status'], string> = {
    pending: '#b78103',
    approved: '#1e7e34',
    rejected: '#b23a48',
    cancelled: 'var(--text-secondary)',
  };
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    background: 'var(--bg-primary)',
    color: palette[status],
    border: `1px solid ${palette[status]}33`,
  };
};

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
};

const daysUntil = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60_000));
};

const PATENT_WARN_DAYS = 30;

export const ObjectWorkerDashboardPage: FC = () => {
  const { profile, logout, positionType } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isPreview = positionType === 'super_admin' && searchParams.get('preview') === 'worker';
  const employeeId = profile?.employee_id ?? null;

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [employeeLoading, setEmployeeLoading] = useState<boolean>(true);
  const [memos, setMemos] = useState<IOfficialMemo[]>([]);
  const [memosLoading, setMemosLoading] = useState<boolean>(true);
  const [uploading, setUploading] = useState<boolean>(false);
  const [memoDialogOpen, setMemoDialogOpen] = useState<boolean>(false);
  const [memoTitle, setMemoTitle] = useState<string>('');
  const [memoBody, setMemoBody] = useState<string>('');
  const [memoSubmitting, setMemoSubmitting] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!employeeId) {
      setEmployeeLoading(false);
      return;
    }
    setEmployeeLoading(true);
    employeeService.getById(employeeId)
      .then(data => { if (!cancelled) setEmployee(data); })
      .catch(err => {
        console.error('employee load error:', err);
        if (!cancelled) toast.error('Не удалось загрузить данные сотрудника');
      })
      .finally(() => { if (!cancelled) setEmployeeLoading(false); });
    return () => { cancelled = true; };
  }, [employeeId, toast]);

  const reloadMemos = () => {
    if (!employeeId) {
      setMemos([]);
      setMemosLoading(false);
      return;
    }
    setMemosLoading(true);
    officialMemoService.listMy()
      .then(data => setMemos(data || []))
      .catch(err => {
        console.error('memos load error:', err);
        toast.error('Не удалось загрузить служебные записки');
      })
      .finally(() => setMemosLoading(false));
  };

  useEffect(() => {
    reloadMemos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId]);

  const patentExpiryDate = employee?.patent_expiry_date ?? null;
  const patentDaysLeft = useMemo(() => daysUntil(patentExpiryDate), [patentExpiryDate]);
  const patentHighlight: CSSProperties = useMemo(() => {
    if (patentDaysLeft === null) return { color: 'var(--text-primary)' };
    if (patentDaysLeft <= 0) return { color: '#b23a48' };
    if (patentDaysLeft <= PATENT_WARN_DAYS) return { color: '#b78103' };
    return { color: 'var(--text-primary)' };
  }, [patentDaysLeft]);

  const patentHelper = useMemo(() => {
    if (!patentExpiryDate) return 'Срок патента не указан.';
    if (patentDaysLeft === null) return '';
    if (patentDaysLeft < 0) return `Срок истёк ${Math.abs(patentDaysLeft)} дн. назад. Обновите патент как можно скорее.`;
    if (patentDaysLeft === 0) return 'Срок истекает сегодня. Обновите патент.';
    if (patentDaysLeft <= PATENT_WARN_DAYS) return `Осталось ${patentDaysLeft} дн. Не забудьте обновить.`;
    return `Осталось ${patentDaysLeft} дн.`;
  }, [patentExpiryDate, patentDaysLeft]);

  const handleOpenFilePicker = () => {
    if (!employeeId || uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !employeeId) return;

    setUploading(true);
    try {
      await documentService.uploadFile(file, employeeId, 'patent_check');
      toast.success('Чек от патента загружен');
    } catch (err) {
      console.error('patent check upload error:', err);
      toast.error('Не удалось загрузить чек');
    } finally {
      setUploading(false);
    }
  };

  const handleOpenMemoDialog = () => {
    if (!employeeId) {
      toast.warning('Нет привязки к сотруднику');
      return;
    }
    setMemoTitle('');
    setMemoBody('');
    setMemoDialogOpen(true);
  };

  const handleSubmitMemo = async (e: FormEvent) => {
    e.preventDefault();
    const title = memoTitle.trim();
    const body = memoBody.trim();
    if (!title || !body) {
      toast.warning('Заполните тему и текст записки');
      return;
    }
    setMemoSubmitting(true);
    try {
      await officialMemoService.create({ title, body });
      toast.success('Служебная записка отправлена');
      setMemoDialogOpen(false);
      reloadMemos();
    } catch (err) {
      console.error('memo create error:', err);
      toast.error('Не удалось отправить записку');
    } finally {
      setMemoSubmitting(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const fullName = employee?.full_name || profile?.full_name || '—';
  const hireDate = employee?.hire_date ?? null;
  const disableActions = !employeeId || isPreview;

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        {isPreview && (
          <div style={{ ...cardStyle, borderColor: '#b78103', background: '#b781031a' }}>
            <div style={{ fontWeight: 600 }}>Режим предпросмотра (super_admin)</div>
            <div style={labelStyle}>
              Вы видите кабинет рабочего. Действия недоступны в этом режиме.
            </div>
          </div>
        )}

        <section style={cardStyle}>
          <div>
            <div style={labelStyle}>Сотрудник</div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
              {employeeLoading && !employee ? 'Загрузка…' : fullName}
            </div>
          </div>
          <div>
            <div style={labelStyle}>Дата приёма на работу</div>
            <div style={valueStyle}>{formatDate(hireDate)}</div>
          </div>
        </section>

        <section style={cardStyle}>
          <div style={labelStyle}>Срок действия патента</div>
          <div style={{ fontSize: 28, fontWeight: 800, ...patentHighlight }}>
            {formatDate(patentExpiryDate)}
          </div>
          {patentHelper && (
            <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{patentHelper}</div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <button
            type="button"
            style={{ ...primaryButton, opacity: disableActions || uploading ? 0.6 : 1 }}
            onClick={handleOpenFilePicker}
            disabled={disableActions || uploading}
          >
            {uploading ? 'Загрузка…' : 'Загрузить чек от патента'}
          </button>
        </section>

        <section style={cardStyle}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Служебные записки</div>
          <button
            type="button"
            style={{ ...primaryButton, opacity: disableActions ? 0.6 : 1 }}
            onClick={handleOpenMemoDialog}
            disabled={disableActions}
          >
            Подать служебную записку
          </button>

          <div style={{ display: 'grid', gap: 8 }}>
            {memosLoading && <div style={labelStyle}>Загрузка…</div>}
            {!memosLoading && memos.length === 0 && (
              <div style={labelStyle}>Записок пока нет.</div>
            )}
            {!memosLoading && memos.map(memo => (
              <div key={memo.id} style={{ ...cardStyle, padding: 14, gap: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <div style={{ fontWeight: 600 }}>{memo.title}</div>
                  <span style={statusBadgeStyle(memo.status)}>{MEMO_STATUS_LABELS[memo.status]}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{formatDate(memo.created_at)}</div>
                {memo.review_comment && (
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                    Комментарий: {memo.review_comment}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <button type="button" style={dangerLinkButton} onClick={handleLogout}>
          Выйти из системы
        </button>
      </div>

      {memoDialogOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            zIndex: 50,
          }}
          onClick={(e) => { if (e.target === e.currentTarget) setMemoDialogOpen(false); }}
        >
          <form
            onSubmit={handleSubmitMemo}
            style={{
              ...cardStyle,
              width: '100%',
              maxWidth: 480,
              background: 'var(--bg-primary)',
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700 }}>Новая служебная записка</div>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Тема</span>
              <input
                type="text"
                value={memoTitle}
                onChange={(e) => setMemoTitle(e.target.value)}
                maxLength={200}
                required
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                }}
              />
            </label>
            <label style={{ display: 'grid', gap: 6 }}>
              <span style={labelStyle}>Текст</span>
              <textarea
                value={memoBody}
                onChange={(e) => setMemoBody(e.target.value)}
                maxLength={5000}
                rows={6}
                required
                style={{
                  padding: '10px 12px',
                  borderRadius: 10,
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)',
                  resize: 'vertical',
                }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                style={secondaryButton}
                onClick={() => setMemoDialogOpen(false)}
                disabled={memoSubmitting}
              >
                Отмена
              </button>
              <button
                type="submit"
                style={{ ...primaryButton, opacity: memoSubmitting ? 0.6 : 1 }}
                disabled={memoSubmitting}
              >
                {memoSubmitting ? 'Отправка…' : 'Отправить'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
