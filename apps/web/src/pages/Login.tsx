import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBox } from '../components/ui';
import { api, unwrap } from '../lib/api';

export function LoginPage() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const login = useMutation({
    mutationFn: () => unwrap(api.auth.login.$post({ json: { password } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={(e) => {
          e.preventDefault();
          login.mutate();
        }}
      >
        <div>
          <h1 className="text-lg font-semibold">Xinvest</h1>
          <p className="text-sm text-zinc-500">Ingresá la contraseña de la app.</p>
        </div>
        <input
          type="password"
          className="input"
          autoComplete="current-password"
          // biome-ignore lint/a11y/noAutofocus: única acción de la pantalla
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Contraseña"
        />
        <ErrorBox error={login.error} />
        <button
          type="submit"
          className="btn-primary w-full"
          disabled={!password || login.isPending}
        >
          {login.isPending ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </div>
  );
}
