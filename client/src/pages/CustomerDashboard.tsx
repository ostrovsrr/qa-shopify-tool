import { useState } from 'react';
import { NavLink } from 'react-router-dom';
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
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>('upload');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'history'>('upload');

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

  const handleOpenHistoryRun = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchValidationResult(id);
      setResult(data);
      setPreview(null);
      setUploadPhase('results');
      setActiveTab('upload');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setError('Failed to load validation run.');
    } finally {
      setLoading(false);
    }
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
