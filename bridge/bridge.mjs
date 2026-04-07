#!/usr/bin/env node
// =============================================================================
// bridge.mjs — GramJS ↔ OpenClaw bridge  (v4 — workspace-native)
//
// KEY DESIGN DECISION:
//   The inbox/ and outbox/ directories live INSIDE the agent's workspace,
//   not in ~/.openclaw/tguser-bridge/. This is because OpenClaw's read/write
//   file tools only work inside the workspace by default. Putting files
//   outside the workspace requires extra config that breaks out-of-the-box use.
//
// INBOUND (Telegram → agent):
//   Message arrives via GramJS NewMessage event
//   → Bridge writes: <workspace>/tguser-inbox/person_alice.json
//   → One file per conversation, overwrites on new message
//   → File contains the new message + last 30 messages of history
//   → Agent reads it with the read tool during heartbeat (always works,
//     no policy config needed, no sandbox issues)
//
// OUTBOUND (agent → Telegram):
//   Agent writes: <workspace>/tguser-outbox/person_alice.json
//   → Bridge polls every second, reads file, sends via GramJS, deletes file
//   → Agent uses write tool (always works inside workspace)
//
// CONTEXT:
//   Per-conversation history stored in: <bridgeDir>/context/
//   (bridge process dir, not workspace — agent doesn't need to read this)
// =============================================================================

import { TelegramClient } from "telegram";
import { StringSession }  from "telegram/sessions/index.js";
import { NewMessage }     from "telegram/events/index.js";
import { Api }            from "telegram";
import fs                 from "fs";
import path               from "path";
import os                 from "os";
import { fileURLToPath }  from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH  = path.join(__dirname, "config.json");
const SES_PATH  = path.join(__dirname, "session.txt");

// ── Config ────────────────────────────────────────────────────────────────

function loadConfig() {
  if (!fs.existsSync(CFG_PATH)) { log("FATAL", `config.json not found`); process.exit(1); }
  return JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
}

const cfg = loadConfig();

// Bridge's own data directory (session, context, logs — not agent workspace)
const BRIDGE_DIR  = cfg.bridgeDir ?? path.join(os.homedir(), ".openclaw", "tguser-bridge");
const CTX_DIR     = path.join(BRIDGE_DIR, "context");
const LOG_DIR     = path.join(BRIDGE_DIR, "logs");

// Inbox and outbox live INSIDE the agent workspace
const WORKSPACE   = cfg.workspaceDir; // set by setup.mjs, required
const INBOX_DIR   = path.join(WORKSPACE, "tguser-inbox");
const OUTBOX_DIR  = path.join(WORKSPACE, "tguser-outbox");

if (!WORKSPACE) { console.error("FATAL: workspaceDir not set in config.json. Run setup.mjs."); process.exit(1); }

for (const d of [BRIDGE_DIR, CTX_DIR, LOG_DIR, INBOX_DIR, OUTBOX_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// ── Logger ────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(LOG_DIR, `bridge-${new Date().toISOString().slice(0,10)}.log`);

function log(level, ...args) {
  const line = `[${new Date().toISOString()}] [${level.padEnd(5)}] ${args.join(" ")}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}
const L = {
  info:  (...a) => log("INFO",  ...a),
  warn:  (...a) => log("WARN",  ...a),
  error: (...a) => log("ERROR", ...a),
};

// ── Filename helpers ──────────────────────────────────────────────────────

function toFilename(sessionKey) {
  // person:alice → person_alice.json
  // group:-1001234 → group_-1001234.json
  return sessionKey.replace(/[:/\\]/g, "_") + ".json";
}

// ── Per-conversation context (stored in bridge dir, not workspace) ─────────

const MAX_HISTORY = cfg.contextMessages ?? 30;

function loadContext(sessionKey) {
  const f = path.join(CTX_DIR, toFilename(sessionKey));
  if (!fs.existsSync(f)) return { sessionKey, messages: [] };
  try { return JSON.parse(fs.readFileSync(f, "utf8")); }
  catch { return { sessionKey, messages: [] }; }
}

function saveContext(ctx) {
  if (ctx.messages.length > MAX_HISTORY) ctx.messages = ctx.messages.slice(-MAX_HISTORY);
  fs.writeFileSync(path.join(CTX_DIR, toFilename(ctx.sessionKey)), JSON.stringify(ctx, null, 2), "utf8");
}

function appendToContext(sessionKey, role, from, text, msgId) {
  const ctx = loadContext(sessionKey);
  ctx.messages.push({ role, from, text, msgId, ts: Date.now() });
  saveContext(ctx);
  return ctx;
}

// ── Policy ────────────────────────────────────────────────────────────────

const pairedPeers    = new Set();
const pendingPairing = new Map();

function norm(p) { return String(p).toLowerCase().replace(/^@/, ""); }
function inAllowlist(p) { return (cfg.allowFrom ?? []).some(a => norm(a) === norm(p)); }

function decideDm(peerId) {
  switch (cfg.dmPolicy ?? "pairing") {
    case "open":      return "allow";
    case "allowlist": return inAllowlist(peerId) ? "allow" : "deny";
    case "pairing":
      if (pairedPeers.has(norm(peerId)) || inAllowlist(peerId)) return "allow";
      return "needs-pairing";
    case "closed":    return "deny";
    default:          return "deny";
  }
}

function decideGroup(mentioned) {
  switch (cfg.groupPolicy ?? "mention") {
    case "open":    return true;
    case "mention": return mentioned;
    case "closed":  return false;
    default:        return false;
  }
}

async function sendPairingPrompt(peer, peerId) {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pendingPairing.set(norm(peerId), { code, expiry: Date.now() + 5 * 60 * 1000 });
  await client.sendMessage(peer, {
    message:   `👋 Hi! This account is managed by an AI.\n\nSend this code to start chatting:\n\n*${code}*\n\n_Expires in 5 minutes._`,
    parseMode: "markdown",
  });
  L.info(`Pairing prompt → ${peerId} (code: ${code})`);
}

// ── Inbound message handler ───────────────────────────────────────────────

async function handleInbound(event, myIdStr, myUsername) {
  const msg = event.message;
  if (msg.out && !(cfg.selfRespond ?? false)) return;
  const text = msg.message ?? "";
  if (!text && !msg.media) return;

  const sender    = await msg.getSender().catch(() => null);
  const peerId    = sender?.username ?? msg.senderId?.toString() ?? "unknown";
  const peerName  = sender?.firstName
    ? [sender.firstName, sender.lastName].filter(Boolean).join(" ")
    : (sender?.username ?? peerId);
  const chatId    = msg.chatId?.toString() ?? peerId;
  const isPrivate = !!event.isPrivate;
  const sKey      = isPrivate ? `person:${peerId}` : `group:${chatId}`;

  // DM policy
  if (isPrivate) {
    const decision = decideDm(peerId);
    if (decision === "deny") { L.info(`DM from ${peerId} denied`); return; }
    if (decision === "needs-pairing") {
      const pending = pendingPairing.get(norm(peerId));
      if (pending && Date.now() < pending.expiry && text.trim() === pending.code) {
        pairedPeers.add(norm(peerId));
        pendingPairing.delete(norm(peerId));
        await client.sendMessage(msg.chatId ?? peerId, { message: "✅ Paired! You can now chat." });
        L.info(`Peer ${peerId} paired`);
        return;
      }
      await sendPairingPrompt(msg.chatId ?? peerId, peerId);
      return;
    }
  }

  // Group policy
  if (!isPrivate) {
    let mentioned = false;
    if (msg.replyTo) {
      try {
        const replied = await msg.getReplyMessage();
        if (replied?.senderId?.toString() === myIdStr) mentioned = true;
      } catch {}
    }
    if (!mentioned) {
      for (const ent of (msg.entities ?? [])) {
        if (ent.className === "MessageEntityMentionName" && ent.userId?.toString() === myIdStr) { mentioned = true; break; }
        if (ent.className === "MessageEntityMention") {
          const h = text.slice(ent.offset, ent.offset + ent.length).replace(/^@/, "");
          if (h.toLowerCase() === myUsername.toLowerCase()) { mentioned = true; break; }
        }
      }
    }
    if (!decideGroup(mentioned)) return;
  }

  // Mark as read after a realistic delay — she saw it, double tick appears
  const peer = msg.chatId ?? peerId;
  setTimeout(async () => {
    try {
      await client.invoke(new Api.messages.ReadHistory({ peer, maxId: msg.id }));
    } catch {}
  }, 4000 + Math.floor(Math.random() * 8000)); // 4-12 seconds after receiving

  // Update context history
  const ctx = appendToContext(sKey, "user", peerName, text || "(media)", msg.id);
  const history = ctx.messages.slice(-20)
    .map(m => `[${m.role === "user" ? m.from : "Agent"}] ${m.text}`)
    .join("\n");

  // Write inbox file into agent workspace
  // Agent reads this with the read tool — always works, no policy config needed
  const inboxFile = path.join(INBOX_DIR, toFilename(sKey));

  // replyToId only used in groups (quoting makes sense there, not in DMs)
  const replyTemplate = isPrivate
    ? { peer: peerId, text: "WRITE_YOUR_REPLY_HERE", sessionKey: sKey }
    : { peer: chatId, text: "WRITE_YOUR_REPLY_HERE", replyToId: msg.id, sessionKey: sKey };

  const envelope = {
    sessionKey:  sKey,
    from:        peerId,
    fromName:    peerName,
    chatId,
    isPrivate,
    newMessage: {
      id:        msg.id,
      text:      text || null,
      hasMedia:  !!msg.media,
      replyToId: msg.replyTo?.replyToMsgId ?? null,
      date:      msg.date,
    },
    conversationHistory: history,
    // Exactly what the agent writes to tguser-outbox/ to reply
    replyTemplate,
    // Where to write the reply file (relative to workspace)
    replyFilePath: `tguser-outbox/${toFilename(sKey)}`,
    readMsgId:  msg.id,
    updatedAt: Date.now(),
  };

  fs.writeFileSync(inboxFile, JSON.stringify(envelope, null, 2), "utf8");
  L.info(`Inbox: tguser-inbox/${toFilename(sKey)}  from=${peerId}`);
}

// ── Outbox watcher ────────────────────────────────────────────────────────

function startOutboxWatcher() {
  L.info(`Watching outbox (workspace): ${OUTBOX_DIR}`);
  setInterval(async () => {
    let files;
    try { files = fs.readdirSync(OUTBOX_DIR).filter(f => f.endsWith(".json")).sort(); }
    catch { return; }

    for (const fname of files) {
      const fpath = path.join(OUTBOX_DIR, fname);
      let env;
      try {
        const raw = fs.readFileSync(fpath, "utf8");
        fs.unlinkSync(fpath);
        env = JSON.parse(raw);
      } catch { continue; }

      // Skip if agent hasn't replaced the template
      if (!env.peer || !env.text || env.text === "WRITE_YOUR_REPLY_HERE") {
        L.warn(`Skipping ${fname} — text not replaced`);
        continue;
      }

      try {
        // Show typing indicator briefly, then send
        try {
          await client.invoke(new Api.messages.SetTyping({
            peer: env.peer, action: new Api.SendMessageTypingAction(),
          }));
        } catch {}
        // Brief typing pause — she's a fast typer
        await new Promise(r => setTimeout(r, 1500 + Math.floor(Math.random() * 2000)));
        await sendOutbound(env);
        if (env.sessionKey) appendToContext(env.sessionKey, "assistant", "Agent", env.text, null);
      } catch (err) {
        L.error(`Send failed (${fname}): ${err.message}`);
        fs.writeFileSync(fpath.replace(".json", ".failed"), JSON.stringify({ error: err.message, env }, null, 2));
      }
    }
  }, 1000);
}

function splitText(text, max) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rem = text;
  while (rem.length > max) {
    let cut = max;
    while (cut > 0 && rem[cut] !== " " && rem[cut] !== "\n") cut--;
    if (cut === 0) cut = max;
    chunks.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).trimStart();
  }
  if (rem) chunks.push(rem);
  return chunks;
}

async function sendOutbound(env) {
  const { peer, text, filePath, caption, replyToId, parseMode } = env;
  if (!peer) { L.warn("Outbound missing peer"); return; }

  if (filePath) {
    L.info(`Sending file to ${peer}: ${filePath}`);
    await client.sendFile(peer, { file: filePath, caption: caption ?? text ?? "" });
    return;
  }

  if (!text) { L.warn("Outbound missing text"); return; }

  const chunks = splitText(text, cfg.chunkSize ?? 4096);
  for (let i = 0; i < chunks.length; i++) {
    try { await client.invoke(new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() })); } catch {}
    L.info(`Sending chunk ${i+1}/${chunks.length} to ${peer}`);
    await client.sendMessage(peer, {
      message:   chunks[i],
      replyTo:   i === 0 ? replyToId : undefined,
      parseMode: parseMode ?? "markdown",
    });
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 600));
  }
}

// ── GramJS client ─────────────────────────────────────────────────────────

if (!fs.existsSync(SES_PATH)) { L.error("session.txt not found. Run: node auth.mjs"); process.exit(1); }
const sessionStr = fs.readFileSync(SES_PATH, "utf8").trim();
if (!sessionStr) { L.error("session.txt is empty. Run: node auth.mjs"); process.exit(1); }

const session = new StringSession(sessionStr);
const client  = new TelegramClient(session, cfg.apiId, cfg.apiHash, {
  connectionRetries: 20,
  retryDelay:        3000,
  autoReconnect:     true,
});

process.on("SIGTERM", async () => { L.info("SIGTERM"); try { await client.disconnect(); } catch {} process.exit(0); });
process.on("SIGINT",  async () => { L.info("SIGINT");  try { await client.disconnect(); } catch {} process.exit(0); });
process.on("uncaughtException",  e => L.error("Uncaught:", e.message));
process.on("unhandledRejection", e => L.error("Unhandled:", e?.message ?? e));

async function main() {
  L.info("=== openclaw-tguser bridge v4 starting ===");
  L.info(`Workspace inbox:  ${INBOX_DIR}`);
  L.info(`Workspace outbox: ${OUTBOX_DIR}`);
  L.info(`Bridge data:      ${BRIDGE_DIR}`);
  L.info(`DM policy:    ${cfg.dmPolicy    ?? "pairing"}`);
  L.info(`Group policy: ${cfg.groupPolicy ?? "mention"}`);

  await client.connect();
  const me         = await client.getMe();
  const myIdStr    = me.id?.toString() ?? "0";
  const myUsername = me.username ?? "";
  L.info(`Connected as @${myUsername || myIdStr} (id: ${myIdStr})`);

  client.addEventHandler(
    event => handleInbound(event, myIdStr, myUsername).catch(e => L.error("Handler:", e.message)),
    new NewMessage({}),
  );

  startOutboxWatcher();
  L.info("Bridge ready.");
}

main().catch(e => { L.error("Startup failed:", e.message); process.exit(1); });
