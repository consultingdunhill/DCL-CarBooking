import { Download, EllipsisVertical, Share, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { isIOS, isPhone, promptInstall, useInstallMode, type InstallMode } from '@/lib/install';

const DISMISS_KEY = 'fleet.installBannerDismissed';

const title = isPhone ? 'Add Fleet to your home screen' : 'Install Fleet';
const description = isPhone
  ? `Fleet then opens full screen, like an app.${isIOS ? ' On iPhone you need this to get notifications.' : ''}`
  : 'Fleet then opens in its own window from your taskbar or dock.';

async function install() {
  if (await promptInstall()) toast.success('Fleet installed');
}

function Steps({ steps }: { steps: ReactNode[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-6 text-sm">
      {steps.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ol>
  );
}

/** An install button where the browser offers one; otherwise the steps to do it by hand. */
function InstallSteps({ mode }: { mode: InstallMode }) {
  if (mode === 'prompt') {
    return (
      <Button className="justify-self-start" onClick={() => void install()}>
        <Download /> Install Fleet
      </Button>
    );
  }
  if (mode === 'ios') {
    return (
      <>
        <Steps
          steps={[
            <>
              Tap <strong>Share</strong> <Share className="inline size-4 align-text-bottom" />. On newer iPhones it's inside the <strong>⋯</strong> menu.
            </>,
            <>
              Scroll down and tap <strong>Add to Home Screen</strong>.
            </>,
            <>
              Tap <strong>Add</strong>.
            </>,
          ]}
        />
        <p className="text-xs text-muted-fg">If this page opened inside another app, such as Teams or Outlook, open it in Safari first.</p>
      </>
    );
  }
  return (
    <>
      <Steps
        steps={[
          <>
            Tap the browser menu <EllipsisVertical className="inline size-4 align-text-bottom" />.
          </>,
          <>
            Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
          </>,
        ]}
      />
      <p className="text-xs text-muted-fg">Already installed? Open Fleet from your home screen instead.</p>
    </>
  );
}

/** Me page: how to install, until Fleet is opened from the home screen. */
export function InstallCard() {
  const mode = useInstallMode();
  if (mode === 'installed' || mode === 'none') return null;
  return (
    <Card id="install">
      <CardHeader title={title} description={description} />
      <CardBody className="grid gap-3">
        <InstallSteps mode={mode} />
      </CardBody>
    </Card>
  );
}

/** Book page: a dismissible nudge on phones that haven't installed Fleet. */
export function InstallBanner() {
  const mode = useInstallMode();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [help, setHelp] = useState(false);
  if (dismissed || !isPhone || mode === 'installed' || mode === 'none') return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Private browsing: it comes back next visit, which is fine.
    }
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-surface-2 p-3">
      <img src="/icon.svg" alt="" className="size-10 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">Add to home screen</p>
        <p className="text-xs text-muted-fg">{isIOS ? 'Opens Fleet full screen, with notifications.' : 'Opens Fleet full screen, like an app.'}</p>
      </div>
      {mode === 'prompt' ? (
        <Button size="sm" onClick={() => void install()}>
          Install
        </Button>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setHelp(true)}>
          How?
        </Button>
      )}
      <Button size="icon-sm" variant="ghost" className="-mr-1 text-muted-fg" onClick={dismiss} aria-label="Dismiss">
        <X />
      </Button>
      <Dialog open={help} onOpenChange={setHelp} title={title} description={description}>
        <div className="grid gap-3">
          <InstallSteps mode={mode} />
        </div>
      </Dialog>
    </div>
  );
}
