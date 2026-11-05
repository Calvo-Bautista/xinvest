import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, NavLink, Route, Routes } from 'react-router';
import { Segmented } from './components/ui';
import { api, UNAUTHORIZED_EVENT, unwrap } from './lib/api';
import { CurrencyProvider, useReportingCurrency } from './lib/currency';
import { DashboardPage } from './pages/Dashboard';
import { DataPage } from './pages/Data';
import { InstrumentsPage } from './pages/Instruments';
import { IolPage } from './pages/Iol';
import { LoginPage } from './pages/Login';
import { OperationsPage } from './pages/Operations';
import { PositionsPage } from './pages/Positions';
import { PricesPage } from './pages/Prices';

const NAV = [
  { to: '/', label: 'Resumen' },
  { to: '/posiciones', label: 'Posiciones' },
  { to: '/operaciones', label: 'Operaciones' },
  { to: '/precios', label: 'Precios y dólar' },
  { to: '/instrumentos', label: 'Instrumentos' },
  { to: '/iol', label: 'IOL' },
  { to: '/datos', label: 'Datos' },
];

export function App() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => unwrap(api.auth.me.$get()),
    staleTime: Number.POSITIVE_INFINITY,
  });

  useEffect(() => {
    const onUnauthorized = () =>
      qc.setQueryData(['me'], { authenticated: false, authEnabled: true });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [qc]);

  if (me.isPending) return null;
  if (me.data && !me.data.authenticated) return <LoginPage />;

  return (
    <CurrencyProvider>
      <Shell authEnabled={me.data?.authEnabled ?? false} />
    </CurrencyProvider>
  );
}

function Shell({ authEnabled }: { authEnabled: boolean }) {
  const { currency, setCurrency } = useReportingCurrency();
  const qc = useQueryClient();

  const logout = async () => {
    await api.auth.logout.$post();
    qc.clear();
    qc.setQueryData(['me'], { authenticated: false, authEnabled: true });
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <NavLink to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="grid size-7 place-items-center rounded-md bg-brand-700 text-xs text-white">
              X
            </span>
            Xinvest
          </NavLink>
          <nav className="-mx-1 flex flex-1 gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm ${
                    isActive
                      ? 'bg-zinc-100 font-medium text-zinc-900 dark:bg-zinc-800 dark:text-white'
                      : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white'
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Segmented
              value={currency}
              onChange={setCurrency}
              options={[
                { value: 'ARS', label: 'ARS' },
                { value: 'USD', label: 'USD MEP' },
              ]}
            />
            {authEnabled && (
              <button type="button" className="btn-ghost" onClick={logout}>
                Salir
              </button>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/posiciones" element={<PositionsPage />} />
          <Route path="/operaciones" element={<OperationsPage />} />
          <Route path="/precios" element={<PricesPage />} />
          <Route path="/instrumentos" element={<InstrumentsPage />} />
          <Route path="/iol" element={<IolPage />} />
          <Route path="/datos" element={<DataPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
