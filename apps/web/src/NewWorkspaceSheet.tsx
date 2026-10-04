import { useState, type FormEvent } from "react";
import type { Workspace } from "../../../packages/shared/src/types";
import { api } from "./api";
import { useApp } from "./app-context";
import { navigate } from "./router";
import { Button, Feedback, Field, Sheet, useAction } from "./ui";

export function NewWorkspaceSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { refreshWorkspaces, selectWorkspace } = useApp();
  const [name, setName] = useState("");
  const action = useAction();
  function create(event: FormEvent) {
    event.preventDefault();
    if (action.busy || !name.trim()) return;
    void action.run(async () => {
      const result = await api<{ workspace: Workspace }>("/api/workspaces", { method: "POST", body: { name: name.trim() } });
      setName("");
      refreshWorkspaces();
      selectWorkspace(result.workspace.id);
      onClose();
      navigate({ name: "new", workspaceId: result.workspace.id });
    });
  }
  return <Sheet open={open} title="New workspace" onClose={() => { if (!action.busy) onClose(); }} footer={<>
    <Button disabled={action.busy} onClick={onClose}>Cancel</Button>
    <Button variant="default" type="submit" form="new-workspace-form" disabled={action.busy || !name.trim()}>{action.busy ? "Creating..." : "Create workspace"}</Button>
  </>}>
    <form id="new-workspace-form" className="stack" onSubmit={create}>
      <Field label="Name" hint="A shared home for repositories, people, agents and sessions">
        <input className="input" required autoFocus maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="The field studio" />
      </Field>
      <Feedback error={action.error} />
    </form>
  </Sheet>;
}
