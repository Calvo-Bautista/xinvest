# Xinvest

Tracker personal de inversiones en InvertirOnline: registrás operaciones y la app deriva posiciones, P&L
(realizado / no realizado / rentas) y la evolución del portafolio, en ARS o USD MEP con cotización histórica.

**Stack:** TypeScript de punta a punta · React + Vite + TanStack Query + Recharts + Tailwind · Hono (API, cliente
RPC tipado) · Drizzle ORM sobre libSQL/SQLite (archivo local o Turso) · decimal.js · Vitest · Biome.

## Uso local

```bash
npm install
npm run db:seed   # opcional: datos de ejemplo (BORRA la DB local)
npm run dev       # API :8787 + web http://localhost:5173 (migra la DB al arrancar)
```

Sin `.env` funciona igual: usa `data/xinvest.db` y la auth queda deshabilitada. Ver `.env.example`.

| Comando                                                 |                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `npm test`                                              | tests (dominio, API, CSV)                                  |
| `npm run typecheck` / `npm run lint` / `npm run format` | tipos · lint · formato (Biome)                             |
| `npm run db:generate`                                   | nueva migración a partir de `apps/server/src/db/schema.ts` |
| `npm run db:migrate`                                    | aplica migraciones a `DATABASE_URL`                        |
| `npm run build`                                         | build para Vercel (`.vercel/output`)                       |

## Deploy en Vercel

SQLite en archivo no sirve en serverless, así que en Vercel se usa **[Turso](https://turso.tech)**: es libSQL
(SQLite compatible), con el mismo esquema y las mismas migraciones.

1. Creá una DB en Turso y obtené la URL (`libsql://…`) y un token.
2. Importá el repo en Vercel (el `vercel.json` ya define el install y el build). Variables de entorno:
   `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, `APP_PASSWORD`, `SESSION_SECRET` (≥ 32 chars).
3. Deploy. El build aplica las migraciones en Turso y publica la SPA y la API (`/api`) como una función Node.

En producción la auth es obligatoria: hay una contraseña única y la sesión es una cookie JWT httpOnly que dura 30 días.
Para llevar tus datos locales a Turso, exportá los CSV desde **Datos** e importalos en la instancia deployada.

## Arquitectura

```
packages/domain   Lógica pura: posiciones, PPP, P&L, conversión de moneda, timeline. Sin I/O.
apps/server       Hono + Drizzle: esquema, migraciones, repositorios, adapters (PriceProvider/FxRateProvider), CSV.
apps/web          SPA React. Tipos de la API inferidos de apps/server vía hono/client.
```

- **Las posiciones no se guardan:** se reproducen las operaciones en orden (fecha, id) hasta la fecha de corte.
- **Dinero:** `TEXT` decimal en la DB y `decimal.js` (40 dígitos) en el dominio. Nunca floats, ni `SUM()` en SQL.
- **Consistencia:** antes de dar de alta, editar, borrar o importar, se valida la historia completa. Por ejemplo, no
  se puede borrar una compra si deja una venta posterior en descubierto.

## Cómo se calcula

| Concepto                        | Regla                                                                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Precio promedio ponderado (PPP) | Cada compra suma `cantidad × precio / divisor + gastos` al costo. Una venta retira `PPP × cantidad` del costo **sin cambiar el PPP**. Realizado = cobrado neto − costo retirado.                                              |
| Gastos                          | Comisión, derechos e IVA van al costo en las compras y se restan del cobro en las ventas.                                                                                                                                     |
| Bonos / ONs                     | Cotizan cada 100 VN, así que `divisor = 100`. **Renta** = ingreso (suma al P&L). **Amortización** = devolución de capital: baja el costo y no es ganancia, y la cantidad de VN no cambia.                                     |
| CEDEARs                         | Precio y cantidad por CEDEAR. El ratio es informativo y no afecta el P&L.                                                                                                                                                     |
| Caución                         | Compra a precio 1 y venta a `1 + TNA × días / 365`. Lo realizado es el interés.                                                                                                                                               |
| Vista USD                       | Cada flujo se convierte con el **MEP de su fecha** y la valuación con el MEP vigente, así el P&L en USD no cuenta la devolución del peso como ganancia. USD cable = USD MEP 1:1 en esta vista; en la vista ARS se usa el CCL. |
| Cotización faltante             | Se usa la última cotización ≤ fecha. Si no hay ninguna anterior, se usa la primera posterior y se muestra una advertencia.                                                                                                    |
| P&L total                       | `valor total − capital neto aportado` = realizado + no realizado + rentas/div. + dif. de cambio de la caja − gastos de depósitos/retiros (hay un test que lo verifica).                                                       |

## Integración con InvertirOnline

Usa la API oficial (`https://api.iolinversiones.com`, [docs](https://developers.iolinversiones.com)). Para activarla,
definí `IOL_USERNAME` e `IOL_PASSWORD` en `.env` o en Vercel y entrá a la página **IOL**.

- **Auth:** el login es OAuth con contraseña y devuelve un access token de 15 minutos y un refresh token de 30 días. Los
  tokens se guardan **cifrados** (AES-GCM) en la tabla `integrations`, porque en serverless no hay memoria entre requests.
  La contraseña sólo vive en el entorno del server.
- **Operaciones:** `/activities` trae cantidad, precio, neto y gastos desglosados; `/activities/operations` aporta el
  ticker, y las dos se cruzan por `ticket_id`. Las especies en dólares se normalizan al ticker base (AL30D → AL30,
  AAPLD → AAPL, YMCXD → YMCXO), así una compra en pesos y una venta en dólares, que es lo que pasa al hacer dólar MEP,
  afectan la misma posición. Siempre se previsualiza antes de importar:
  - lo ya importado se saltea, por `external_id`;
  - lo cargado a mano se **vincula** en vez de duplicarse;
  - si la historia queda inconsistente, no se importa nada;
  - lo que no se puede mapear con certeza (remuneración de saldos, transferencias de títulos, etc.) se lista para
    cargarlo a mano.
- **Precios:** cierres diarios (`/bars`) de cada instrumento operado, y **dólar MEP/CCL implícito** = AL30 ÷ AL30D (o
  AL30C). Si para el mismo día hay un precio manual, gana el manual. Los FCI no cotizan en BYMA, así que la cuotaparte
  se carga a mano.
- **Cron:** `vercel.json` corre `/api/cron/iol` de lunes a viernes a las 19 h de Argentina. Para activarlo, definí
  `CRON_SECRET`.

## Pendiente

- **Inflación:** tabla `index_values` (CER/IPC) en una nueva migración, más una función de dominio de rendimiento real.
- **IOL:** cauciones tomadoras, opciones y cuentas del exterior (CI Ext.) no se mapean todavía.
