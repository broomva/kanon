"use client";

import { useEffect, useRef, useState } from "react";
import type { KanonEvent } from "./types";

export type LiveStatus = "connecting" | "live" | "offline";

export interface LiveHandlers {
  onEvent: (event: KanonEvent) => void;
  onHello?: (info: { workspace?: string; head?: string | null }) => void;
}

/**
 * Subscribe to the server's SSE projection stream. EventSource reconnects on
 * its own; we surface the connection status so the chrome can show a live dot.
 * The stream carries a `hello` frame then one frame per appended event.
 */
export function useLiveStream(handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const source = new EventSource("/api/kanon/v1/stream");

    source.addEventListener("hello", (ev) => {
      setStatus("live");
      try {
        ref.current.onHello?.(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignore malformed hello */
      }
    });

    source.onopen = () => setStatus("live");

    source.onmessage = (ev) => {
      try {
        ref.current.onEvent(JSON.parse(ev.data) as KanonEvent);
      } catch {
        /* ignore malformed frame */
      }
    };

    source.onerror = () => setStatus("offline");

    return () => source.close();
  }, []);

  return status;
}
