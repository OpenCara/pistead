import { useCallback, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, errorMessage } from "./api";
import { Icon, type IconName } from "./icons";
import { Popover } from "./popover";

/* ---------- Data hooks ---------- */

/** Loads `path`; a refresh keeps the previous data visible until the new response lands. */
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const loadedPath = useRef<string | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    // Data from a different path must never show under the new one.
    if (loadedPath.current !== path) { setData(null); loadedPath.current = path; }
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

/* ---------- Buttons ---------- */

type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
type ControlSize = "xs" | "sm" | "md" | "lg";

/** `default` is the one accent CTA per surface; `outline` for row actions; `ghost` for chrome. */
export function Button({ variant = "secondary", size = "md", icon, block, className, children, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ControlSize; icon?: IconName; block?: boolean }) {
  const iconOnly = icon && !children;
  return <button type={type} className={["btn", variant, size !== "md" && size, block && "block", iconOnly && "icon-only", className].filter(Boolean).join(" ")} {...rest}>
    {icon && <Icon name={icon} size={size === "xs" ? 14 : 16} />}{children}
  </button>;
}

/** An anchor styled as a button, for navigation and downloads. */
export function LinkButton({ href, variant = "secondary", size = "md", icon, children, ...rest }: { href: string; variant?: ButtonVariant; size?: ControlSize; icon?: IconName; children: ReactNode; target?: string; rel?: string; download?: boolean | string; onClick?: () => void }) {
  return <a href={href} className={["btn", variant, size !== "md" && size].filter(Boolean).join(" ")} {...rest}>{icon && <Icon name={icon} size={16} />}{children}</a>;
}

/* ---------- Status ---------- */

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "running";

export function StatusBadge({ tone = "neutral", dot, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className={`badge ${tone === "running" ? "info" : tone}`}>{dot && <StatusDot tone={tone} />}{children}</span>;
}

export function StatusDot({ tone = "neutral", label }: { tone?: Tone; label?: string }) {
  return <span className={`dot ${tone === "info" ? "running" : tone}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Spinner({ large, label }: { large?: boolean; label?: string }) {
  return <span className={large ? "spinner large" : "spinner"} role={label ? "status" : undefined} aria-label={label} />;
}

export function Loading({ children = "Loading..." }: { children?: ReactNode }) {
  return <span className="loading-line" role="status"><Spinner />{children}</span>;
}

export function PageLoading() {
  return <div className="page-loading"><Spinner large label="Loading" /></div>;
}

/** Page-level notice. Actions go in `actions` as outline/sm buttons. */
export function Alert({ variant = "default", title, children, actions, role }: { variant?: "default" | "info" | "success" | "warning" | "error"; title: ReactNode; children?: ReactNode; actions?: ReactNode; role?: "alert" | "status" | "note" }) {
  const icon: IconName = variant === "success" ? "check" : variant === "warning" || variant === "error" ? "alert" : "info";
  return <div className={`alert ${variant}`} role={role ?? (variant === "error" ? "alert" : "note")}>
    <Icon name={icon} size={16} />
    <div className="alert-title">{title}</div>
    {(children || actions) && <div className="alert-body">{children}{actions && <div className="alert-actions">{actions}</div>}</div>}
  </div>;
}

/** Inline action result under the control or card it relates to. */
export function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return <>{error && <p className="field-error" role="alert">{error}</p>}{notice && <p className="field-notice" role="status">{notice}</p>}</>;
}

export function ResourceState({ loading, error, retry, children }: { loading: boolean; error: string; retry: () => void; children?: ReactNode }) {
  if (loading) return <Loading />;
  if (error) return <Alert variant="error" title="Couldn't load" actions={<Button variant="outline" size="sm" onClick={retry}>Try again</Button>}>{error}</Alert>;
  return <>{children}</>;
}

/** Screen-level empty state: muted noun phrase, at most one action. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="empty-state"><div>{title}</div>{children && <p>{children}</p>}{action}</div>;
}

/* ---------- Sections, cards and rows ---------- */

/** A medium label (with optional info tip and trailing action) above one card. Explanations go in `info`, never a paragraph. */
export function Section({ title, info, action, children, bare }: { title: ReactNode; info?: ReactNode; action?: ReactNode; children: ReactNode; bare?: boolean }) {
  return <section className="section">
    <div className="section-header"><h2 className="section-title">{title}</h2>{info && <InfoTip>{info}</InfoTip>}{action && <><span className="spacer" />{action}</>}</div>
    {bare ? children : <div className="card">{children}</div>}
  </section>;
}

/** Padded free-form content inside a card. */
export function CardBody({ children }: { children: ReactNode }) {
  return <div className="card-body">{children}</div>;
}

/** Row anatomy: leading, title + hint, trailing. With onClick/href and `chevron` it drills into a detail. */
export function Row({ title, hint, leading, trailing, onClick, href, chevron, disabled }: { title: ReactNode; hint?: ReactNode; leading?: ReactNode; trailing?: ReactNode; onClick?: () => void; href?: string; chevron?: boolean; disabled?: boolean }) {
  const body = <>
    {leading && <span className="row-leading">{leading}</span>}
    <span className="row-content"><span className="row-title">{title}</span>{hint && <span className="row-hint">{hint}</span>}</span>
    {(trailing || chevron) && <span className="row-trailing">{trailing}{chevron && <Icon name="chevron-right" size={16} />}</span>}
  </>;
  if (href) return <a className="row" href={href}>{body}</a>;
  if (onClick) return <button type="button" className="row" onClick={onClick} disabled={disabled}>{body}</button>;
  return <div className="row">{body}</div>;
}

/** An expandable row; reveals child content in place. `plain` renders it standalone outside a card. */
export function Collapsible({ title, hint, leading, trailing, children, open, plain }: { title: ReactNode; hint?: ReactNode; leading?: ReactNode; trailing?: ReactNode; children: ReactNode; open?: boolean; plain?: boolean }) {
  return <details className={plain ? "collapsible plain" : "collapsible"} open={open}>
    <summary>
      {leading && <span className="row-leading">{leading}</span>}
      <span className="row-content"><span className="row-title">{title}</span>{hint && <span className="row-hint">{hint}</span>}</span>
      {trailing && <span className="row-trailing">{trailing}</span>}
      <span className="chevron"><Icon name="chevron-right" size={16} /></span>
    </summary>
    <div className="collapsible-body">{children}</div>
  </details>;
}

export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}{error && <span className="field-error">{error}</span>}</label>;
}

/* ---------- Pickers and overlays ---------- */

/** Closes on Escape or on a pointer press outside both the anchor and the (portaled) popover. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || (target instanceof Element && target.closest(".popover.portal"))) return;
      close();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer); document.removeEventListener("keydown", key); };
  }, [open, close]);
  return ref;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Trigger-anchored menu for a small fixed set of actions (kebab menus). */
export function DropdownMenu({ label, icon = "more", items, align = "end", side = "below", trigger }: { label: string; icon?: IconName; items: (MenuItem | "separator")[]; align?: "start" | "end"; side?: "below" | "above"; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const id = useId();
  return <div className="menu-anchor" ref={ref}>
    {trigger
      ? <button type="button" className="btn ghost sm" aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{trigger}</button>
      : <Button variant="ghost" size="xs" icon={icon} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={event => { event.stopPropagation(); setOpen(value => !value); }} />}
    {open && <Popover anchor={ref} side={side} align={align} role="menu" id={id} className="menu-scroll">
      {items.map((item, index) => item === "separator"
        ? <div className="menu-separator" key={`separator-${index}`} role="separator" />
        : <button key={item.label} type="button" role="menuitem" className={item.destructive ? "menu-item destructive" : "menu-item"} disabled={item.disabled} onClick={event => { event.stopPropagation(); setOpen(false); item.onSelect(); }}>
          {item.icon && <Icon name={item.icon} size={14} />}<span className="menu-text"><span>{item.label}</span>{item.hint && <span className="menu-hint">{item.hint}</span>}</span>
        </button>)}
    </Popover>}
  </div>;
}

export interface Option<T extends string> { value: T; label: string; hint?: string; disabled?: boolean }

/** Searchable picker for long lists (models, agents, hosts). The list scrolls within the space the viewport leaves. */
export function Combobox<T extends string>({ value, options, onChange, placeholder = "Select...", label, disabled, side = "below" }: { value: T | ""; options: Option<T>[]; onChange: (value: T) => void; placeholder?: string; label: string; disabled?: boolean; side?: "below" | "above" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const close = useCallback(() => { setOpen(false); setQuery(""); }, []);
  const ref = useDismiss(open, close);
  const selected = options.find(option => option.value === value);
  const filtered = options.filter(option => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="menu-anchor" ref={ref}>
    <button type="button" className="btn ghost sm" aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)}>
      <span className="truncate">{selected?.label ?? placeholder}</span><Icon name="chevron-down" size={14} />
    </button>
    {open && <Popover anchor={ref} side={side} role="dialog" label={label} className="listbox-popover">
      {options.length > 7 && <input className="input listbox-search" autoFocus placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} aria-label={`Search ${label}`} />}
      <div role="listbox" className="listbox">
        {filtered.length ? filtered.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className="menu-item" onClick={() => { onChange(option.value); close(); }}>
          <span className="truncate">{option.label}</span>{option.hint && <span className="menu-hint">{option.hint}</span>}
        </button>) : <div className="menu-label">No matches</div>}
      </div>
    </Popover>}
  </div>;
}

export function SegmentedControl<T extends string>({ value, options, onChange, size = "sm", label }: { value: T; options: (Option<T> & { icon?: IconName })[]; onChange: (value: T) => void; size?: "xs" | "sm"; label: string }) {
  return <div className={size === "xs" ? "segmented xs" : "segmented"} role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => onChange(option.value)} title={option.hint}>{option.icon && <Icon name={option.icon} size={14} />}{option.label}</button>)}
  </div>;
}

/** Section or group explanation: an info icon that opens a short note. */
export function InfoTip({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return <div className="info-tip menu-anchor" ref={ref}>
    <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="info" size={14} /></button>
    {open && <Popover anchor={ref} side="below" role="note" className="text menu-scroll" style={{ width: 320 }}>{children}</Popover>}
  </div>;
}

/** Focused task with a backdrop: centered card on desktop. */
export function Sheet({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={wide ? "sheet wide" : "sheet"} onClose={onClose} onCancel={event => { event.preventDefault(); onClose(); }}>
    {open && <>
      <div className="sheet-header"><h2 className="sheet-title">{title}</h2><Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} /></div>
      <div className="sheet-content">{children}</div>
      {footer && <div className="sheet-footer">{footer}</div>}
    </>}
  </dialog>;
}

/** Promise-based confirmation. Red appears only here, after the user has indicated intent. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false }: { title: string; message: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const finish = (value: boolean) => {
    resolve(value);
    root.unmount();
    host.remove();
  };
  function Confirm() {
    const [open, setOpen] = useState(true);
    const done = (value: boolean) => { setOpen(false); finish(value); };
    return <Sheet open={open} title={title} onClose={() => done(false)} footer={<>
      <Button onClick={() => done(false)}>{cancelLabel}</Button>
      <Button variant={destructive ? "destructive" : "default"} onClick={() => done(true)} autoFocus>{confirmLabel}</Button>
    </>}><div className="muted">{message}</div></Sheet>;
  }
  root.render(<Confirm />);
  return promise;
}

/* ---------- Chrome ---------- */

/** Pane header with a single bottom border; title is light, actions sit at the end. */
export function ScreenHeader({ title, subtitle, leading, actions }: { title: ReactNode; subtitle?: ReactNode; leading?: ReactNode; actions?: ReactNode }) {
  return <header className="screen-header">{leading}<h1 className="screen-title">{title}</h1>{subtitle && <span className="screen-subtitle">{subtitle}</span>}{actions && <div className="actions">{actions}</div>}</header>;
}

const identityColors = ["#5b7cfa", "#e06c4f", "#3fa37a", "#b56fd8", "#d39b2c", "#3e9bc2", "#d1577d", "#7a8c35", "#8a6bd1", "#c4703a"];

/** Stable letter badge for a workspace or person, from a fixed identity palette. */
export function IdentityBadge({ name, id }: { name: string; id: string }) {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return <span className="identity" style={{ background: identityColors[hash % identityColors.length] }} aria-hidden="true">{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}

/* ---------- Text and values ---------- */

export function Timestamp({ value }: { value: string }) {
  const date = new Date(value);
  return <time dateTime={value} title={Number.isNaN(date.getTime()) ? value : date.toLocaleString()}>{Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>;
}

/** Compact relative time ("now", "5m", "3h", "2d", then a date). */
export function RelativeTime({ value }: { value: string }) {
  const date = new Date(value);
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  const text = Number.isNaN(seconds) ? value
    : seconds < 60 ? "now" : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h`
    : seconds < 7 * 86400 ? `${Math.floor(seconds / 86400)}d` : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return <time dateTime={value} title={Number.isNaN(date.getTime()) ? value : date.toLocaleString()}>{text}</time>;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <Button variant="ghost" size="xs" icon={copied ? "check" : "copy"} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label} onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))} />;
}

/** A command or secret with a copy action; text stays selectable for manual copying. */
export function CopyField({ value, label }: { value: string; label?: string }) {
  return <div className="copy-field"><code>{value}</code><CopyButton value={value} label={label} /></div>;
}
