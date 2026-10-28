// The IPC channel of a process a desktop app runs (the connector host, the local server): Electron's utilityProcess
// parentPort, or Node's fork channel in tests. Messages are structured-cloned objects, validated by the receiver.

export interface Transport<Event> {
  send(event: Event): void;
  onMessage(listener: (value: unknown) => void): void;
  onClose(listener: () => void): void;
}

/** Electron's utilityProcess `process.parentPort`. */
interface ParentPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
}

export function parentTransport<Event>(): Transport<Event> {
  const candidate = "parentPort" in process ? process.parentPort : undefined;
  if (candidate && typeof candidate === "object" && "postMessage" in candidate && "on" in candidate) {
    // Shape checked above; Electron documents postMessage and on("message") with MessageEvent-like { data }.
    const port = candidate as ParentPort;
    // Electron tears a utility process down with its parent, so only Node's channel reports a close.
    return { send: event => port.postMessage(event), onMessage: listener => port.on("message", event => listener(event.data)), onClose: () => {} };
  }
  const send = process.send?.bind(process);
  if (!send) throw new Error("This process must be started by the Pistead app");
  return {
    send: event => { if (process.connected) send(event); },
    onMessage: listener => process.on("message", listener),
    onClose: listener => process.once("disconnect", listener),
  };
}
