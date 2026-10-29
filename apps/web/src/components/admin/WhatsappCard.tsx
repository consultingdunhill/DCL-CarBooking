import { useMutation, useQuery } from '@tanstack/react-query';
import { MessageCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { errorMessage, get, post } from '@/lib/api';
import { relative } from '@/lib/format';

interface WhatsappStatus {
  provider: 'baileys' | 'twilio' | 'none';
  state: 'disabled' | 'connecting' | 'waiting_for_scan' | 'connected' | 'logged_out' | 'error';
  number?: string | null;
  qr?: string | null;
  pairingCode?: string | null;
  error?: string | null;
  updatedAt: string;
}

const STATE: Record<WhatsappStatus['state'], { label: string; tone: Tone }> = {
  disabled: { label: 'Off', tone: 'neutral' },
  connecting: { label: 'Connecting…', tone: 'warning' },
  waiting_for_scan: { label: 'Waiting for scan', tone: 'warning' },
  connected: { label: 'Linked', tone: 'success' },
  logged_out: { label: 'Unlinked', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
};

/** Link the company WhatsApp number (Baileys) by scanning a QR, and send a test. */
export function WhatsappCard() {
  const q = useQuery({
    queryKey: ['admin', 'whatsapp'],
    queryFn: () => get<WhatsappStatus>('/admin/whatsapp'),
    // Poll while waiting for the scan; the QR changes every ~20 seconds.
    refetchInterval: (query) => (query.state.data?.state === 'connected' || query.state.data?.state === 'disabled' ? 60_000 : 4_000),
  });
  const test = useMutation({
    mutationFn: () => post<{ to: string }>('/admin/whatsapp/test'),
    onSuccess: (r) => toast.success(`Test message queued for ${r.to}`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const s = q.data;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <MessageCircle className="size-4" /> WhatsApp alerts
          </span>
        }
        description="Urgent requests, overdue trips and lost tracking are also sent by WhatsApp."
        actions={s && <Badge tone={STATE[s.state].tone}>{s.provider === 'twilio' ? 'Twilio' : STATE[s.state].label}</Badge>}
      />
      <CardBody className="grid gap-4 text-sm">
        {!s ? null : s.provider === 'none' ? (
          <p className="text-muted-fg">
            Off. To send from a company WhatsApp number, set <code className="rounded bg-muted px-1">WHATSAPP_PROVIDER=baileys</code> in the server settings and restart the worker,
            then scan the QR code that appears here.
          </p>
        ) : s.provider === 'twilio' ? (
          <p className="text-muted-fg">Sent through Twilio's WhatsApp Business API.</p>
        ) : s.state === 'connected' ? (
          <p>
            Linked to <strong>{s.number}</strong>. Keep that phone switched on with WhatsApp installed; if it is unlinked, a new QR code appears here.
          </p>
        ) : s.state === 'waiting_for_scan' ? (
          <div className="flex flex-wrap items-start gap-5">
            {s.qr && <img src={s.qr} alt="WhatsApp link QR code" className="size-56 rounded-lg border border-border bg-white p-2" />}
            <ol className="max-w-sm list-decimal space-y-1.5 pl-5">
              <li>On the company phone, open WhatsApp.</li>
              <li>
                Go to <strong>Settings → Linked devices → Link a device</strong>.
              </li>
              <li>Scan this code. It refreshes every few seconds.</li>
              {s.pairingCode && (
                <li>
                  Or choose <strong>Link with phone number</strong> and enter <strong className="tabular tracking-widest">{s.pairingCode}</strong>.
                </li>
              )}
            </ol>
          </div>
        ) : (
          <p className="text-muted-fg">
            {s.state === 'logged_out' ? 'The number was unlinked from the phone. A new QR code appears in a moment.' : 'Connecting to WhatsApp…'}
            {s.error && <span className="block text-xs">({s.error})</span>}
          </p>
        )}

        {s && s.provider === 'baileys' && (
          <p className="rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
            This uses WhatsApp Web, not the official business API. WhatsApp may block numbers it sees as automated, so use a dedicated company number and keep
            it for alerts.
          </p>
        )}

        {s && s.provider !== 'none' && (
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" size="sm" loading={test.isPending} disabled={s.provider === 'baileys' && s.state !== 'connected'} onClick={() => test.mutate()}>
              <Send /> Send me a test message
            </Button>
            <span className="text-xs text-muted-fg">Status updated {relative(new Date(s.updatedAt))}</span>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
