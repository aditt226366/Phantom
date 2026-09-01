"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Pull the thread again every few seconds, and stop when nobody is looking.
 *
 * A poll rather than a socket: the inbound path already ends in a database
 * write from a worker, so there is nothing on the web side holding a connection
 * that could push - and a five-second delay on an inbound message is not what
 * makes or breaks this product. Sockets are a scale conversation, with a
 * shared Redis subscription behind them - deliberately not given a phase
 * number here, because the number this comment used to carry (9) has since
 * shipped as the dashboard and brought no sockets with it. A forward
 * reference to a numbered phase is a promise the renumbering can silently
 * reassign to somebody else's work.
 *
 * `router.refresh()` re-runs the server component and reconciles, so the
 * composer keeps its draft and focus across a refresh. Replacing this with a
 * location reload would throw away half-typed replies every five seconds.
 *
 * Pausing on hidden is the part that matters for cost rather than for polish.
 * A left-open tab is the normal state of an inbox, and without this every one
 * of them queries the database twelve times a minute for as long as the browser
 * lives. Refreshing once on the way back means the first thing a returning
 * reader sees is current rather than however old the tab was.
 */
export function ThreadRefresh({ intervalMs = 5_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let timer: number | undefined;

    const stop = (): void => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };

    const start = (): void => {
      stop();
      timer = window.setInterval(() => router.refresh(), intervalMs);
    };

    const onVisibility = (): void => {
      if (document.hidden) {
        stop();
        return;
      }
      router.refresh();
      start();
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [router, intervalMs]);

  return null;
}
