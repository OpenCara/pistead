import { ApiError, createApi, errorMessage, type Api, type RequestOptions } from "@pistead/client";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import * as SecureStore from "expo-secure-store";
import * as WebBrowser from "expo-web-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UserProfile } from "../../../../packages/shared/src/types";
import { createPkce } from "./pkce";
import { DEFAULT_ORIGIN } from "./server";

const TOKEN_KEY = "pistead.token";
const EXPIRES_KEY = "pistead.tokenExpires";
/** The server is a preference, not a credential: it stays after sign-out so signing in again goes to the same place. */
const ORIGIN_KEY = "pistead.origin";
/** The server redirects here after GitHub (see the native sign-in API); the app registers the `pistead` scheme. */
const CALLBACK_URL = "pistead://auth";

export type AuthState =
  | { status: "loading" }
  /** `notice` explains why the app signed out on its own, or what the last sign-out could not do. */
  | { status: "signedOut"; origin: string; notice?: string }
  /** A stored sign-in whose server could not be reached at launch; nothing is known about the user yet. */
  | { status: "unreachable"; origin: string; error: string }
  | { status: "signedIn"; origin: string; token: string; expiresAt: string | null; user: UserProfile; api: Api };

interface AuthContextValue {
  state: AuthState;
  signInWithGitHub(origin: string): Promise<void>;
  /** Development builds only: a token from a test-mode server's POST /api/auth/test. */
  signInWithToken(origin: string, token: string): Promise<void>;
  signOut(): Promise<void>;
  retry(): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}

/** The signed-in state; only screens behind the signed-in guard call it. */
export function useSession(): Extract<AuthState, { status: "signedIn" }> {
  const { state } = useAuth();
  if (state.status !== "signedIn") throw new Error("useSession needs a signed-in user");
  return state;
}

async function clearCredentials() {
  await Promise.all([SecureStore.deleteItemAsync(TOKEN_KEY), SecureStore.deleteItemAsync(EXPIRES_KEY)]);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  // The token whose 401 may sign out: an answer to an older token's request must not end a newer sign-in.
  const tokenRef = useRef<string | null>(null);

  const expire = useCallback((token: string) => {
    if (tokenRef.current !== token) return;
    tokenRef.current = null;
    void clearCredentials();
    setState(current => current.status === "signedIn" && current.token === token
      ? { status: "signedOut", origin: current.origin, notice: "Your sign-in expired or was revoked. Sign in again to continue." }
      : current);
  }, []);

  /** An API client for `token`; any 401 answer means the token is gone, so the app signs out. */
  const bearerApi = useCallback((origin: string, token: string): Api => {
    const inner = createApi({ baseUrl: origin, auth: () => token });
    return async function api<T>(path: string, options?: RequestOptions): Promise<T> {
      try {
        return await inner<T>(path, options);
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 401) expire(token);
        throw reason;
      }
    };
  }, [expire]);

  /** Confirms the token with /api/me, then stores it and signs in. */
  const establish = useCallback(async (origin: string, token: string, expiresAt: string | null, user?: UserProfile) => {
    const api = bearerApi(origin, token);
    tokenRef.current = token;
    let profile = user;
    try {
      profile ??= (await api<{ user: UserProfile }>("/api/me")).user;
    } catch (reason) {
      if (tokenRef.current === token) tokenRef.current = null;
      throw reason;
    }
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, token),
      SecureStore.setItemAsync(ORIGIN_KEY, origin),
      expiresAt ? SecureStore.setItemAsync(EXPIRES_KEY, expiresAt) : SecureStore.deleteItemAsync(EXPIRES_KEY),
    ]);
    setState({ status: "signedIn", origin, token, expiresAt, user: profile, api });
  }, [bearerApi]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [storedOrigin, token, expiresAt] = await Promise.all([
        SecureStore.getItemAsync(ORIGIN_KEY), SecureStore.getItemAsync(TOKEN_KEY), SecureStore.getItemAsync(EXPIRES_KEY),
      ]);
      const origin = storedOrigin ?? DEFAULT_ORIGIN;
      if (cancelled) return;
      if (!token) return setState({ status: "signedOut", origin });
      try {
        await establish(origin, token, expiresAt);
      } catch (reason) {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 401) {
          await clearCredentials();
          setState({ status: "signedOut", origin, notice: "Your sign-in expired or was revoked. Sign in again to continue." });
        } else {
          setState({ status: "unreachable", origin, error: errorMessage(reason) });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [establish, revision]);

  const signInWithGitHub = useCallback(async (origin: string) => {
    const health = await createApi({ baseUrl: origin, auth: () => null })<{ githubConfigured?: boolean }>("/api/health");
    if (health.githubConfigured === false) {
      throw new Error("GitHub sign-in is not configured on this server. The operator needs to configure the GitHub OAuth app and the server's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and VAULT_KEY settings.");
    }
    const { verifier, challenge, state } = await createPkce();
    const result = await WebBrowser.openAuthSessionAsync(
      `${origin}/api/auth/native/start?challenge=${challenge}&state=${state}`, CALLBACK_URL);
    // Cancelled or dismissed: nothing to report.
    if (result.type !== "success") return;
    const params = Linking.parse(result.url).queryParams ?? {};
    // A callback for another attempt (or forged by another app) must never complete this one.
    if (firstParam(params.state) !== state) throw new Error("The sign-in response did not match this attempt. Try again.");
    const error = firstParam(params.error);
    if (error) throw new Error(`GitHub sign-in did not complete: ${error.slice(0, 300)}`);
    const code = firstParam(params.code);
    if (!code) throw new Error("The server did not return a sign-in code. Try again.");
    const deviceName = Device.deviceName ?? Device.modelName ?? undefined;
    const exchange = await createApi({ baseUrl: origin, auth: () => null })<{ token: string; expiresAt: string; user: UserProfile }>(
      "/api/auth/native/token", { method: "POST", body: { code, verifier, ...(deviceName ? { deviceName } : {}) } });
    await establish(origin, exchange.token, exchange.expiresAt, exchange.user);
  }, [establish]);

  const signInWithToken = useCallback(async (origin: string, token: string) => {
    if (!__DEV__) throw new Error("Developer sign-in is only available in development builds.");
    await establish(origin, token.trim(), null);
  }, [establish]);

  const signOut = useCallback(async () => {
    if (state.status !== "signedIn" && state.status !== "unreachable") return;
    const origin = state.origin;
    let notice: string | undefined;
    let logout: (() => Promise<unknown>) | null = null;
    if (state.status === "signedIn") {
      tokenRef.current = null;
      logout = () => state.api("/api/auth/logout", { method: "POST" });
    } else {
      // Nothing is known about this sign-in but its stored token; the server may be back by now. A server that still
      // doesn't answer must not hold up signing out on this device.
      const token = await SecureStore.getItemAsync(TOKEN_KEY);
      if (token) logout = async () => {
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), 10_000);
        try {
          await createApi({ baseUrl: origin, auth: () => token })("/api/auth/logout", { method: "POST", signal: timeout.signal });
        } finally {
          clearTimeout(timer);
        }
      };
    }
    if (logout) {
      try {
        await logout();
      } catch (reason) {
        // Signing out must work offline; the sign-in stays valid on the server until revoked there.
        if (!(reason instanceof ApiError && reason.status === 401)) {
          notice = `Signed out on this device, but the server could not revoke the sign-in (${errorMessage(reason)}). Revoke it under Settings › Profile on the web.`;
        }
      }
    }
    await clearCredentials();
    setState({ status: "signedOut", origin, notice });
  }, [state]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setRevision(value => value + 1);
  }, []);

  const value = useMemo(() => ({ state, signInWithGitHub, signInWithToken, signOut, retry }), [state, signInWithGitHub, signInWithToken, signOut, retry]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
