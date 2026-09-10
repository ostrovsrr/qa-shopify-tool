import { useEffect, useState } from 'react';
import { ActorBadge } from '../components/ActorBadge';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { fetchUpload, uploadProductCsv } from '../api/productApi';
import { ProductHistory } from '../components/ProductHistory';
import { StoreImportControls } from '../components/StoreImportControls';
import { ProductUploadArea } from '../components/ProductUploadArea';
import { IssuesTable } from '../components/IssuesTable';
import { UploadSummary } from '../types';

// upload → review (file, product count, pre-check; no mapping) → import.
type UploadPhase = 'upload' | 'review' | 'import';

// The pre-check never blocks an import; it says which products Shopify will reject.
function PrecheckNotice({ upload }: { upload: UploadSummary }) {
  if (upload.precheckErrors === null) {
    return <p className="muted">Uploaded before the product pre-check existed, so it was not checked.</p>;
  }
  if (upload.precheckErrors === 0) return null;
  const products = new Set(upload.issues.map((i) => i.handle)).size;
  return (
    <div className="warning-banner">
      The pre-check found <strong>{upload.precheckErrors}</strong> error{upload.precheckErrors === 1 ? '' : 's'} in{' '}
      <strong>{products}</strong> product{products === 1 ? '' : 's'}. Shopify will reject{' '}
      {products === 1 ? 'that product' : 'those products'}. You can still import to confirm.
    </div>
  );
}

export function ProductDashboard() {
  // The open upload is the URL, not component state: /products/:uploadId. A
  // reload used to drop you back on the upload screen, and an upload could not
  // be linked to. The review step stays ephemeral — it is a confirmation of the
  // file you just picked, and the URL appears when you commit to importing.
  const { uploadId } = useParams<{ uploadId: string }>();
  const navigate = useNavigate();
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('upload');
  const [upload, setUpload] = useState<UploadSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'history'>('upload');

  // URL → state. Runs on first paint and on every change of the route param, so
  // a pasted link, a reload, and back/forward all land on the same upload.
  useEffect(() => {
    if (!uploadId) {
      setUpload(null);
      setError('');
      setUploadPhase((phase) => (phase === 'import' ? 'upload' : phase));
      return;
    }
    // Already showing it (we just clicked through from review).
    if (upload?.uploadId === uploadId) {
      setUploadPhase('import');
      return;
    }

    let active = true;
    setLoading(true);
    setError('');
    fetchUpload(uploadId)
      .then((detail) => {
        if (!active) return;
        setUpload({
          uploadId: detail.id,
          fileName: detail.fileName,
          productCount: detail.productCount,
          rowCount: detail.rowCount,
          headers: [],
          precheckErrors: detail.precheckErrors,
          issues: detail.issues,
        });
        setUploadPhase('import');
        setActiveTab('upload');
      })
      .catch(() => active && setError('Failed to load upload.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadId]);

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

  // Switch tabs here rather than in the route effect: reopening the upload that
  // is already loaded does not change the param, so the effect would not re-run
  // and you would be left sitting on the History tab.
  const handleOpenHistoryRun = (id: string) => {
    setActiveTab('upload');
    setError('');
    navigate(`/products/${id}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleNewUpload = () => {
    setUpload(null);
    setUploadPhase('upload');
    setError('');
    if (uploadId) navigate('/products');
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
                  <div className={`card ${upload.precheckErrors ? 'card-error' : 'card-neutral'}`}>
                    <span className="card-label">Pre-check errors</span>
                    <span className="card-value">{upload.precheckErrors ?? '—'}</span>
                  </div>
                </div>
                <PrecheckNotice upload={upload} />
                {upload.issues.length > 0 && <IssuesTable issues={upload.issues} />}
                <div className="results-toolbar">
                  <button className="btn btn-outline btn-sm" onClick={handleNewUpload}>
                    ← Choose another file
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => navigate(`/products/${upload.uploadId}`)}
                  >
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
                <PrecheckNotice upload={upload} />
                {upload.issues.length > 0 && <IssuesTable issues={upload.issues} />}
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
