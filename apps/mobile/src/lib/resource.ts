import { errorMessage } from "@pistead/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { useSession } from "./auth";

/** In the background the app makes no requests; "inactive" (iOS app switcher, Control Center) is brief and still visible. */
export const inBackground = () => AppState.currentState === "background";

export interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

/**
 * GET `path` (null: nothing to load). With `pollMs` it reloads on that interval while the app is in the foreground,
 * and right away when the app returns to it. A new path drops the previous data; a refresh keeps it on screen.
 */
export function useResource<T>(path: string | null, pollMs?: number): Resource<T> {
  const { api } = useSession();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const previousPath = useRef<string | null | undefined>(undefined);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    if (previousPath.current !== path) {
      previousPath.current = path;
      setData(null);
    }
    setError("");
    if (!path) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<T>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(errorMessage(reason));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    if (!pollMs) return () => controller.abort();
    const timer = setInterval(() => { if (!inBackground()) void load(); }, pollMs);
    const subscription = AppState.addEventListener("change", state => { if (state === "active") void load(); });
    return () => { controller.abort(); clearInterval(timer); subscription.remove(); };
  }, [api, path, pollMs, revision]);
  return { data, loading, error, refresh };
}

export interface ActionState {
  busy: boolean;
  error: string;
  notice: string;
  /** Runs `task` unless one is running; failures become `error`, success shows `notice`. Resolves true on success. */
  run: (task: () => Promise<void>, notice?: string) => Promise<boolean>;
  clear: () => void;
}

/** One user-triggered mutation at a time, with its outcome to show. */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useCallback(async (task: () => Promise<void>, success = "") => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task();
      if (mounted.current) setNotice(success);
      return true;
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason));
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => { setError(""); setNotice(""); }, []);
  return { busy, error, notice, run, clear };
}
