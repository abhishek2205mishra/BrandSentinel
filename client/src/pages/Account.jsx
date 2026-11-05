import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field, useToast } from '../components/ui';

export default function Account() {
  const { user, org } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    if (f.next !== f.again) return toast('The new passwords do not match.', 'err');
    setBusy(true);
    try { await api.post('/api/auth/change-password', { current: f.current, next: f.next }); toast('Password changed.'); setF({ current: '', next: '', again: '' }); }
    catch (ex) { toast(ex.message, 'err'); }
    setBusy(false);
  };
  return (
    <>
      <div className="page-head"><div><h1>Your account</h1><p className="muted">{user.name} · {user.email} · {user.role} at {org && org.name}</p></div></div>
      <form className="card stack" onSubmit={save} style={{ maxWidth: 460 }}>
        <h2>Change password</h2>
        <Field label="Current password"><input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 8 characters."><input type="password" required minLength={8} autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="Repeat new password"><input type="password" required minLength={8} autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        <button className="btn primary" disabled={busy}>Update password</button>
      </form>
    </>
  );
}
