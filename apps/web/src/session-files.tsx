import { useEffect, useState } from "react";
import { fileBrowserLimits, type FileEntry, type SessionFiles, type SessionRecord } from "../../../packages/shared/src/types";
import { REDACTED } from "../../../packages/shared/src/redaction";
import { segment } from "./api";
import { Icon, type IconName } from "./icons";
import { CodeView } from "./code-highlight";
import { Alert, Button, EmptyState, ResourceState, Row, SegmentedControl, useResource } from "./ui";

/** A worktree path one level down; the worktree's root is ".". */
function childPath(directory: string, name: string): string {
  return directory === "." ? name : `${directory}/${name}`;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "." : path.slice(0, index);
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const entryIcon: Record<FileEntry["type"], IconName> = { directory: "folder", file: "file", symlink: "link", other: "file" };

/**
 * The session panel's Files tab: the session's worktree on its host, read-only, one directory or file at a time. The
 * server asks the host for each path as it is opened, so what shows is what is there now; Refresh reads it again.
 */
export function FilesPanel({ session }: { session: SessionRecord }) {
  const permissions = session.permissions ?? [];
  // The directory being listed, and the file previewed in it, if any.
  const [directory, setDirectory] = useState(".");
  const [file, setFile] = useState<string | null>(null);
  // A new session starts at its worktree's root again.
  useEffect(() => { setDirectory("."); setFile(null); }, [session.id]);
  if (session.status === "archived") return <EmptyState title="Files unavailable">Archived sessions don't show their files. Unarchive the session to browse them.</EmptyState>;
  if (!permissions.includes("write")) {
    return <EmptyState title="Files unavailable">Browsing the session's files takes the session collaborator role, as collaborators can already have the agent read any of them. Viewers follow the conversation.</EmptyState>;
  }
  const open = (path: string) => { setDirectory(path); setFile(null); };
  return file
    ? <FilePreview session={session} path={file} onBack={() => setFile(null)} onDirectory={open} />
    : <DirectoryListing session={session} path={directory} onOpen={open} onFile={setFile} />;
}

function filesHref(session: SessionRecord, path: string): string {
  return `/api/sessions/${segment(session.id)}/files?path=${encodeURIComponent(path)}`;
}

function Breadcrumbs({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const parts = path === "." ? [] : path.split("/");
  return <nav className="file-breadcrumbs" aria-label="Worktree path">
    <button type="button" className="file-crumb" onClick={() => onOpen(".")} disabled={!parts.length}>worktree</button>
    {parts.map((part, index) => {
      const target = parts.slice(0, index + 1).join("/");
      const last = index === parts.length - 1;
      return <span key={target} className="file-crumb-item">
        <span className="muted" aria-hidden="true">/</span>
        <button type="button" className="file-crumb" onClick={() => onOpen(target)} disabled={last} aria-current={last ? "location" : undefined}>{part}</button>
      </span>;
    })}
  </nav>;
}

function DirectoryListing({ session, path, onOpen, onFile }: { session: SessionRecord; path: string; onOpen: (path: string) => void; onFile: (path: string) => void }) {
  const listing = useResource<{ files: SessionFiles }>(filesHref(session, path));
  const files = listing.data?.files;
  // A symlink opened as a directory lists it under the path it was opened by.
  useEffect(() => { if (files?.type === "file") onFile(path); }, [files, path, onFile]);
  return <div className="file-browser">
    <div className="file-browser-bar">
      <Breadcrumbs path={path} onOpen={onOpen} />
      <span className="spacer" />
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh files" title="Refresh" disabled={listing.loading} onClick={listing.refresh} />
    </div>
    <ResourceState loading={listing.loading && !files} error={listing.error} retry={listing.refresh}>
      {files?.type === "directory" && (files.entries.length || path !== "." ? <div className="card file-list">
        {path !== "." && <Row leading={<Icon name="chevron-left" size={16} />} title=".." hint="Parent directory" onClick={() => onOpen(parentPath(path))} />}
        {files.entries.map(entry => {
          const target = childPath(path, entry.name);
          return <Row
            key={entry.name}
            leading={<Icon name={entryIcon[entry.type]} size={16} />}
            title={<span className="file-name">{entry.name}{entry.type === "directory" ? "/" : ""}</span>}
            hint={entry.type === "symlink" ? "Symlink" : entry.type === "other" ? "Special file" : undefined}
            trailing={entry.size !== undefined ? <span className="muted small">{formatBytes(entry.size)}</span> : undefined}
            // A symlink opens as whatever it points to, if that stays in the worktree; special files have nothing to show.
            onClick={entry.type === "other" ? undefined : () => entry.type === "directory" ? onOpen(target) : onFile(target)}
          />;
        })}
        {!files.entries.length && <Row title="Empty directory" />}
        {files.truncated && <Row title={`Showing ${files.entries.length} of ${files.total} entries`} hint="Directories first, then by name" />}
      </div> : <EmptyState title="The worktree is empty">The agent clones the session's repositories into it as it works.</EmptyState>)}
    </ResourceState>
  </div>;
}

function FilePreview({ session, path, onBack, onDirectory }: { session: SessionRecord; path: string; onBack: () => void; onDirectory: (path: string) => void }) {
  const preview = useResource<{ files: SessionFiles }>(filesHref(session, path));
  const files = preview.data?.files;
  // A symlink to a directory: list it instead.
  useEffect(() => { if (files?.type === "directory") onDirectory(path); }, [files, path, onDirectory]);
  return <div className="file-browser">
    <div className="file-browser-bar">
      <Button variant="ghost" size="xs" icon="chevron-left" aria-label="Back to directory" title="Back" onClick={onBack} />
      <Breadcrumbs path={path} onOpen={onDirectory} />
      <span className="spacer" />
      <Button variant="ghost" size="xs" icon="refresh" aria-label="Refresh file" title="Refresh" disabled={preview.loading} onClick={preview.refresh} />
    </div>
    <ResourceState loading={preview.loading && !files} error={preview.error} retry={preview.refresh}>
      {files?.type === "file" && <div className="stack">
        <p className="muted small">{formatBytes(files.size)}{files.text !== undefined && files.truncated ? ` · showing the first ${formatBytes(fileBrowserLimits.textBytes)}` : ""}</p>
        {files.redacted && <Alert title="Secret hidden">Something that looks like a secret is shown as <code>{REDACTED}</code>, as in the conversation.</Alert>}
        {files.text !== undefined && (!files.text ? <EmptyState title="Empty file" />
          : isSvg(path) && !files.truncated ? <SvgPreview key={path} text={files.text} path={path} />
          : <CodeView text={files.text} path={path} />)}
        {files.image && <ImageView key={path} src={`data:${files.image.mimeType};base64,${files.image.data}`} path={path} />}
        {files.binary && <EmptyState title={files.truncated ? "Too large to preview" : "No preview"}>{files.truncated
          ? `Images up to ${formatBytes(fileBrowserLimits.imageBytes)} are shown.`
          : "This isn't a text file or an image."}</EmptyState>}
      </div>}
    </ResourceState>
  </div>;
}

const isSvg = (path: string) => /\.svg$/i.test(path);

/**
 * An image at its natural size when it fits, else scaled to the panel; clicking switches between that and its actual
 * size. Transparent pixels show over a checkerboard.
 */
function ImageView({ src, path }: { src: string; path: string }) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return <EmptyState title="Can't show this image">The browser couldn't decode it.</EmptyState>;
  return <figure className="file-image-view">
    <button type="button" className={actual ? "file-image-frame actual" : "file-image-frame"} onClick={() => setActual(value => !value)}
      title={actual ? "Fit to panel" : "Show actual size"} aria-label={actual ? "Fit image to panel" : "Show image at actual size"}>
      <img className="file-image" alt={path} src={src} draggable={false}
        onLoad={event => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={() => setFailed(true)} />
    </button>
    {size && <figcaption className="muted small">{size.width} × {size.height} px · {actual ? "actual size" : "fit to panel"}</figcaption>}
  </figure>;
}

/**
 * An SVG drawn as an image: in an <img> it runs no scripts and loads nothing else. Its source is a click away. A preview
 * cut short is shown as source only, as a partial SVG doesn't draw.
 */
function SvgPreview({ text, path }: { text: string; path: string }) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  return <div className="stack">
    <SegmentedControl<"preview" | "source"> size="xs" label="SVG view" value={mode} onChange={setMode}
      options={[{ value: "preview", label: "Preview" }, { value: "source", label: "Source" }]} />
    {mode === "preview" ? <ImageView src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`} path={path} /> : <CodeView text={text} path={path} />}
  </div>;
}
