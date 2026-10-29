import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { errorMessage, post } from '@/lib/api';
import { useAuth, useMe } from '@/lib/auth';
import { Button } from './ui/button';

/** The notice shown at first sign-in. Legal/HR must review it before rollout. */
export function PrivacyNoticeText() {
  return (
    <div className="space-y-3 text-sm leading-relaxed text-fg/90">
      <p>
        This app records the company car's location <strong>only while a trip you run is in progress</strong>: from the moment you enter the
        start odometer reading until the trip ends. It never tracks you outside a trip.
      </p>
      <p>During a trip we record:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>GPS position (about every 50 m or 30 seconds while moving, every 5 minutes while stopped), with speed and accuracy</li>
        <li>your phone's battery level, and whether location services or mobile data were switched off</li>
        <li>arrival and departure times at each stop, and odometer readings and photos</li>
      </ul>
      <p>
        <strong>Why:</strong> to know where company cars are, keep staff safe, and work out what trips, viewings and properties cost.
      </p>
      <p>
        <strong>Who sees it:</strong> location data is visible only to fleet administrators, and every time they view it is logged. Raw GPS
        points are kept for 12 months, after which only trip summaries remain.
      </p>
      <p>
        <strong>Your rights:</strong> under the Kenya Data Protection Act 2019 you can ask to see, correct or delete your data. Contact the
        office administrator or the company's data protection officer.
      </p>
    </div>
  );
}

export function PrivacyGate() {
  const me = useMe();
  const { refreshMe } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-full bg-accent p-2.5 text-accent-fg">
            <ShieldCheck className="size-6" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Location privacy notice</h1>
            <p className="text-sm text-muted-fg">Please read this before using the app.</p>
          </div>
        </div>
        <PrivacyNoticeText />
        <Button
          className="mt-6 w-full"
          size="lg"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await post('/me/privacy-ack', { version: me.privacyNoticeVersion });
              await refreshMe();
            } catch (err) {
              toast.error(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          I understand
        </Button>
      </div>
    </div>
  );
}
