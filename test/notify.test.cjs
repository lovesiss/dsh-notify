/* dsh-notify · unit tests for the pure notification logic (node --test). */
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { NotifyLogic } = require("../src/logic.cjs");

const cfg = NotifyLogic.defaultConfig();
const noCooldown = { ...cfg, cooldownMs: 0 };
const GRACE = NotifyLogic.FALLBACK_GRACE_MS;
const freshState = () => ({ running: new Map(), last: new Map() });
const status = (state, sessionId, running, at) => NotifyLogic.handleEnvelope(
  state, noCooldown, { payload: { type: "host/session-status", sessionId, running } }, at
);
const text = (state, sessionId, at, content) => NotifyLogic.handleEnvelope(state, noCooldown, {
  payload: {
    type: "session/event",
    sessionId,
    event: { type: "assistant/message", data: { message: { role: "assistant", content } } }
  }
}, at);
const settle = (state, sessionId, at) => NotifyLogic.settleTurn(state, sessionId, at);

test("question/requested → immediate notice with body truncation", () => {
  const state = freshState();
  const envelope = {
    type: "server-request",
    rpcId: "r1",
    method: "question/requested",
    payload: {
      type: "question/requested",
      sessionId: "s1",
      questions: [{ id: "q1", question: "确认生成吗?" + "长".repeat(200) }]
    }
  };
  const notice = NotifyLogic.handleEnvelope(state, cfg, envelope);
  assert.equal(notice.kind, "question");
  assert.equal(notice.sessionId, "s1");
  assert.equal(notice.title, "AI 在等你回答");
  assert.ok(notice.body.length <= 121, "body is truncated");
  assert.ok(notice.body.endsWith("…"), "truncation marker present");
});

test("approval/requested → immediate notice (reason preferred, toolName fallback)", () => {
  const withReason = NotifyLogic.handleEnvelope(freshState(), cfg, {
    payload: { type: "approval/requested", sessionId: "s2", toolName: "write_file", reason: "写文件需要授权" }
  });
  assert.equal(withReason.kind, "approval");
  assert.equal(withReason.title, "需要你的批准");
  assert.equal(withReason.body, "写文件需要授权");

  const bare = NotifyLogic.handleEnvelope(freshState(), cfg, {
    payload: { type: "approval/requested", sessionId: "s2", toolName: "write_file" }
  });
  assert.equal(bare.body, "write_file");
});

test("host/session-status: running true→false arms a deferred turn settlement", () => {
  const state = freshState();
  assert.equal(status(state, "s4", false, 1000), null, "initial idle is silent");
  assert.equal(status(state, "s4", true, 1000), null, "running start is silent");
  assert.equal(status(state, "s4", true, 1000), null, "repeated running is silent");
  assert.equal(status(state, "s4", false, 1000), null, "turn end only arms, no immediate ping");
  assert.equal(settle(state, "s4", 1000 + GRACE - 1), null, "before the grace window: still silent");
  const notice = settle(state, "s4", 1000 + GRACE);
  assert.equal(notice.kind, "answer");
  assert.equal(notice.body, "打开页面查看结果");
  assert.equal(settle(state, "s4", 1000 + GRACE + 1), null, "deadline consumed once");
  assert.equal(status(state, "s4", false, 2000), null, "idle replay is silent");
});

test("assistant/message with text never notifies per message; settle returns the preview", () => {
  const state = freshState();
  assert.equal(status(state, "s9", true, 1000), null);
  assert.equal(text(state, "s9", 1500, [
    { type: "thinking", text: "思考过程,不应出现在预览里" },
    { type: "text", text: "第一行结论。\n  第二行补充说明。\n第三行不应出现。   " }
  ]), null, "mid-turn text only buffers, never dispatches");
  assert.equal(status(state, "s9", false, 2000), null);
  const notice = settle(state, "s9", 2000 + GRACE);
  assert.equal(notice.kind, "answer");
  assert.equal(notice.title, "AI 已回复");
  assert.equal(notice.body, "第一行结论。 第二行补充说明。");
});

test("assistant/message without text leaves the generic settlement armed", () => {
  const state = freshState();
  assert.equal(status(state, "s10", true, 1000), null);
  assert.equal(text(state, "s10", 1500, [{ type: "tool-call" }]), null);
  assert.equal(status(state, "s10", false, 2000), null);
  const generic = settle(state, "s10", 2000 + GRACE);
  assert.equal(generic.kind, "answer");
  assert.equal(generic.body, "打开页面查看结果");
});

test("text answer trailing running:false wins the settlement (live ordering)", () => {
  const state = freshState();
  assert.equal(status(state, "s11", true, 1000), null);
  assert.equal(status(state, "s11", false, 2000), null, "turn end arms the settlement");
  // the live stream delivers the final message ~12ms AFTER running:false
  assert.equal(text(state, "s11", 2012, [{ type: "text", text: "有文本回复" }]), null);
  const notice = settle(state, "s11", 2000 + GRACE);
  assert.equal(notice.kind, "answer");
  assert.equal(notice.body, "有文本回复");
  // next turn re-arms
  assert.equal(status(state, "s11", true, 3000), null);
  assert.equal(status(state, "s11", false, 4000), null);
  const again = settle(state, "s11", 4000 + GRACE);
  assert.equal(again.kind, "answer", "settlement re-armed for the next turn");
});

test("multiple text messages in one turn: the latest preview wins", () => {
  const state = freshState();
  assert.equal(status(state, "s13", true, 1000), null);
  assert.equal(text(state, "s13", 1100, [{ type: "text", text: "中间小结" }]), null);
  assert.equal(text(state, "s13", 1800, [{ type: "text", text: "最终完整回答" }]), null);
  assert.equal(status(state, "s13", false, 2000), null);
  const notice = settle(state, "s13", 2000 + GRACE);
  assert.equal(notice.body, "最终完整回答");
});

test("turn paused by a question/approval is not a completion", () => {
  const state = freshState();
  assert.equal(status(state, "s14", true, 1000), null);
  const question = NotifyLogic.handleEnvelope(state, noCooldown, {
    payload: { type: "question/requested", sessionId: "s14", questions: [{ id: "q", question: "选哪个?" }] }
  }, 1900);
  assert.equal(question.kind, "question", "the question itself notifies immediately");
  assert.equal(status(state, "s14", false, 2000), null, "turn ends right after asking");
  assert.equal(settle(state, "s14", 2000 + GRACE), null, "paused turn is not a completion");
  // a much later turn-end is a genuine completion again
  assert.equal(status(state, "s14", true, 4000), null);
  assert.equal(status(state, "s14", false, 6000), null);
  const done = settle(state, "s14", 6000 + GRACE);
  assert.equal(done.kind, "answer");
  assert.equal(done.body, "打开页面查看结果");
});

test("gate: disabled config suppresses the deferred settlement too", () => {
  const state = freshState();
  const disabled = { ...cfg, enabled: false };
  NotifyLogic.handleEnvelope(state, disabled, { payload: { type: "host/session-status", sessionId: "s12", running: true } }, 1000);
  NotifyLogic.handleEnvelope(state, disabled, { payload: { type: "host/session-status", sessionId: "s12", running: false } }, 1000);
  const raw = settle(state, "s12", 1000 + GRACE);
  assert.ok(raw, "raw settlement exists");
  assert.equal(NotifyLogic.gate(state, disabled, raw), null, "enabled gate applies");
});

test("cooldown: frame storms cost one notification per kind+session", () => {
  const state = freshState();
  const env = { payload: { type: "approval/requested", sessionId: "s5" } };
  const first = NotifyLogic.handleEnvelope(state, cfg, env);
  assert.ok(first);
  const second = NotifyLogic.handleEnvelope(state, cfg, env);
  assert.equal(second, null, "second frame within cooldown is suppressed");
});

test("disabled config suppresses everything", () => {
  const disabled = { ...cfg, enabled: false };
  const env = { payload: { type: "question/requested", sessionId: "s6", questions: [{ id: "q", question: "?" }] } };
  assert.equal(NotifyLogic.handleEnvelope(freshState(), disabled, env), null);
});

test("unknown frames are ignored (incl. removed error trigger)", () => {
  const state = freshState();
  assert.equal(NotifyLogic.handleEnvelope(state, cfg, { payload: { type: "session/queue", sessionId: "s7", items: [] } }), null);
  assert.equal(NotifyLogic.handleEnvelope(state, cfg, null), null);
  assert.equal(NotifyLogic.handleEnvelope(state, cfg, { payload: { type: "host/session-status", sessionId: "s8" } }), null);
  assert.equal(NotifyLogic.handleEnvelope(state, cfg, { payload: { type: "host/agent-error", sessionId: "s8", message: "boom" } }), null);
});

test("package shape: host half imports and applies without side effects", async () => {
  const host = await import("../lib/index.js");
  assert.ok(host.default && typeof host.default.apply === "function", "host half exports an apply");
  host.default.apply({}, {});
});

test("config: toast defaults off, corrupt values fall back", () => {
  const storage = {
    data: new Map(),
    getItem(key) { return this.data.has(key) ? this.data.get(key) : null; },
    setItem(key, value) { this.data.set(key, String(value)); }
  };
  assert.equal(NotifyLogic.readConfig(null).toast, false, "toast is off by default");
  assert.deepEqual(NotifyLogic.readConfig(storage), NotifyLogic.defaultConfig());
  storage.setItem("dsh-notify/config", "{broken json");
  assert.deepEqual(NotifyLogic.readConfig(storage), NotifyLogic.defaultConfig());
  const next = NotifyLogic.writeConfig(storage, { toast: true, toastMs: 8000 });
  assert.equal(next.toast, true);
  assert.equal(next.toastMs, 8000);
  assert.equal(next.enabled, true, "defaults preserved");
  assert.equal(NotifyLogic.readConfig(storage).toast, true, "persisted");
});
