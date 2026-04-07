#!/usr/bin/env node
// auth.mjs — one-time GramJS login. Run once: node auth.mjs

import { TelegramClient } from "telegram";
import { StringSession }  from "telegram/sessions/index.js";
import readline           from "readline";
import fs                 from "fs";
import path               from "path";
import { fileURLToPath }  from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.join(__dirname, "config.json");
const SES = path.join(__dirname, "session.txt");

function loadConfig() {
  if (!fs.existsSync(CFG)) { console.error(`config.json not found. Run setup.mjs first.`); process.exit(1); }
  return JSON.parse(fs.readFileSync(CFG, "utf8"));
}

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(res => rl.question(q, a => { rl.close(); res(a.trim()); }));
}

function askHidden(q) {
  return new Promise(res => {
    process.stdout.write(q);
    let s = "";
    const h = b => {
      const ch = b.toString();
      if (ch === "\r" || ch === "\n") { process.stdin.setRawMode?.(false); process.stdin.removeListener("data", h); process.stdout.write("\n"); res(s); }
      else if (ch === "\x7f") { if (s.length) { s = s.slice(0,-1); process.stdout.write("\b \b"); } }
      else { s += ch; process.stdout.write("*"); }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", h);
  });
}

async function main() {
  const cfg = loadConfig();
  console.log("\n🦞 openclaw-tguser — Telegram login\n");
  const session = new StringSession(fs.existsSync(SES) ? fs.readFileSync(SES, "utf8").trim() : "");
  const client  = new TelegramClient(session, cfg.apiId, cfg.apiHash, { connectionRetries: 5 });
  await client.start({
    phoneNumber: () => ask("Phone number (e.g. +353861234567): "),
    phoneCode:   () => ask("Code from Telegram app: "),
    password:    () => askHidden("2FA password (blank if none): "),
    onError:     e  => console.error("Error:", e.message),
  });
  const me = await client.getMe();
  fs.writeFileSync(SES, session.save(), "utf8");
  console.log(`\n✅ Logged in as @${me.username ?? me.firstName ?? me.id}`);
  console.log(`   Session saved: ${SES}`);
  console.log("\nStart the bridge:\n  node bridge.mjs\n");
  await client.disconnect();
}

main().catch(e => { console.error("Auth failed:", e.message); process.exit(1); });
