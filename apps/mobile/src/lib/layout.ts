import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Keyboard, Platform, useWindowDimensions } from "react-native";

/** iPad (and a wide split-screen window) shows the session list beside the open session; phones stack them. */
export function useWideLayout(): boolean {
  return useWindowDimensions().width >= 700;
}

/** Whether the software keyboard is up; the composer drops its home-indicator inset then, as the keyboard covers it. */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    // iOS announces the keyboard before it moves, so the inset changes with the animation; Android only after.
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setVisible(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return visible;
}

/** Opens a session from the list or another session: beside the list in the wide layout, otherwise pushed on the stack. */
export function useOpenSession(): (id: string) => void {
  const router = useRouter();
  const wide = useWideLayout();
  return useCallback((id: string) => {
    if (wide) router.setParams({ session: id });
    else router.push({ pathname: "/session/[id]", params: { id } });
  }, [router, wide]);
}

/**
 * Opens a session from a modal screen (new session, open by ID): in the wide layout it closes the modal and shows the
 * session beside the list; otherwise the session replaces the modal in the stack.
 */
export function useOpenSessionFromModal(): (id: string) => void {
  const router = useRouter();
  const wide = useWideLayout();
  return useCallback((id: string) => {
    if (wide) router.dismissTo({ pathname: "/", params: { session: id } });
    else router.replace({ pathname: "/session/[id]", params: { id } });
  }, [router, wide]);
}
