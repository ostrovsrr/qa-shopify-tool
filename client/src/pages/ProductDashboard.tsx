import { useState } from 'react';
import { ActorBadge } from '../components/ActorBadge';
import { NavLink } from 'react-router-dom';
import { fetchUpload, uploadProductCsv } from '../api/productApi';
import { ProductHistory } from '../components/ProductHistory';
import { StoreImportControls } from '../components/StoreImportControls';
import { ProductUploadArea } from '../components/ProductUploadArea';
import { UploadSummary } from '../types';

// upload → review (file + product count, no mapping) → import.
type UploadPhase = 'upload' | 'review' | 'import';

export function ProductDashboard() {
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('upload');
  const [upload, setUpload] = useState<UploadSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'history'>('upload');

  const handleUpload = async (file: File) => {
    setLoading(true);
    setError('');
    try {
      const summary = await uploadProductCsv(file);
      setUpload(summary);
      setUploadPhase('review');
      setHistoryRefresh((n) => n + 1);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed. Is the server running?';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenHistoryRun = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const detail = await fetchUpload(id);
      setUpload({
        uploadId: detail.id,
        fileName: detail.fileName,
        productCount: detail.productCount,
        rowCount: detail.rowCount,
        headers: [],
      });
      setUploadPhase('import');
      setActiveTab('upload');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setError('Failed to load upload.');
    } finally {
      setLoading(false);
    }
  };

  const handleNewUpload = () => {
    setUpload(null);
    setUploadPhase('upload');
    setError('');
  };

  return (
    <div className="dashboard">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">📦</span>
            <span className="logo-text">Shopify QA Tool</span>
          </div>
          <nav className="tab-nav section-nav">
            <NavLink to="/customers" className={({ isActive }) => `tab-btn ${isActive ? 'active' : ''}`}>
              Customers
            </NavLink>
            <NavLink to="/products" className={({ isActive }) => `tab-btn ${isActive ? 'active' : ''}`}>
              Products
            </NavLink>
          </nav>
          {/* The header is space-between across THREE children — that is what keeps
              the Customers|Products switch centered. The badge goes inside this
              right-hand group rather than becoming a fourth child, which would
              collapse the spacing. */}
          <div className="header-right">
            <nav className="tab-nav">
              <button
                className={`tab-btn ${activeTab === 'upload' ? 'active' : ''}`}
                onClick={() => setActiveTab('upload')}
              >
                Import
              </button>
              <button
                className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
                onClick={() => setActiveTab('history')}
              >
                History
              </button>
            </nav>
            <ActorBadge />
          </div>
        </div>
      </header>

      <main className="main-content">
        {activeTab === 'upload' && (
          <>
            {uploadPhase === 'upload' && <ProductUploadArea onUpload={handleUpload} loading={loading} />}

            {error && <div className="error-banner">{error}</div>}

            {uploadPhase === 'review' && upload && (
              <div className="upload-card">
                <div className="file-type-badge">Product CSV</div>
                <h2 className="summary-title">{upload.fileName}</h2>
                <div className="cards-grid">
                  <div className="card card-info">
                    <span className="card-label">Products (by Handle)</span>
                    <span className="card-value">{upload.productCount}</span>
                  </div>
                  <div className="card card-neutral">
                    <span className="card-label">CSV rows</span>
                    <span className="card-value">{upload.rowCount}</span>
                  </div>
                </div>
                <div className="results-toolbar">
                  <button className="btn btn-outline btn-sm" onClick={handleNewUpload}>
                    ← Choose another file
                  </button>
                  <button className="btn btn-primary" onClick={() => setUploadPhase('import')}>
                    Continue to import →
                  </button>
                </div>
              </div>
            )}

            {uploadPhase === 'import' && upload && (
              <>
                <div className="results-toolbar">
                  <button className="btn btn-outline btn-sm" onClick={handleNewUpload}>
                    ← New Upload
                  </button>
                  <span className="muted">
                    {upload.fileName} · <strong>{upload.productCount}</strong> products
                  </span>
                </div>
                <StoreImportControls uploadId={upload.uploadId} productCount={upload.productCount} />
              </>
            )}
          </>
        )}

        {activeTab === 'history' && (
          <ProductHistory onOpen={handleOpenHistoryRun} refreshTrigger={historyRefresh} />
        )}
      </main>
    </div>
  );
}
