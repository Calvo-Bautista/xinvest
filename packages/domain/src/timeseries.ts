/**
 * Serie temporal ordenada con búsqueda "as-of": el último valor con fecha <= la pedida.
 * Las fechas son ISO YYYY-MM-DD, así que la comparación lexicográfica es cronológica.
 */
export class AsOfSeries<T> {
  private readonly points: { date: string; value: T }[];

  constructor(points: Iterable<{ date: string; value: T }>) {
    this.points = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  get isEmpty(): boolean {
    return this.points.length === 0;
  }

  /** Último punto con fecha <= date. */
  at(date: string): { date: string; value: T } | undefined {
    let lo = 0;
    let hi = this.points.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // biome-ignore lint/style/noNonNullAssertion: índice dentro de rango
      if (this.points[mid]!.date <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? this.points[found] : undefined;
  }

  /** Primer punto de la serie (para fallback cuando no hay dato anterior). */
  first(): { date: string; value: T } | undefined {
    return this.points[0];
  }
}
