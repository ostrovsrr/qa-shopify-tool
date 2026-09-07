import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { CustomerDashboard } from './pages/CustomerDashboard';
import { ProductDashboard } from './pages/ProductDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/customers" replace />} />
        {/* The open run lives in the URL, so a reload keeps it and a run can be
            linked to. The bare paths are the upload screen. */}
        <Route path="/customers" element={<CustomerDashboard />} />
        <Route path="/customers/:validationId" element={<CustomerDashboard />} />
        <Route path="/products" element={<ProductDashboard />} />
        <Route path="/products/:uploadId" element={<ProductDashboard />} />
        <Route path="*" element={<Navigate to="/customers" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
