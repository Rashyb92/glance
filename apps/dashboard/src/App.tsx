import { useState } from 'react';
import { Dashboard } from './Dashboard';
import { LoginGate } from './LoginGate';
import { hasLoginSession, hasSession, logout } from './auth';

/**
 * Auth gate: shows the login screen until there's a usable session token, then the dashboard.
 * A baked `VITE_GLANCE_TOKEN` (dev / self-host) counts as a session, so local runs skip the
 * login screen; production builds ship no token and require a runtime sign-in.
 */
export function App(): JSX.Element {
  const [authed, setAuthed] = useState(hasSession());

  if (!authed) return <LoginGate onAuthed={() => setAuthed(true)} />;

  return (
    <>
      {hasLoginSession() ? (
        <button
          className="signout"
          type="button"
          onClick={() => void logout().then(() => setAuthed(false))}
        >
          Sign out
        </button>
      ) : null}
      <Dashboard />
    </>
  );
}
