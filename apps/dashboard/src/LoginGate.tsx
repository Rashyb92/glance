import { useState, type FormEvent } from 'react';
import { login, signup, type AuthResult } from './auth';

/** Runtime sign-in / sign-up. On success a session token is stored and `onAuthed` is called. */
export function LoginGate({ onAuthed }: { onAuthed: () => void }): JSX.Element {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const result: AuthResult =
      mode === 'login' ? await login(email, password) : await signup(email, password);
    setBusy(false);
    if (result.ok) onAuthed();
    else setError(result.error);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">Glance</div>
        <p className="login-sub">
          {mode === 'login' ? 'Sign in to your control center' : 'Create your account'}
        </p>
        <input
          className="login-input"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <input
          className="login-input"
          type="password"
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          minLength={8}
          required
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
        <button
          className="login-toggle"
          type="button"
          onClick={() => {
            setMode(mode === 'login' ? 'signup' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'New to Glance? Create an account' : 'Have an account? Sign in'}
        </button>
      </form>
    </div>
  );
}
