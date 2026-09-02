import { StrictMode, Suspense, lazy, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Home from './app/page';
import './app/globals.css';

const AdminLogin = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.AdminLogin })));
const AdminHome = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.AdminHome })));
const AdminProject = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.AdminProject })));
const AdminPricing = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.AdminPricing })));
const ClientPortal = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.ClientPortal })));
const RequireAdmin = lazy(() => import('./app/portal-screens').then((module) => ({ default: module.RequireAdmin })));

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
        <Route path="/admin/login" element={<Suspense fallback={<PortalFallback />}><AdminLogin /></Suspense>} />
        <Route path="/admin" element={<PortalGate><AdminHome /></PortalGate>} />
        <Route path="/admin/projects/:projectId" element={<PortalGate><AdminProject /></PortalGate>} />
        <Route path="/admin/projects/:projectId/pricing" element={<PortalGate><AdminPricing /></PortalGate>} />
        <Route path="/admin/projects/:projectId/preview" element={<PortalGate><ClientPortal preview /></PortalGate>} />
        <Route path="/client/:token" element={<Suspense fallback={<PortalFallback />}><ClientPortal /></Suspense>} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
