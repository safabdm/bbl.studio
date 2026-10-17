import { StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Home from './app/page';
import './app/globals.css';

const AdminLogin = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.AdminLogin })));
const ClientPortal = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.ClientPortal })));
const RequireAdmin = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.RequireAdmin })));
const CrmDashboard = lazy(() => import('./app/crm-dashboard').then((module) => ({ default: module.CrmDashboard })));
const UnsubscribePage = lazy(() => import('./app/unsubscribe'));

function PortalFallback() {
  return <div className="portal-boot" aria-hidden="true" />;
}

function PortalGate({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<PortalFallback />}>
      <RequireAdmin>{children}</RequireAdmin>
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/unsubscribe" element={<Suspense fallback={<PortalFallback />}><UnsubscribePage /></Suspense>} />
        <Route path="/admin/login" element={<Suspense fallback={<PortalFallback />}><AdminLogin /></Suspense>} />
        {/* Admin preview stays outside CrmShell — it mirrors the public client view. */}
        <Route path="/admin/projects/:projectId/preview" element={<PortalGate><ClientPortal preview /></PortalGate>} />
        {/* CRM + Client Portal share CrmShell (sidebar). Nested under /admin/*. */}
        <Route path="/admin/*" element={<PortalGate><CrmDashboard /></PortalGate>} />
        <Route path="/client/:token" element={<Suspense fallback={<PortalFallback />}><ClientPortal /></Suspense>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
