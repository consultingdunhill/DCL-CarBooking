import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/misc';
import { errorMessage, get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ENV } from '@/lib/env';

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 21 21" className="size-5" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

function DevUserPicker() {
  const { signInDev } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const users = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => get<{ id: string; name: string; email: string; role: string; department: string | null }[]>('/auth/dev-users'),
  });
  if (users.isLoading) return <Spinner className="mx-auto" />;
  if (users.error) return <p className="text-sm text-danger">Can't reach the API at {ENV.apiUrl}. Is it running?</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-fg">Development sign-in: choose a user.</p>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {users.data!.map((u) => (
          <button
            key={u.id}
            className="flex w-full items-center justify-between gap-3 bg-surface px-4 py-3 text-left hover:bg-muted disabled:opacity-60"
            disabled={busy !== null}
            onClick={async () => {
              setBusy(u.id);
              try {
                await signInDev(u.id);
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(null);
              }
            }}
          >
            <span>
              <span className="block font-medium">{u.name}</span>
              <span className="block text-xs text-muted-fg">{u.email}</span>
            </span>
            {busy === u.id ? <Spinner /> : <Badge tone={u.role === 'ADMIN' ? 'primary' : 'neutral'}>{u.role === 'ADMIN' ? 'Admin' : 'Staff'}</Badge>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { signIn } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/icon.svg" alt="" className="mb-4 size-14" />
          <h1 className="text-2xl font-semibold tracking-tight">{ENV.appName}</h1>
          <p className="mt-1 text-sm text-muted-fg">Book a company car, run your trip, and see where the time goes.</p>
        </div>
        {ENV.authMode === 'dev' ? (
          <DevUserPicker />
        ) : (
          <Button
            size="lg"
            variant="secondary"
            className="w-full"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signIn();
              } catch (err) {
                toast.error(errorMessage(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <MicrosoftLogo /> Sign in with Microsoft 365
          </Button>
        )}
      </div>
    </div>
  );
}
