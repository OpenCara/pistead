import { useTheme } from "../theme";
import { Row, Section, SegmentedControl } from "../ui";

export function AppearanceSettings() {
  const [theme, setTheme] = useTheme();
  return <Section title="Theme">
    <Row title="Color theme" hint="System follows your device setting" trailing={<SegmentedControl label="Color theme" value={theme} onChange={setTheme} options={[
      { value: "light", label: "Light", icon: "sun" },
      { value: "dark", label: "Dark", icon: "moon" },
      { value: "system", label: "System", icon: "monitor" },
    ]} />} />
  </Section>;
}
