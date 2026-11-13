// The transport contract, and a WebSocket implementation of it.
//
// Deliberately small. There is no netcode in any of the three games yet, and
// building a prediction-and-rollback layer with nothing to test it against
// would be guesswork. What is here is the seam: a transport interface a game
// can code against, one implementation that talks to a Cloudflare Durable
// Object (Workers and Wrangler are already in the stack), and message framing.
//
// The order of work that pays off first is in `input-log.js`: replays and ghost
// runs need no server at all, and they exercise the same determinism that
// real-time sync will later depend on.

/**
 * @typedef {object} Transport
 * @property {() => Promise<void>} connect
 * @property {(message: any) => boolean} send
 * @property {() => void} close
 * @property {(listener: (message: any) => void) => () => void} onMessage
 * @property {(listener: (state: string) => void) => () => void} onStateChange
 * @property {"idle"|"connecting"|"open"|"closed"} state
 */

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;

/**
 * @param {object} [options]
 * @param {string} [options.url] Required in practice; the throw below is what
 *        enforces it, so the type stays optional to match the `= {}` default.
 * @param {string|string[]} [options.protocols]
 * @param {boolean} [options.reconnect]
 * @param {number} [options.maxRetries]
 * @param {typeof WebSocket} [options.WebSocketImpl] Swappable so a test can
 *        run both ends in memory rather than over a socket.
 * @param {typeof setTimeout} [options.setTimeoutImpl] Swappable so a test can
 *        exercise the backoff without waiting out fifteen seconds of it.
 */
export function createWebSocketTransport({
  url,
  protocols,
  reconnect = true,
  maxRetries = Infinity,
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutImpl = setTimeout,
} = {}) {
  if (!url) throw new Error("A WebSocket transport needs a url.");
  if (!WebSocketImpl) throw new Error("No WebSocket implementation is available.");

  const messageListeners = new Set();
  const stateListeners = new Set();
  let socket = null;
  let state = "idle";
  let retries = 0;
  let closedByUs = false;
  /** The in-flight connect(), so a second call joins it rather than racing it. */
  let pending = null;
  // Sends issued before the socket opens are queued rather than dropped, so a
  // caller does not have to sequence its own connect.
  let queue = [];

  function setState(next) {
    if (state === next) return;
    state = next;
    for (const listener of stateListeners) listener(state);
  }

  function flushQueue() {
    if (state !== "open" || !socket) return;
    const pending = queue;
    queue = [];
    for (const frame of pending) socket.send(frame);
  }

  function scheduleReconnect(resolve, reject) {
    if (!reconnect || closedByUs || retries >= maxRetries) {
      setState("closed");
      reject?.(new Error("The connection closed."));
      return;
    }
    // Exponential backoff with jitter, so a server restart does not bring every
    // client back in the same millisecond.
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** retries);
    retries += 1;
    setTimeoutImpl(() => { void open(resolve, reject); }, delay * (0.7 + Math.random() * 0.6));
  }

  function open(resolve, reject) {
    setState("connecting");
    socket = new WebSocketImpl(url, protocols);

    socket.onopen = () => {
      retries = 0;
      setState("open");
      flushQueue();
      resolve?.();
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      } catch {
        // A frame we cannot parse is the server's problem, not a reason to
        // tear down a working connection.
        return;
      }
      for (const listener of messageListeners) listener(message);
    };
    socket.onerror = () => {
      // `onclose` always follows, and that is where reconnection is handled.
    };
    socket.onclose = () => {
      socket = null;
      if (closedByUs) {
        setState("closed");
        return;
      }
      scheduleReconnect(resolve, reject);
    };
  }

  return {
    get state() { return state; },
    get retries() { return retries; },

    connect() {
      if (state === "open") return Promise.resolve();
      // An attempt already in flight is returned as-is. Opening a second socket
      // would orphan the first with its handlers still attached, and its
      // eventual close would start an independent reconnect chain.
      if (pending) return pending;
      closedByUs = false;
      pending = new Promise((resolve, reject) => open(resolve, reject))
        .finally(() => { pending = null; });
      return pending;
    },

    send(message) {
      const frame = typeof message === "string" ? message : JSON.stringify(message);
      if (state !== "open" || !socket) {
        queue.push(frame);
        return false;
      }
      socket.send(frame);
      return true;
    },

    close() {
      closedByUs = true;
      queue = [];
      // A reconnect chain never settles its promise, so an abandoned attempt
      // would otherwise be handed to the next connect() call.
      pending = null;
      socket?.close();
      socket = null;
      setState("closed");
    },

    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },

    onStateChange(listener) {
      stateListeners.add(listener);
      listener(state);
      return () => stateListeners.delete(listener);
    },
  };
}

/**
 * An in-memory transport pair. Useful for testing game code against the
 * interface without a server, and for local two-player on one machine.
 */
export function createLoopbackPair() {
  const make = () => {
    const messageListeners = new Set();
    const stateListeners = new Set();
    return {
      peer: null,
      state: "open",
      connect: () => Promise.resolve(),
      send(message) {
        // Deliver asynchronously: synchronous delivery would let a caller
        // observe an ordering that no real transport can provide.
        queueMicrotask(() => {
          for (const listener of this.peer.messageListeners) listener(message);
        });
        return true;
      },
      close() {
        this.state = "closed";
        for (const listener of stateListeners) listener("closed");
      },
      onMessage(listener) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      onStateChange(listener) {
        stateListeners.add(listener);
        listener(this.state);
        return () => stateListeners.delete(listener);
      },
      messageListeners,
    };
  };
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
