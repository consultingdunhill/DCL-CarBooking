import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { authHeader } from './api';
import { ENV } from './env';

export type LiveEvent =
  | { type: 'booking.changed'; bookingId: string; status?: string }
  | { type: 'join.changed'; joinRequestId: string; bookingId: string; status?: string }
  | { type: 'trip.updated'; tripId: string; bookingId: string; status: string; lat?: number | null; lng?: number | null; lastSeenAt?: string | null; battery?: number | null }
  | { type: 'notification'; userId: string };

type Handler = (e: LiveEvent) => void;
const handlers = new Set<Handler>();

/** Subscribe to live events anywhere in the app (the stream is opened once by useLiveStream). */
export function useLiveEvent(handler: Handler) {
  useEffect(() => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }, [handler]);
}

/**
 * Open the server-sent event stream (with fetch, so the bearer token can be
 * sent) and refresh affected queries as events arrive. Reconnects with backoff.
 */
export function useLiveStream(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let delay = 1000;

    const dispatch = (e: LiveEvent) => {
      if (e.type === 'booking.changed' || e.type === 'join.changed') {
        void qc.invalidateQueries({ queryKey: ['bookings'] });
        void qc.invalidateQueries({ queryKey: ['booking', e.bookingId] });
        void qc.invalidateQueries({ queryKey: ['approvals'] });
        void qc.invalidateQueries({ queryKey: ['current-trip'] });
        void qc.invalidateQueries({ queryKey: ['live'] });
        void qc.invalidateQueries({ queryKey: ['trip'] });
      } else if (e.type === 'trip.updated') {
        void qc.invalidateQueries({ queryKey: ['live'] });
        void qc.invalidateQueries({ queryKey: ['trip', e.tripId] });
        void qc.invalidateQueries({ queryKey: ['admin-trips'] });
      } else if (e.type === 'notification') {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      }
      handlers.forEach((h) => h(e));
    };

    const connect = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch(`${ENV.apiUrl}/live/stream`, { headers: await authHeader(), signal: controller.signal });
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          delay = 1000;
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let idx;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const chunk = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              const data = chunk
                .split('\n')
                .filter((l) => l.startsWith('data: '))
                .map((l) => l.slice(6))
                .join('\n');
              if (data && data !== '{}') {
                try {
                  dispatch(JSON.parse(data) as LiveEvent);
                } catch {
                  /* ignore */
                }
              }
            }
          }
        } catch {
          /* reconnect below */
        }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller?.abort();
    };
  }, [enabled, qc]);
}
