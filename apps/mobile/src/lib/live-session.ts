import { openFetchEventStream, startLiveSession, type StreamStatus } from "@pistead/client";
import { fetch as streamingFetch } from "expo/fetch";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { SessionRecord, SessionView } from "../../../../packages/shared/src/types";
import { useSession } from "./auth";
import { inBackground } from "./resource";

/**
 * The session's metadata and live view. React Native has no EventSource, and its built-in fetch buffers whole
 * responses, so the /events stream runs over expo/fetch, whose bodies stream.
 */
export function useLiveSession(id: string) {
  const { api, origin, token } = useSession();
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [view, setView] = useState<SessionView | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [revision, setRevision] = useState(0);
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  const reconnect = useCallback(() => setRevision(current => current + 1), []);
  useEffect(() => {
    setStatus("connecting");
    const live = startLiveSession(id, { session: setSession, view: setView, error: setError, status: setStatus }, {
      api,
      openEvents: path => openFetchEventStream({ fetch: streamingFetch, url: `${origin}${path}`, headers: { Authorization: `Bearer ${token}` } }),
      hidden: inBackground,
      onVisibilityChange(listener) {
        const subscription = AppState.addEventListener("change", listener);
        return () => subscription.remove();
      },
    });
    refreshRef.current = live.refresh;
    return () => { live.stop(); refreshRef.current = () => {}; };
  }, [api, id, origin, token, revision]);
  return { session, view, error, status, refresh, reconnect };
}
