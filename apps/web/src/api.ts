import { createApi } from "../../../packages/client/src/api";

export { ApiError, errorMessage, segment } from "../../../packages/client/src/api";

/** The browser app's API: same-origin requests with the session cookie and a CSRF token for every change. */
export const api = createApi({ auth: "cookie" });
