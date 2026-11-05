/**
 * CSV mínimo RFC 4180: comillas, comillas escapadas (""), saltos de línea dentro de campos,
 * CRLF/LF y BOM. Detecta el separador (',' o ';' — Excel en es-AR exporta con ';').
 */
export function parseCsv(text: string): Record<string, string>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delim =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (inQuotes) throw new Error('CSV inválido: comillas sin cerrar');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const [header, ...body] = nonEmpty;
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const needsQuotes = /[",\r\n]/;
const esc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return needsQuotes.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  return `${[columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n')}\n`;
}
