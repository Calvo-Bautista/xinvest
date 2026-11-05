import type { ReportingCurrency } from '@xinvest/domain';
import { createContext, type ReactNode, useContext, useState } from 'react';

const KEY = 'xinvest:reporting-currency';
const Ctx = createContext<{
  currency: ReportingCurrency;
  setCurrency: (c: ReportingCurrency) => void;
}>({
  currency: 'ARS',
  setCurrency: () => {},
});

function initial(): ReportingCurrency {
  try {
    return localStorage.getItem(KEY) === 'USD' ? 'USD' : 'ARS';
  } catch {
    return 'ARS';
  }
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, set] = useState<ReportingCurrency>(initial);
  const setCurrency = (c: ReportingCurrency) => {
    set(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* storage no disponible */
    }
  };
  return <Ctx.Provider value={{ currency, setCurrency }}>{children}</Ctx.Provider>;
}

export const useReportingCurrency = () => useContext(Ctx);
