import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppDataProvider } from "../lib/app-data";
import { AuthProvider, useAuth } from "../lib/auth";
import { usePalette } from "../theme";

// The stored sign-in is checked before the first screen shows.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return <AuthProvider><Navigator /></AuthProvider>;
}

function Navigator() {
  const { state } = useAuth();
  const palette = usePalette();
  const signedIn = state.status === "signedIn";
  useEffect(() => {
    if (state.status !== "loading") SplashScreen.hide();
  }, [state.status]);
  if (state.status === "loading") return null;
  const base = palette.scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = { ...base, colors: { ...base.colors, background: palette.background, card: palette.surface, text: palette.text, border: palette.border, primary: palette.text } };
  const stack = <Stack screenOptions={{
    // Opaque headers keep the composer's keyboard offset equal to the header height on every iOS version.
    headerTransparent: false,
    headerStyle: { backgroundColor: palette.surface },
    headerTintColor: palette.text,
    contentStyle: { backgroundColor: palette.background },
  }}>
    <Stack.Protected guard={signedIn} redirectTo="/sign-in">
      <Stack.Screen name="index" options={{ title: "Sessions" }} />
      <Stack.Screen name="session/[id]" options={{ title: "Session" }} />
      <Stack.Screen name="new" options={{ title: "New session", presentation: "modal" }} />
      <Stack.Screen name="open-session" options={{ title: "Open a session", presentation: "modal" }} />
      <Stack.Screen name="settings" options={{ title: "Settings", presentation: "modal" }} />
    </Stack.Protected>
    <Stack.Protected guard={!signedIn} redirectTo="/">
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
    </Stack.Protected>
    <Stack.Screen name="auth" options={{ headerShown: false }} />
  </Stack>;
  return <ThemeProvider value={theme}>
    <StatusBar style="auto" />
    {/* Keyed by user so lists never carry over to another account. */}
    {signedIn ? <AppDataProvider key={`${state.origin} ${state.user.id}`}>{stack}</AppDataProvider> : stack}
  </ThemeProvider>;
}
