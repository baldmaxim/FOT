import { type FC, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Download, FileText } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { getMyDocumentsQueryKey, useMyDocuments } from '../../hooks/usePortalData';
import {
  documentService,
  CATEGORY_LABELS,
  type IDocument,
  type DocumentCategory,
} from '../../services/documentService';
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
              <div className="docs-card-icon"><FileText size={20} /></div>
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
    </div>
  );
};
