import { useEffect, useMemo, useRef, useState, type CSSProperties, type FC } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { employeeService } from '../../services/employeeService';
import { patentReceiptService, type IMyPatentReceipt, type RecognitionStatus } from '../../services/patentReceiptService';
import type { Employee } from '../../types/employee';
import { ApiError } from '../../api/client';
import { formatFioShort } from '../../utils/formatFio';

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

const logoutButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  width: '100%',
  padding: '14px 20px',
  borderRadius: 14,
  border: '1px solid #b23a48',
  background: 'transparent',
  color: '#b23a48',
  fontSize: 16,
  fontWeight: 600,
  cursor: 'pointer',
};

interface IRecognitionBadge {
  label: string;
  color: string;
}

const recognitionBadge = (status: RecognitionStatus | null | undefined): IRecognitionBadge => {
  switch (status) {
    case 'pending':
      return { label: 'В очереди', color: '#7a7a7a' };
    case 'processing':
      return { label: 'Распознаётся…', color: '#b78103' };
    case 'done':
      return { label: 'Распознан', color: '#1e7e34' };
    case 'needs_review':
      return { label: 'Требует проверки', color: '#b78103' };
    case 'failed':
      return { label: 'Ошибка распознавания', color: '#b23a48' };
    default:
      return { label: '—', color: 'var(--text-secondary)' };
  }
};

const recognitionBadgeStyle = (color: string): CSSProperties => ({
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--bg-primary)',
  color,
  border: `1px solid ${color}33`,
});

const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
};

const amountFormatter = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const formatAmount = (raw: string | null): string => {
  if (raw === null || raw === undefined || raw === '') return '—';
  const num = Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  return `${amountFormatter.format(num)} ₽`;
};

const daysUntil = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / (24 * 60 * 60_000));
};

const PATENT_WARN_DAYS = 30;

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  zIndex: 1000,
};

const overlayCardStyle: CSSProperties = {
  width: '100%',
  maxWidth: 360,
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-primary)',
  borderRadius: 16,
  padding: 24,
  display: 'grid',
  gap: 14,
  textAlign: 'center',
};

const spinnerStyle: CSSProperties = {
  width: 44,
  height: 44,
  margin: '0 auto',
  border: '4px solid var(--border-primary)',
  borderTopColor: 'var(--accent-primary, #4b6cff)',
  borderRadius: '50%',
  animation: 'workerUploadSpin 0.8s linear infinite',
};

interface IUploadModalProps {
  status: { state: 'uploading' | 'uploaded' | 'error'; message?: string };
  onClose: () => void;
}

const UploadReceiptStatusModal: FC<IUploadModalProps> = ({ status, onClose }) => {
  const isUploading = status.state === 'uploading';
  const title =
    status.state === 'uploading' ? 'Загружаем чек на сервер…' :
    status.state === 'uploaded' ? 'Чек загружен' :
    'Не удалось загрузить';
  const subtitle =
    status.state === 'uploading' ? 'Пожалуйста, не закрывайте страницу.' :
    status.state === 'uploaded' ? 'Идёт проверка. Чек появится в списке после распознавания.' :
    (status.message || 'Попробуйте ещё раз.');
  const iconColor =
    status.state === 'uploaded' ? '#1e7e34' :
    status.state === 'error' ? '#b23a48' :
    'var(--accent-primary, #4b6cff)';

  return (
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-live="polite">
      <style>{`@keyframes workerUploadSpin { to { transform: rotate(360deg); } }`}</style>
      <div style={overlayCardStyle}>
        {status.state === 'uploading' ? (
          <div style={spinnerStyle} />
        ) : (
          <div
            style={{
              width: 56,
              height: 56,
              margin: '0 auto',
              borderRadius: '50%',
              background: `${iconColor}1f`,
              color: iconColor,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 30,
              fontWeight: 700,
            }}
          >
            {status.state === 'uploaded' ? '✓' : '!'}
          </div>
        )}
        <div style={{ fontSize: 18, fontWeight: 700 }}>{title}</div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{subtitle}</div>
        {!isUploading && (
          <button
            type="button"
            onClick={onClose}
            style={{
              marginTop: 4,
              padding: '12px 20px',
              borderRadius: 12,
              border: 'none',
              background: 'var(--accent-primary, #4b6cff)',
              color: '#fff',
              fontSize: 15,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
};

export const ObjectWorkerDashboardPage: FC = () => {
  const { profile, logout, isAdmin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const isPreview = isAdmin && searchParams.get('preview') === 'worker';
  const employeeId = profile?.employee_id ?? null;

  const [employee, setEmployee] = useState<Employee | null>(null);
  const [employeeLoading, setEmployeeLoading] = useState<boolean>(true);
  const [receipts, setReceipts] = useState<IMyPatentReceipt[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState<boolean>(true);
  const [uploadStatus, setUploadStatus] = useState<{ state: 'uploading' | 'uploaded' | 'error'; message?: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (uploadStatus?.state !== 'uploaded') return;
    const timer = window.setTimeout(() => setUploadStatus(null), 2500);
    return () => window.clearTimeout(timer);
  }, [uploadStatus]);

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

  const reloadReceipts = () => {
    if (!employeeId) {
      setReceipts([]);
      setReceiptsLoading(false);
      return;
    }
    setReceiptsLoading(true);
    patentReceiptService.listMy()
      .then(data => setReceipts(data || []))
      .catch(err => {
        console.error('receipts load error:', err);
        toast.error('Не удалось загрузить чеки');
      })
      .finally(() => setReceiptsLoading(false));
  };

  useEffect(() => {
    reloadReceipts();
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

  const uploading = uploadStatus?.state === 'uploading';

  const handleOpenFilePicker = () => {
    if (!employeeId || uploading) return;
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !employeeId) return;

    setUploadStatus({ state: 'uploading' });
    try {
      await patentReceiptService.uploadMy(file);
      setUploadStatus({ state: 'uploaded' });
      reloadReceipts();
    } catch (err) {
      console.error('patent check upload error:', err);
      const detail = err instanceof ApiError ? err.message : null;
      setUploadStatus({ state: 'error', message: detail || 'Не удалось загрузить чек' });
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const fullName = employee?.full_name || profile?.full_name || '—';
  const hireDate = employee?.hire_date ?? null;
  const departmentName = employee?.department ?? null;
  const siteDisplay = useMemo(() => {
    const managerShort = formatFioShort(employee?.site_manager_full_name);
    if (managerShort) return `Уч. ${managerShort}`;
    if (employee?.site_name) return `Уч. ${employee.site_name}`;
    return null;
  }, [employee?.site_manager_full_name, employee?.site_name]);
  const disableActions = !employeeId;
  const noEmployeeBinding = !employeeId;

  return (
    <div style={pageStyle}>
      <div style={containerStyle}>
        {isPreview && (
          <div style={{ ...cardStyle, borderColor: '#b78103', background: '#b781031a' }}>
            <div style={{ fontWeight: 600 }}>Режим предпросмотра (super_admin)</div>
            <div style={labelStyle}>
              Вы видите кабинет рабочего. Все действия выполняются от имени вашего учёта super_admin и привязанного employee_id.
            </div>
          </div>
        )}

        {noEmployeeBinding && (
          <div style={{ ...cardStyle, borderColor: '#b23a48', background: '#b23a481a' }}>
            <div style={{ fontWeight: 600 }}>Аккаунт не привязан к сотруднику</div>
            <div style={labelStyle}>
              Обратитесь к администратору — загрузка чека от патента пока недоступна.
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
            <div style={labelStyle}>Отдел</div>
            <div style={valueStyle}>{departmentName || '—'}</div>
          </div>
          <div>
            <div style={labelStyle}>Участок</div>
            <div style={valueStyle}>{siteDisplay || '—'}</div>
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
          <div style={{ fontSize: 16, fontWeight: 700 }}>Мои чеки от патента</div>

          <div style={{ display: 'grid', gap: 8 }}>
            {receiptsLoading && <div style={labelStyle}>Загрузка…</div>}
            {!receiptsLoading && receipts.length === 0 && (
              <div style={labelStyle}>Пока нет загруженных чеков.</div>
            )}
            {!receiptsLoading && receipts.map(receipt => {
              const badge = recognitionBadge(receipt.documents?.recognition_status ?? null);
              const dateLabel = receipt.payment_date
                ? `Дата платежа: ${formatDate(receipt.payment_date)}`
                : `Загружено: ${formatDate(receipt.created_at)}`;
              return (
                <div key={receipt.id} style={{ ...cardStyle, padding: 14, gap: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ fontWeight: 600 }}>{formatAmount(receipt.payment_amount)}</div>
                    <span style={recognitionBadgeStyle(badge.color)}>{badge.label}</span>
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{dateLabel}</div>
                  {receipt.documents?.file_name && (
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                      {receipt.documents.file_name}
                    </div>
                  )}
                  {receipt.download_url && (
                    <a
                      href={receipt.download_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 14, fontWeight: 600, color: 'var(--accent-primary, #4b6cff)' }}
                    >
                      Открыть оригинал
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section style={cardStyle}>
          <button
            type="button"
            style={logoutButtonStyle}
            onClick={handleLogout}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#b23a4811'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Выйти из системы
          </button>
        </section>
      </div>
      {uploadStatus && (
        <UploadReceiptStatusModal
          status={uploadStatus}
          onClose={() => setUploadStatus(null)}
        />
      )}
    </div>
  );
};
