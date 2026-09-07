import { useEffect, useState } from 'react';
import { ActorBadge } from '../components/ActorBadge';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  fetchValidationResult,
  getReportDownloadUrl,
  previewCsv,
  validateWithMapping,
} from '../api/validationApi';
import { ColumnMappingScreen } from '../components/ColumnMappingScreen';
import { ImportPanel } from '../components/ImportPanel';
import { IssuesTable } from '../components/IssuesTable';
import { SummaryCards } from '../components/SummaryCards';
import { UploadArea } from '../components/UploadArea';
import { ValidationHistory } from '../components/ValidationHistory';
import { ColumnMapping, CsvPreview, ValidationResult } from '../types';

type UploadPhase = 'upload' | 'mapping' | 'results';

export function CustomerDashboard() {
  // The open run is the URL, not component state: /customers/:validationId. A
  // reload used to drop you back on the upload screen, and a run could not be
  // linked to. The mapping step stays ephemeral — its preview is a server-side
  // temp file that validate consumes, so there is nothing durable to link to.
  const { validationId } = useParams<{ validationId: string }>();
  const navigate = useNavigate();
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('upload');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'history'>('upload');

  // URL → state. Runs on first paint and on every change of the route param, so
  // a pasted link, a reload, and back/forward all land on the same run.
  useEffect(() => {
    if (!validationId) {
      setResult(null);
      setError('');
      setUploadPhase((phase) => (phase === 'results' ? 'upload' : phase));
      return;
    }
    // Already showing it (we just validated, or navigated within the app).
    if (result?.validationId === validationId) {
      setUploadPhase('results');
      return;
    }

    let active = true;
    setLoading(true);
    setError('');
    fetchValidationResult(validationId)
      .then((data) => {
        if (!active) return;
        setResult(data);
        setPreview(null);
        setUploadPhase('results');
        setActiveTab('upload');
      })
      .catch(() => active && setError('Failed to load validation run.'))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validationId]);

  const handleUpload = async (file: File) => {
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const data = await previewCsv(file);
      setPreview(data);
      setUploadPhase('mapping');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Upload failed. Is the server running?';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleValidate = async (
    mapping: ColumnMapping,
    heliosMigratedTag: boolean,
    moveDuplicatesToNotes: boolean,
    mergeMatchingDuplicates: boolean,
  ) => {
    if (!preview) return;
    setLoading(true);
    setError('');
    try {
      const data = await validateWithMapping(
        preview.uploadId,
        mapping,
        heliosMigratedTag,
        moveDuplicatesToNotes,
        mergeMatchingDuplicates,
      );
      setResult(data);
      setUploadPhase('results');
      setHistoryRefresh((n) => n + 1);
      navigate(`/customers/${data.validationId}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Validation failed.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    setPreview(null);
    setUploadPhase('upload');
    setError('');
  };

  // Switch tabs here rather than in the route effect: reopening the run that is
  // already loaded does not change the param, so the effect would not re-run and
  // you would be left sitting on the History tab.
  const handleOpenHistoryRun = (id: string) => {
    setActiveTab('upload');
    setError('');
    navigate(`/customers/${id}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDownload = () => {
    if (!result) return;
    window.open(getReportDownloadUrl(result.validationId), '_blank');
  };

  const handleNewUpload = () => {
    setResult(null);
    setPreview(null);
    setUploadPhase('upload');
    setError('');
    if (validationId) navigate('/customers');
  };

  return (
    <div className="dashboard">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">🛍️</span>
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
                Validate
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
            {uploadPhase === 'upload' && (
              <UploadArea onUpload={handleUpload} loading={loading} />
            )}

            {uploadPhase === 'mapping' && preview && (
              <ColumnMappingScreen
                preview={preview}
                onValidate={handleValidate}
                onBack={handleBack}
                loading={loading}
              />
            )}

            {error && <div className="error-banner">{error}</div>}

            {uploadPhase === 'results' && result && (
              <>
                <div className="results-toolbar">
                  <button className="btn btn-outline btn-sm" onClick={handleNewUpload}>
                    ← New Upload
                  </button>
                </div>
                <SummaryCards result={result} onDownload={handleDownload} />
                <IssuesTable issues={result.issues} />
                <ImportPanel result={result} />
              </>
            )}
          </>
        )}

        {activeTab === 'history' && (
          <ValidationHistory onOpen={handleOpenHistoryRun} refreshTrigger={historyRefresh} />
        )}
      </main>
    </div>
  );
}
