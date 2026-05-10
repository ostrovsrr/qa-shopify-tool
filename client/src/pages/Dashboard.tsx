import { useState } from 'react';
import { fetchValidationResult, getReportDownloadUrl, uploadCustomerCsv } from '../api/validationApi';
import { IssuesTable } from '../components/IssuesTable';
import { SummaryCards } from '../components/SummaryCards';
import { UploadArea } from '../components/UploadArea';
import { ValidationHistory } from '../components/ValidationHistory';
import { ValidationResult } from '../types';

export function Dashboard() {
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
      const data = await uploadCustomerCsv(file);
      setResult(data);
      setHistoryRefresh((n) => n + 1);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : 'Upload failed. Is the server running?';
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenHistoryRun = async (id: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchValidationResult(id);
      setResult(data);
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

  return (
    <div className="dashboard">
      <header className="app-header">
        <div className="header-inner">
          <div className="logo">
            <span className="logo-icon">🛍️</span>
            <span className="logo-text">Shopify CSV QA Tool</span>
          </div>
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
            <UploadArea onUpload={handleUpload} loading={loading} />

            {error && <div className="error-banner">{error}</div>}

            {result && (
              <>
                <SummaryCards result={result} onDownload={handleDownload} />
                <IssuesTable issues={result.issues} />
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
