/* dsh-notify · browser half (inside the ModuleLoader factory).
 * Depends on: ctx.connection (injected), NotifyLogic (concatenated before this file). */
const VERSION = "0.2.0";

let toastRoot = null;
let toastStyle = null;

/* Rolling decision journal for remote debugging: the user pastes
 * __dshNotify.journal and every pipeline stage becomes visible. */
const journal = [];
function journalize(entry) {
  journal.push(entry);
  while (journal.length > 120) journal.shift();
}

function ensureToastRoot() {
  if (toastRoot) return toastRoot;
  toastStyle = document.createElement("style");
  toastStyle.id = "dsh-notify-style";
  toastStyle.textContent = [
    "#dsh-notify-root{position:fixed;right:20px;bottom:20px;z-index:2147483000;",
    "display:flex;flex-direction:column;gap:10px;max-width:400px;pointer-events:none}",
    ".dsh-notify-toast{pointer-events:auto;background:#f7f9fc;color:#1a2233;",
    "border:1px solid #d3dae6;border-radius:12px;padding:14px 18px;",
    "box-shadow:0 10px 32px rgba(15,23,42,.18);font:14px/1.5 system-ui,sans-serif;",
    "cursor:pointer;opacity:.98}",
    ".dsh-notify-toast b{display:block;margin-bottom:4px;font-size:14px}",
    ".dsh-notify-toast span{color:#5b6474;word-break:break-all}",
    "@media (prefers-color-scheme: dark){",
    ".dsh-notify-toast{background:#202634;color:#e9edf5;border-color:#3b4559;",
    "box-shadow:0 10px 32px rgba(0,0,0,.45)}",
    ".dsh-notify-toast span{color:#aab4c8}}"
  ].join("");
  document.head.appendChild(toastStyle);
  toastRoot = document.createElement("div");
  toastRoot.id = "dsh-notify-root";
  document.body.appendChild(toastRoot);
  return toastRoot;
}

function showToast(notice, config) {
  const root = ensureToastRoot();
  const el = document.createElement("div");
  el.className = "dsh-notify-toast";
  const title = document.createElement("b");
  title.textContent = notice.title;
  const body = document.createElement("span");
  body.textContent = notice.body || "";
  el.appendChild(title);
  if (notice.body) el.appendChild(body);
  el.addEventListener("click", () => {
    try { window.focus(); } catch { /* ignore */ }
    el.remove();
  });
  root.appendChild(el);
  while (root.children.length > 3) root.firstChild.remove();
  const duration = config.toastMs ?? 5000;
  setTimeout(() => el.remove(), duration);
}

/* React is provided by the shell's module table (seed word "react"), the same
 * way every shipped UI plugin consumes it. Captured once at factory scope. */
let React = null;
try {
  React = require("react");
} catch { /* shell without React: card stays off, notifications still work */ }

/* The settings card registered into the native Plugins section
 * (settings.plugins.tab → settings.plugin.item). Failure to register
 * degrades to console-only configuration; notifications are unaffected. */
function registerSettingsCard(ctx, storage, configHolder) {
  if (!React) return;
  const slots = ctx.get("slots");
  if (!slots) return;
  const { useState, createElement: h } = React;

  function NotifyCard() {
    const [cfg, setCfg] = useState(configHolder.get());
    const update = (patch) => {
      const next = configHolder.set(patch);
      setCfg(next);
    };
    const row = (label, key, hint) => h("label", {
      style: {
        display: "flex", alignItems: "center", gap: "8px",
        fontSize: "13px", cursor: "pointer", padding: "2px 0"
      }
    },
      h("input", {
        type: "checkbox",
        checked: Boolean(cfg[key]),
        onChange: (event) => update({ [key]: event.target.checked })
      }),
      h("span", null, label),
      hint ? h("span", { style: { color: "#8b93a7", fontSize: "12px" } }, hint) : null
    );
    return h("div", {
      style: { display: "flex", flexDirection: "column", gap: "6px", padding: "4px 0" }
    },
      row("通知总开关", "enabled", "关闭后立即停止一切通知"),
      row("系统通知", "os", "切走页面/看其他会话时弹系统通知"),
      row("页面内 Toast", "toast", "页面在前台时右下角弹窗(默认关)"),
      h("button", {
        onClick: () => {
          if (window.__dshNotify) window.__dshNotify.test();
          setCfg({ ...configHolder.get() });
        },
        style: {
          marginTop: "4px", padding: "6px 12px", cursor: "pointer",
          alignSelf: "flex-start"
        }
      }, "发送测试通知"),
      h("div", { style: { color: "#8b93a7", fontSize: "12px", marginTop: "2px" } },
        "触发:需要批准 / 等你回答 / 整轮回复完毕(每轮仅一条);提示音随系统通知"),
      h("div", { style: { color: "#8b93a7", fontSize: "12px" } },
        "版本 " + VERSION + " · 系统通知权限:" +
        (typeof Notification === "undefined" ? "不支持" : Notification.permission) +
        " · 页面:" + (document.hidden ? "后台" : "前台") + " · 最近帧:" + (window.__dshNotify ? window.__dshNotify.samples.length : 0)
      )
    );
  }

  slots.register({
    name: "settings.plugins.tab",
    id: "notify",
    label: "通知 (dsh-notify)",
    order: 900
  }, NotifyCard);
}

/* Toasts rendered while the tab is hidden expire unseen (toastMs), so keep the
 * newest few and replay them when the user returns. This also covers Windows
 * Focus Assist silently swallowing the OS toast during fullscreen video. */
let pendingToasts = [];
const PENDING_MAX = 3;
const PENDING_TTL_MS = 60000;

function flushPendingToasts() {
  if (document.hidden || pendingToasts.length === 0) return;
  const current = NotifyLogic.readConfig(window.localStorage);
  if (current.toast === false) {
    pendingToasts = [];
    return;
  }
  const now = Date.now();
  const replay = pendingToasts.filter((item) => now - item.at <= PENDING_TTL_MS);
  pendingToasts = [];
  for (const item of replay) showToast(item.notice, current);
}

/* Two independent channels, never mutually exclusive:
 * - OS notification: fires when the user cannot see the result — the page is
 *   hidden/unfocused (away) OR the notice belongs to a session that is not the
 *   one currently being viewed. `renotify: true` makes every event re-alert
 *   instead of Chrome silently replacing the previous one (same tag). No
 *   `silent` flag: the system plays its own notification sound.
 * - In-page toast: fires immediately when the tab is visible and `toast` is
 *   enabled; when the tab is hidden the notice is queued instead and replayed
 *   on return. With `toast` disabled the queue stays empty and the OS
 *   notification is the only channel. */
function dispatch(notice, config, viewing) {
  const pageHidden = document.hidden === true;
  const away = pageHidden || !document.hasFocus();
  const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
  const needOS = away || viewing !== true;
  let osFired = false;
  if (needOS && config.os && granted) {
    try {
      new Notification(notice.title, {
        body: notice.body || "",
        tag: "dsh-notify",
        renotify: true
      });
      osFired = true;
    } catch { /* blocked: the pending toast still covers the return */ }
  }
  journalize({
    at: Date.now(),
    action: "dispatch",
    kind: notice.kind,
    body: String(notice.body || "").slice(0, 60),
    pageHidden,
    away,
    viewing: viewing === true,
    osAttempt: needOS && config.os && granted,
    osFired
  });
  if (!config.toast) return;
  if (pageHidden) {
    pendingToasts.push({ notice, at: Date.now() });
    while (pendingToasts.length > PENDING_MAX) pendingToasts.shift();
  } else {
    showToast(notice, config);
  }
}

/* One timer per session for the deferred turn-completed notice (see
 * NotifyLogic.FALLBACK_GRACE_MS); the latest text preview, when it arrives
 * within the grace window, replaces the generic ping via settleTurn. */
const fallbackTimers = new Map();
function scheduleFallback(state, storage, sessionId) {
  const key = String(sessionId);
  const existing = fallbackTimers.get(key);
  if (existing) clearTimeout(existing);
  journalize({ at: Date.now(), action: "fallback-armed", sid: key });
  const timer = setTimeout(() => {
    fallbackTimers.delete(key);
    const current = NotifyLogic.readConfig(storage);
    const raw = NotifyLogic.settleTurn(state, sessionId, Date.now());
    const notice = NotifyLogic.gate(state, current, raw);
    if (notice) {
      const viewing = typeof sessionId === "string" && sessionId === state.currentSession;
      dispatch(notice, current, viewing);
    } else {
      journalize({
        at: Date.now(),
        action: "fallback-dropped",
        sid: key,
        reason: raw ? "cooldown-or-disabled" : "no-text-or-paused"
      });
    }
  }, NotifyLogic.FALLBACK_GRACE_MS + 50);
  fallbackTimers.set(key, timer);
}

function apply(ctx) {
  const connection = ctx.connection;
  const storage = typeof window !== "undefined" ? window.localStorage : null;
  let config = NotifyLogic.readConfig(storage);
  const state = { running: new Map(), last: new Map(), currentSession: null };
  const samples = [];
  const configHolder = {
    get: () => config,
    set: (patch) => {
      const next = NotifyLogic.writeConfig(storage, patch);
      if (next) config = next;
      return { ...config };
    }
  };

  /* The Notification API only grants permission inside a user gesture. */
  const requestPermission = () => {
    if (!config.os) return;
    if (typeof Notification === "undefined" || Notification.permission !== "default") return;
    try { void Notification.requestPermission(); } catch { /* ignore */ }
  };
  const onGesture = () => requestPermission();
  document.addEventListener("pointerdown", onGesture);

  const onVisible = () => flushPendingToasts();
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", onVisible);

  const unsubscribe = connection.api.subscribeEnvelopes((batch) => {
    config = NotifyLogic.readConfig(storage);
    for (const envelope of batch) {
      const frame = envelope && envelope.payload && envelope.payload.type ? envelope.payload : envelope;
      samples.push({
        at: Date.now(),
        type: frame && frame.type,
        running: frame && typeof frame.running === "boolean" ? frame.running : undefined,
        sessionId: frame ? frame.sessionId : undefined
      });
      while (samples.length > 50) samples.shift();
      /* Track the session the user is currently working in: the last one they
       * prompted or whose history the UI pulled into view. This lets approvals
       * and completions of OTHER sessions notify even while this page has
       * focus. */
      if (envelope && envelope.type === "client-request" &&
        (envelope.method === "session.prompt" || envelope.method === "session.history") &&
        envelope.payload && envelope.payload.sessionId != null) {
        state.currentSession = String(envelope.payload.sessionId);
        journalize({ at: Date.now(), action: "view-track", sid: state.currentSession });
      }
      const eventType = frame && frame.event && frame.event.type;
      if (frame && (frame.type === "host/session-status" ||
        frame.type === "question/requested" || frame.type === "approval/requested" ||
        (frame.type === "session/event" && (eventType === "assistant/message" ||
          eventType === "turn/start" || eventType === "turn/end")))) {
        journalize({
          at: Date.now(),
          action: "frame",
          type: frame.type,
          event: eventType,
          running: frame.running,
          sid: frame.sessionId
        });
      }
      if (config.enabled !== true) continue;
      const notice = NotifyLogic.handleEnvelope(state, config, envelope);
      if (notice) {
        const viewing = typeof notice.sessionId === "string" && notice.sessionId === state.currentSession;
        dispatch(notice, config, viewing);
      }
      if (frame && frame.type === "host/session-status" && frame.running === false) {
        scheduleFallback(state, storage, frame.sessionId);
      }
    }
  });

  if (typeof window !== "undefined") {
    window.__dshNotify = {
      version: VERSION,
      samples,
      journal,
      getConfig: () => ({ ...config }),
      setConfig: (patch) => configHolder.set(patch),
      /* The test fires BOTH channels unconditionally: the in-page toast (when
       * enabled) and the OS notification (when enabled and granted) — this is
       * the only deterministic way to test the background/OS path from the
       * settings page. */
      test: () => {
        const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
        const notice = {
          kind: "question",
          sessionId: undefined,
          title: "dsh-notify 测试",
          body: "链路正常 · " + VERSION + " · 系统权限:" +
            (typeof Notification === "undefined" ? "不支持" : Notification.permission)
        };
        if (config.toast) showToast(notice, config);
        if (config.os && granted) {
          try {
            new Notification(notice.title, {
              body: notice.body,
              tag: "dsh-notify-test",
              renotify: true
            });
          } catch { /* ignored */ }
        }
      }
    };
  }

  try {
    registerSettingsCard(ctx, storage, configHolder);
  } catch (error) {
    console.error("[dsh-notify] settings card failed, notifications still active:", error);
  }

  return () => {
    unsubscribe();
    for (const timer of fallbackTimers.values()) clearTimeout(timer);
    fallbackTimers.clear();
    document.removeEventListener("pointerdown", onGesture);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    pendingToasts = [];
    if (typeof window !== "undefined") delete window.__dshNotify;
    journal.length = 0;
    if (toastRoot) toastRoot.remove();
    if (toastStyle) toastStyle.remove();
    toastRoot = null;
    toastStyle = null;
  };
}

const plugin = { inject: ["connection"], apply };
return plugin;
