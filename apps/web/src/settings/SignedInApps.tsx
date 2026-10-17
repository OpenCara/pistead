import type { SignedInDevice } from "../../../../packages/shared/src/types";
import { api, segment } from "../api";
import { Button, confirmDialog, Feedback, ResourceState, Row, Section, Timestamp, useAction, useResource } from "../ui";

/** Profile section listing the Pistead apps (iPhone, iPad, Mac) signed in as you, each revocable on its own. */
export function SignedInAppsSection() {
  const devices = useResource<{ devices: SignedInDevice[] }>("/api/me/devices");
  const action = useAction();
  async function revoke(device: SignedInDevice) {
    if (action.busy) return;
    const confirmed = await confirmDialog({
      title: "Sign out this app?",
      message: `${device.name ?? "This app"} is signed out at once and has to sign in again to reach your sessions.`,
      confirmLabel: "Sign out app",
      destructive: true,
    });
    if (!confirmed) return;
    void action.run(async () => {
      await api(`/api/me/devices/${segment(device.id)}`, { method: "DELETE" });
      devices.refresh();
    }, "App signed out.");
  }
  return <Section title="Signed-in apps" info="The Pistead apps on your phone, tablet or computer that signed in as you. Each stays signed in for 30 days unless you sign it out here or in the app.">
    <ResourceState {...devices} retry={devices.refresh}>
      {devices.data && !devices.data.devices.length && <Row title="No apps signed in" hint="Sign in from the Pistead app on iPhone, iPad or Mac" />}
      {devices.data?.devices.map(device => <Row key={device.id}
        title={device.name ?? "Unnamed app"}
        hint={<>Signed in <Timestamp value={device.createdAt} /> · until <Timestamp value={device.expiresAt} /></>}
        trailing={<Button variant="outline" size="sm" disabled={action.busy} onClick={() => void revoke(device)}>Sign out</Button>} />)}
    </ResourceState>
    <Feedback {...action} />
  </Section>;
}
