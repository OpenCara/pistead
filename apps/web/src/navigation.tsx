import { createContext, useContext } from "react";
import { Button } from "./ui";

/** The app shell's navigation drawer, for screens that put its button in their own header on narrow screens. */
export interface Navigation {
  open: () => void;
  expanded: boolean;
}

const NavigationContext = createContext<Navigation | null>(null);
export const NavigationProvider = NavigationContext.Provider;

/**
 * Opens the navigation drawer. Shown only on narrow screens (styles.css), where a screen that renders it in its header
 * replaces the shell's own mobile header, so the header isn't stacked twice. Renders nothing outside the app shell.
 */
export function NavigationButton() {
  const navigation = useContext(NavigationContext);
  if (!navigation) return null;
  return <Button variant="ghost" size="sm" icon="menu" className="nav-button" aria-label="Open navigation" aria-expanded={navigation.expanded} onClick={navigation.open} />;
}
