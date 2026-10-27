import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@clerk/react';
import { backoffMs, eventTickers, eventFreshIds, parseSse } from '@/lib/live-model';

export type LiveStatus = 'connecting' | 'open' | 'retrying';

type Handlers = {
  /** Stored-trade event for these tickers (already durable on the server). */
  onTrades: (tickers: string[], freshIds: string[]) => void;
  /** Fired on `ready`; `reconnect` is true after any previous connection, to close gaps. */
  onReady: (reconnect: boolean) => void;
};

/** Owner-protected SSE stream over authenticated fetch with bounded reconnect backoff. */
export function useLiveExplorer(enabled: boolean, handlers: Handlers) {
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    let attempt = 0;
    let connections = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/kalshi/live`;

    const run = async () => {
      setStatus(attempt === 0 && connections === 0 ? 'connecting' : 'retrying');
      try {
        const token = await getTokenRef.current();
        const res = await fetch(url, {
          credentials: 'include',
          headers: { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const { events, rest } = parseSse(buf);
          buf = rest;
          for (const ev of events) {
            if (ev.event === 'ready') {
              attempt = 0;
              setStatus('open');
              handlersRef.current.onReady(connections > 0);
              connections += 1;
            } else if (ev.event === 'trades') {
              const tickers = eventTickers(ev.data);
              if (tickers.length) handlersRef.current.onTrades(tickers, eventFreshIds(ev.data));
            }
          }
        }
        // Server closes after ~55 s to renew auth: reconnect quickly.
        if (!ctrl.signal.aborted) timer = setTimeout(run, 250);
      } catch {
        if (ctrl.signal.aborted) return;
        setStatus('retrying');
        timer = setTimeout(run, backoffMs(attempt));
        attempt += 1;
      }
    };
    void run();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
  }, [enabled]);

  return status;
}
