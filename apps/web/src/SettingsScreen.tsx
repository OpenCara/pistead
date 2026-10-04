import { Icon, type IconName } from "./icons";
import { href, type SettingsSection } from "./router";
import { AgentsSettings } from "./settings/AgentsSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { HostsSettings } from "./settings/HostsSettings";
import { ProfileSettings } from "./settings/ProfileSettings";
import { WorkspacesSettings } from "./settings/WorkspacesSettings";
import { ScreenHeader } from "./ui";

const sections: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: "profile", label: "Profile", icon: "user" },
  { id: "hosts", label: "Hosts", icon: "server" },
  { id: "workspaces", label: "Workspaces", icon: "users" },
  { id: "agents", label: "Agents", icon: "bot" },
  { id: "appearance", label: "Appearance", icon: "palette" },
];

/** List + detail: a section list beside a centered 720px detail column; stacked on compact screens. */
export function SettingsScreen({ section, id }: { section: SettingsSection; id?: string }) {
  const current = sections.find(item => item.id === section)!;
  return <div className="settings-shell">
    <nav className="settings-list" aria-label="Settings">
      <div className="settings-list-title">Settings</div>
      {sections.map(item => <a key={item.id} className="nav-item" href={href({ name: "settings", section: item.id })} aria-current={item.id === section ? "page" : undefined}>
        <Icon name={item.icon} /><span className="label">{item.label}</span>
      </a>)}
    </nav>
    <div className="settings-detail">
      <ScreenHeader title={current.label} />
      <div className="content-column">
        {section === "profile" ? <ProfileSettings />
          : section === "hosts" ? <HostsSettings id={id} />
          : section === "workspaces" ? <WorkspacesSettings id={id} />
          : section === "agents" ? <AgentsSettings id={id} />
          : <AppearanceSettings />}
      </div>
    </div>
  </div>;
}
