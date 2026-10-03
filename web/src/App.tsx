import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { setUnauthorizedHandler } from './api/client';
import { setSession, useMe } from './api/hooks';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { DashboardPage } from './pages/DashboardPage';
import { ItemDetailPage } from './pages/ItemDetailPage';
import { ItemsPage } from './pages/ItemsPage';
import { LandingPage } from './pages/LandingPage';
import { LoginPage } from './pages/LoginPage';
import { TeamsPage } from './pages/TeamsPage';

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data: me } = useMe();
  const location = useLocation();
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

function AppRoutes() {
  const { data: me, isLoading } = useMe();
  const qc = useQueryClient();

  // Session expired mid-use → drop cached data and show sign-in.
  useEffect(() => setUnauthorizedHandler(() => setSession(qc, null)), [qc]);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Spinner />
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/welcome" element={<LandingPage />} />
      <Route path="/login" element={me ? <Navigate to="/" replace /> : <LoginPage />} />
      {!me && <Route path="/" element={<LandingPage />} />}
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DashboardPage />} />
        <Route path="/items" element={<ItemsPage />} />
        <Route path="/items/:id" element={<ItemDetailPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/teams" element={<TeamsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
