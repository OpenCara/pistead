import { Redirect } from "expo-router";

/**
 * pistead://auth is the native sign-in callback. The browser session hands it to the sign-in code directly; where the
 * system also opens it as a deep link (Android delivers it to the app), the router lands here and goes home.
 */
export default function AuthCallback() {
  return <Redirect href="/" />;
}
