import type { Dec } from './decimal';
import { computeSnapshot, type PortfolioContext } from './portfolio';
import type { ReportingCurrency } from './types';

export interface TimelinePoint {
  date: string;
  value: Dec;
  contributions: Dec;
}

const DAY_MS = 86_400_000;
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);

/** Fechas equiespaciadas entre from y to (ambas incluidas), como máximo maxPoints. */
export function sampleDates(from: string, to: string, maxPoints: number): string[] {
  const start = toDate(from).getTime();
  const end = toDate(to).getTime();
  if (end < start) return [];
  const totalDays = Math.round((end - start) / DAY_MS);
  const step = Math.max(1, Math.ceil(totalDays / Math.max(1, maxPoints - 1)));
  const dates: string[] = [];
  for (let d = 0; d < totalDays; d += step) dates.push(toIso(new Date(start + d * DAY_MS)));
  dates.push(to);
  return dates;
}

/**
 * Evolución del valor del portafolio vs. capital aportado. En cada fecha se reproduce el
 * portafolio con precios y cotizaciones vigentes a ese día (as-of). Con carga manual de precios
 * la curva es escalonada: el valor sólo cambia cuando hay un precio nuevo o una operación.
 */
export function computeTimeline(
  ctx: PortfolioContext,
  opts: { to: string; reporting: ReportingCurrency; maxPoints?: number },
): { points: TimelinePoint[]; warnings: string[] } {
  const from = ctx.firstDate;
  if (!from) return { points: [], warnings: [] };
  const warnings = new Set<string>();
  const points = sampleDates(from, opts.to, opts.maxPoints ?? 180).map((date) => {
    const snap = computeSnapshot(ctx, { asOf: date, reporting: opts.reporting });
    for (const w of snap.warnings) if (w.includes('cotización')) warnings.add(w);
    return { date, value: snap.summary.totalValue, contributions: snap.summary.netContributions };
  });
  return { points, warnings: [...warnings] };
}
