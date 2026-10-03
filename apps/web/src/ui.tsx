import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, errorMessage } from "./api";

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    if (!path) { setLoading(false); return; }
    setLoading(true);
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(errorMessage(reason));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, revision]);
  return { data, loading, error, refresh, setData };
}

export interface ActionState {
  busy: boolean;
  error: string;
  notice: string;
  run: (action: () => Promise<void>, success?: string) => Promise<void>;
}

export function useAction(): ActionState {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function run(action: () => Promise<void>, success = "") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      setNotice(success);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}

export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <div className="error" role="alert">{error}</div>}{notice && <div className="notice" role="status">{notice}</div>}</>;
}

export function ResourceState({ loading, error, retry, children }: { loading: boolean; error: string; retry: () => void; children?: ReactNode }) {
  if (loading) return <p className="loading" role="status">Loading the workspace...</p>;
  if (error) return <div className="error" role="alert"><p>{error}</p><button className="button secondary small" onClick={retry}>Try again</button></div>;
  return <>{children}</>;
}

export function PageHeading({ eyebrow, title, children, actions }: { eyebrow?: string; title: string; children: ReactNode; actions?: ReactNode }) {
  return <header className="page-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p className="lead">{children}</p></div>{actions && <div className="heading-actions">{actions}</div>}</header>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3><p>{children}</p></div>;
}

export function Timestamp({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} className="mono">{Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}
