import React, { useCallback, useRef, useState } from 'react';

interface Props {
  onUpload: (file: File) => void;
  loading: boolean;
}

export function UploadArea({ onUpload, loading }: Props) {
  const [dragging, setDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      alert('Please select a CSV file.');
      return;
    }
    setSelectedFile(file);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile],
  );

  const handleSubmit = () => {
    if (selectedFile) onUpload(selectedFile);
  };

  return (
    <div className="upload-card">
      <div className="file-type-badge">Customer CSV</div>

      <div
        className={`drop-zone ${dragging ? 'dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        aria-label="Upload CSV file"
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {selectedFile ? (
          <p className="selected-file">{selectedFile.name}</p>
        ) : (
          <>
            <p>Drag & drop a Shopify Customer CSV here</p>
            <p className="drop-hint">or click to browse</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".csv"
        onChange={handleChange}
        style={{ display: 'none' }}
      />

      <button
        className="btn btn-primary"
        onClick={handleSubmit}
        disabled={!selectedFile || loading}
      >
        {loading ? (
          <>
            <span className="spinner" /> Uploading&hellip;
          </>
        ) : (
          'Upload & Map Columns'
        )}
      </button>
    </div>
  );
}
