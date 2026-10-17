import {
  startLiveSession as start, type LiveSession, type LiveSessionDependencies, type LiveSessionHandlers,
} from "../../../packages/client/src/live-session";
import { api } from "./api";

export { activeStatuses, type StreamStatus } from "../../../packages/client/src/live-session";

/** The browser's EventSource with the session cookie, paused while the tab is hidden. */
const browserLiveDependencies: LiveSessionDependencies = {
  api,
  openEvents: path => new EventSource(path, { withCredentials: true }),
  hidden: () => document.hidden,
  onVisibilityChange(listener) {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

export function startLiveSession(id: string, handlers: LiveSessionHandlers): LiveSession {
  return start(id, handlers, browserLiveDependencies);
}
