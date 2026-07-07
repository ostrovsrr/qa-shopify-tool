import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { CustomerDashboard } from './pages/CustomerDashboard';
import { ProductDashboard } from './pages/ProductDashboard';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/customers" replace />} />
        <Route path="/customers" element={<CustomerDashboard />} />
        <Route path="/products" element={<ProductDashboard />} />
        <Route path="*" element={<Navigate to="/customers" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
