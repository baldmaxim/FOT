import { type FC, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Download, FileText, FileSpreadsheet } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getMyDocumentsQueryKey, useMyDocuments } from '../../hooks/usePortalData';
import {
  documentService,
  CATEGORY_LABELS,
  type IDocument,
  type DocumentCategory,
} from '../../services/documentService';
import { DOCUMENT_TEMPLATES } from './documentTemplates';
import './DocumentsPage.css';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DocumentCategory[];
const EMPTY_DOCUMENTS: IDocument[] = [];

export const DocumentsPage: FC = () => {
  const { profile } = useAuth();
  const employeeId = profile?.employee_id || null;
  const fileRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const [uploading, setUploading] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<DocumentCategory>('other');
  const { data, isLoading } = useMyDocuments();
  const documents = data ?? EMPTY_DOCUMENTS;

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !employeeId) return;

    setUploading(true);
    try {
      await documentService.uploadFile(file, employeeId, uploadCategory);
      await queryClient.invalidateQueries({ queryKey: getMyDocumentsQueryKey() });
    } catch (err) {
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDownload = async (doc: IDocument) => {
    try {
      const { download_url, file_name } = await documentService.getDownloadUrl(doc.id);
      const a = document.createElement('a');
      a.href = download_url;
      a.download = file_name;
      a.target = '_blank';
      a.click();
    } catch (err) {
      console.error('Download error:', err);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });

  return (
    <div className="docs-page">
      <section className="docs-section" aria-labelledby="docs-templates-title">
        <h2 className="docs-section-title" id="docs-templates-title">Бланки заявлений</h2>
        <div className="docs-section-hint">Скачайте, распечатайте и заполните</div>
        <div className="docs-templates">
          {DOCUMENT_TEMPLATES.map(tpl => {
            const isSheet = tpl.url.endsWith('.xlsx');
            return (
              <a key={tpl.url} className="docs-tpl-card" href={tpl.url} download={tpl.fileName}>
                <span className="docs-card-icon" aria-hidden="true">
                  {isSheet ? <FileSpreadsheet size={20} /> : <FileText size={20} />}
                </span>
                <span className="docs-tpl-info">
                  <span className="docs-tpl-name">{tpl.title}</span>
                  <span className="docs-tpl-ext">{isSheet ? 'XLSX' : 'DOCX'}</span>
                </span>
                <Download size={16} className="docs-tpl-download" aria-hidden="true" />
              </a>
            );
          })}
        </div>
      </section>

      <section className="docs-section docs-section-divided" aria-labelledby="docs-my-files-title">
        <h2 className="docs-section-title" id="docs-my-files-title">Мои файлы</h2>
        <div className="docs-upload-row">
          <select className="docs-category-select" value={uploadCategory} onChange={e => setUploadCategory(e.target.value as DocumentCategory)}>
            {CATEGORIES.map(c => (
              <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={uploading}>
            <Upload size={16} /> {uploading ? 'Загрузка...' : 'Загрузить'}
          </button>
          <input ref={fileRef} type="file" hidden onChange={handleUpload} />
        </div>

        {isLoading ? (
          <div className="docs-loading">Загрузка...</div>
        ) : documents.length === 0 ? (
          <div className="docs-empty">Нет документов</div>
        ) : (
          <div className="docs-list">
            {documents.map(doc => (
              <div key={doc.id} className="docs-card">
                <div className="docs-card-icon" aria-hidden="true"><FileText size={20} /></div>
                <div className="docs-card-info">
                  <div className="docs-card-name">{doc.file_name}</div>
                  <div className="docs-card-meta">
                    {CATEGORY_LABELS[doc.category]} &middot; {formatSize(doc.file_size)} &middot; {formatDate(doc.created_at)}
                  </div>
                </div>
                <button className="docs-card-btn" onClick={() => handleDownload(doc)} title="Скачать">
                  <Download size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};
