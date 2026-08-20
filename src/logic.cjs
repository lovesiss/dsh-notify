/* dsh-notify · pure notification logic (shared by the browser half and unit tests).
 * No browser globals, no dependencies. The bottom of this file exposes the object
 * to Node's CommonJS loader for tests; inside the built bundle it is inert.
 *
 * Notification policy — exactly three kinds, at most one per turn:
 *   1. approval/requested  → immediate "需要你的批准"
 *   2. question/requested  → immediate "AI 在等你回答"
 *   3. turn completed      → one notice settled at the grace deadline, carrying
 *      the latest text preview (generic fallback when the turn had no text)
 *
 * Mid-turn assistant messages never notify directly: each text message only
 * updates the buffered preview, and the turn is settled ONCE when
 * host/session-status flips to running:false (plus a grace window, because the
 * live stream delivers the final assistant/message a few ms AFTER the flip). */
const NotifyLogic = {
  defaultConfig() {
    return {
      enabled: true,
      os: true,
      toast: false,
      cooldownMs: 1500,
      toastMs: 5000
    };
  },

  readConfig(storage) {
    const defaults = this.defaultConfig();
    if (!storage) return defaults;
    try {
      const raw = storage.getItem("dsh-notify/config");
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return defaults;
      return { ...defaults, ...parsed };
    } catch {
      return defaults;
    }
  },

  writeConfig(storage, patch) {
    if (!storage) return null;
    const next = { ...this.readConfig(storage), ...patch };
    try {
      storage.setItem("dsh-notify/config", JSON.stringify(next));
    } catch {
      return null;
    }
    return next;
  },

  truncate(text, limit) {
    const value = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return value.length <= limit ? value : value.slice(0, limit - 1) + "…";
  },

  /* First visible lines of an assistant message: first non-empty text block,
   * per-line whitespace collapsed, at most two lines, capped at `limit` chars. */
  extractPreview(event, limit) {
    const cap = limit || 140;
    const message = event && event.data && event.data.message;
    const content = message && Array.isArray(message.content) ? message.content : [];
    let raw = "";
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        raw = block.text;
        break;
      }
    }
    if (!raw) return "";
    const lines = raw.split("\n")
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" ");
    if (!lines) return "";
    return lines.length <= cap ? lines : lines.slice(0, cap - 1) + "…";
  },

  /* Map one wire frame to an immediate notification or null.
   * Frames verified against @deepseek-ai/dsh-host-apiproxy (events.mux). */
  classifyFrame(frame) {
    if (!frame || typeof frame !== "object") return null;
    const type = frame.type;
    if (type === "question/requested") {
      const first = Array.isArray(frame.questions) ? frame.questions[0] : null;
      const text = first && typeof first === "object"
        ? first.question || first.header || first.id || ""
        : "";
      return {
        kind: "question",
        sessionId: frame.sessionId,
        title: "AI 在等你回答",
        body: this.truncate(text, 120)
      };
    }
    if (type === "approval/requested") {
      const body = this.truncate(frame.reason || frame.toolName || frame.tool || frame.label || "", 120);
      return {
        kind: "approval",
        sessionId: frame.sessionId,
        title: "需要你的批准",
        body
      };
    }
    return null;
  },

  /* The buffered preview for a session/event assistant/message, or null.
   * Never dispatched directly — the turn is settled once at the grace deadline. */
  textPreview(frame) {
    if (!frame || frame.type !== "session/event") return null;
    const event = frame.event;
    if (!event || event.type !== "assistant/message") return null;
    const preview = this.extractPreview(event);
    if (!preview) return null;
    return {
      kind: "answer",
      sessionId: frame.sessionId,
      title: "AI 已回复",
      body: preview
    };
  },

  /* host/session-status is stateful and edge-triggered:
   * - running:true opens a turn → the buffered preview is cleared;
   * - running:false after a running edge → arm a grace deadline instead of
   *   notifying: settleTurn emits the ONE turn-completed notice (latest text
   *   preview, or the generic fallback) only once the grace elapsed. */
  FALLBACK_GRACE_MS: 800,

  onSessionStatus(state, sessionId, running, now) {
    if (running == null) return null;
    const key = String(sessionId);
    const previous = state.running.get(key);
    state.running.set(key, Boolean(running));
    if (running === true) {
      if (state.preview) state.preview.delete(key);
      if (state.fallbackAt) state.fallbackAt.delete(key);
      return null;
    }
    if (previous !== true) return null;
    if (!state.fallbackAt) state.fallbackAt = new Map();
    state.fallbackAt.set(key, (now == null ? Date.now() : now) + NotifyLogic.FALLBACK_GRACE_MS);
    return null;
  },

  /* Emit the single turn-completed notice once the grace period elapsed:
   * latest text preview if the turn produced one, generic fallback otherwise.
   * A turn that paused waiting for input (question/approval dispatched within
   * the grace window) is NOT a completion and stays silent. The deadline is
   * consumed on the first call (idempotent). */
  settleTurn(state, sessionId, now) {
    const key = String(sessionId);
    const at = now == null ? Date.now() : now;
    const due = state.fallbackAt && state.fallbackAt.get(key);
    if (due == null || due > at) return null;
    state.fallbackAt.delete(key);
    const paused = state.pauseAt && state.pauseAt.get(key);
    if (state.pauseAt) state.pauseAt.delete(key);
    if (paused != null && at - paused <= NotifyLogic.FALLBACK_GRACE_MS + 500) {
      return null; // the turn ended waiting for input, not "done"
    }
    const preview = state.preview && state.preview.get(key);
    if (state.preview) state.preview.delete(key);
    if (preview) return preview;
    return {
      kind: "answer",
      sessionId,
      title: "AI 已回复",
      body: "打开页面查看结果"
    };
  },

  /* Per-kind + per-session cooldown: frame storms cost one notification. */
  withinCooldown(state, notice, config) {
    if (!notice) return true;
    const now = Date.now();
    const key = notice.kind + ":" + (notice.sessionId == null ? "" : notice.sessionId);
    const last = state.last.get(key);
    if (last != null && now - last < (config.cooldownMs ?? 0)) return true;
    state.last.set(key, now);
    return false;
  },

  /* Shared tail for every dispatch path (immediate frames and the settled
   * turn-completed notice): enabled gate + per-kind/session cooldown. */
  gate(state, config, notice) {
    if (!notice) return null;
    if (config.enabled !== true) return null;
    if (this.withinCooldown(state, notice, config)) return null;
    return notice;
  },

  /* One envelope from the connection observation tap:
   * { type: "server-request", rpcId, method, payload } → payload is the frame.
   * `now` is injectable for deterministic tests; the client omits it. */
  handleEnvelope(state, config, envelope, now) {
    if (!envelope || typeof envelope !== "object") return null;
    const frame = envelope.payload && envelope.payload.type ? envelope.payload : envelope;
    const type = frame && frame.type;
    if (!type) return null;
    const at = now == null ? Date.now() : now;
    const key = frame.sessionId == null ? "" : String(frame.sessionId);
    if (type === "host/session-status") {
      const notice = this.onSessionStatus(state, frame.sessionId, frame.running, at);
      return this.gate(state, config, notice);
    }
    if (type === "session/event") {
      /* Never notify per message: buffer the latest text preview and let the
       * grace deadline settle the turn exactly once. The deadline stays armed
       * — settleTurn picks the buffered preview up at expiry. */
      const preview = this.textPreview(frame);
      if (preview) {
        if (!state.preview) state.preview = new Map();
        state.preview.set(key, preview);
      }
      return null;
    }
    if (type === "question/requested" || type === "approval/requested") {
      if (!state.pauseAt) state.pauseAt = new Map();
      state.pauseAt.set(key, at);
      return this.gate(state, config, this.classifyFrame(frame));
    }
    return null;
  }
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { NotifyLogic };
}
