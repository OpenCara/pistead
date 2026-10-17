/** The page's own markup defines every id these scripts use; a missing one is a build mistake, not a runtime state. */
export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}

/** Avoids needless DOM writes on the frequent re-renders a live host causes. */
export function setText(target: HTMLElement, text: string): void {
  if (target.textContent !== text) target.textContent = text;
}
