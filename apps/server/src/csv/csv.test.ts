import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv';

describe('csv', () => {
  it('ida y vuelta con comillas, comas y saltos de línea', () => {
    const rows = [
      { a: '1', b: 'hola, mundo', c: 'dice "hola"' },
      { a: '2', b: 'línea\nnueva', c: '' },
    ];
    expect(parseCsv(toCsv(['a', 'b', 'c'], rows))).toEqual(rows);
  });

  it('detecta ";" , BOM y CRLF, normaliza headers', () => {
    const text = '﻿Date;Ticker\r\n2025-01-01;GGAL\r\n\r\n';
    expect(parseCsv(text)).toEqual([{ date: '2025-01-01', ticker: 'GGAL' }]);
  });

  it('falla con comillas sin cerrar', () => {
    expect(() => parseCsv('a\n"x')).toThrow();
  });
});
