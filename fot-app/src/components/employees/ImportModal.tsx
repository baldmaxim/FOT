import { useRef, type FC } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Coins, History, Upload, Mail } from 'lucide-react';

interface IImportModalProps {
  onClose: () => void;
  onEnrichFile: (file: File) => void;
  onSalaryFile: (file: File) => void;
  onSalaryHistoryFile: (file: File) => void;
  onContactsFile: (file: File) => void;
}

interface ImportOption {
  id: string;
  title: string;
  description: string;
  columns: string;
  icon: typeof FileText;
  onFile: (file: File) => void;
}

export const ImportModal: FC<IImportModalProps> = ({ onClose, onEnrichFile, onSalaryFile, onSalaryHistoryFile, onContactsFile }) => {
  const enrichRef = useRef<HTMLInputElement>(null);
  const salaryRef = useRef<HTMLInputElement>(null);
  const salaryHistoryRef = useRef<HTMLInputElement>(null);
  const contactsRef = useRef<HTMLInputElement>(null);

  const options: ImportOption[] = [
    {
      id: 'enrich',
      title: 'Импорт документов и статусов',
      description: 'Обогащение данных сотрудников: гражданство, статус, разрешения, регистрация, объект работы',
      columns: 'Таб.номер, ФИО, гражданство, дата приёма, статус, разрешение, рег. 1 кат, рег. 4 кат, дата документов, должность, объект',
      icon: FileText,
      onFile: onEnrichFile,
    },
    {
      id: 'salary',
      title: 'Импорт окладов и ставок',
      description: 'Загрузка окладов (по программе и по договору) и коэффициентов ставок',
      columns: 'ФИО, дата приёма, отдел, должность, оклад (программа), ставка, оклад (договор)',
      icon: Coins,
      onFile: onSalaryFile,
    },
    {
      id: 'salary-history',
      title: 'Импорт истории окладов',
      description: 'История изменений окладов по сотрудникам: от оклада при приёме до текущего. Матчинг по фамилии и инициалам',
      columns: 'Отдел → Должность → ФИО (Фамилия И.О.) → записи окладов (Текущий оклад / Изменение оклада / Оклад при приёме)',
      icon: History,
      onFile: onSalaryHistoryFile,
    },
    {
      id: 'contacts',
      title: 'Импорт email сотрудников',
      description: 'Массовая загрузка email-адресов по списку ФИО. При конфликте — ручное решение',
      columns: 'ФИО, Email, Отдел (необязательно)',
      icon: Mail,
      onFile: onContactsFile,
    },
  ];

  const refs: Record<string, React.RefObject<HTMLInputElement | null>> = {
    enrich: enrichRef,
    salary: salaryRef,
    'salary-history': salaryHistoryRef,
    contacts: contactsRef,
  };

  const handleFileChange = (optionId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const option = options.find(o => o.id === optionId);
    option?.onFile(file);
  };

  return createPortal(
    <div className="ep-modal-overlay" onClick={onClose}>
      <div className="ep-modal import-modal" onClick={e => e.stopPropagation()}>
        <div className="ep-modal-header">
          <h3>Импорт данных</h3>
          <button className="ep-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="import-options">
          {options.map(opt => {
            const Icon = opt.icon;
            return (
              <button
                key={opt.id}
                className="import-option-card"
                onClick={() => refs[opt.id]?.current?.click()}
              >
                <div className="import-option-icon">
                  <Icon size={24} />
                </div>
                <div className="import-option-content">
                  <div className="import-option-title">{opt.title}</div>
                  <div className="import-option-desc">{opt.description}</div>
                  <div className="import-option-cols">
                    <span className="import-option-cols-label">Формат:</span> {opt.columns}
                  </div>
                </div>
                <div className="import-option-action">
                  <Upload size={16} />
                </div>
                <input
                  ref={refs[opt.id]}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={e => handleFileChange(opt.id, e)}
                  hidden
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
};
