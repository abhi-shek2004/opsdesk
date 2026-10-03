import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { setSession } from '../api/hooks';
import type { Me } from '../api/types';
import { Button } from '../components/ui';
import { LandingShell } from './LandingPage';

const DEMO = [
  { email: 'priya@opsdesk.dev', who: 'Priya — Payments lead (approves refunds)' },
  { email: 'rahul@opsdesk.dev', who: 'Rahul — Payments & Ops member' },
  { email: 'sam@opsdesk.dev', who: 'Sam — Engineering lead' },
  { email: 'alex@opsdesk.dev', who: 'Alex — Engineering & Payments member' },
  { email: 'vera@opsdesk.dev', who: 'Vera — read-only auditor (viewer)' },
  { email: 'admin@opsdesk.dev', who: 'Ada — administrator' },
];

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const login = useMutation({
    mutationFn: (creds: { email: string; password: string }) => api<Me>('/auth/login', { method: 'POST', body: creds }),
    onSuccess: (me) => {
      setSession(qc, me);
      navigate(from, { replace: true });
    },
  });

  return (
    <LandingShell dim>
      <div className="auth">
        <h1 className="auth-title anim">Welcome back</h1>
        <p className="auth-sub anim" style={{ ['--d' as string]: '0.1s' }}>
          Sign in to pick up where your team left off.
        </p>
        <div className="anim w-full max-w-md px-1" style={{ ['--d' as string]: '0.18s' }}>
          <form
            className="space-y-4 rounded-3xl bg-white p-6 text-slate-900 shadow-[0_20px_60px_rgba(0,0,0,0.45)]"
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ email, password });
            }}
          >
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div>
              <label className="label" htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {login.error && (
              <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
                {login.error.message}
              </p>
            )}
            <Button variant="primary" type="submit" className="w-full !rounded-full !bg-black hover:!bg-slate-800" loading={login.isPending}>
              Sign in
            </Button>
          </form>
          <div className="mt-4 rounded-3xl border border-white/20 bg-[#28282a]/85 p-4 text-white backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-wide text-white/60">
              Demo accounts · password <code className="rounded bg-white/10 px-1">password123</code>
            </p>
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {DEMO.map((d) => (
                <li key={d.email}>
                  <button
                    type="button"
                    className="w-full rounded-xl px-2 py-1.5 text-left text-sm hover:bg-white/10"
                    onClick={() => {
                      setEmail(d.email);
                      setPassword('password123');
                      login.mutate({ email: d.email, password: 'password123' });
                    }}
                  >
                    <span className="block font-medium text-white">{d.email.split('@')[0]}</span>
                    <span className="block text-xs text-white/55">{d.who}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </LandingShell>
  );
}
