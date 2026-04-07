#!/usr/bin/env node
// =============================================================================
// setup.mjs — openclaw-tguser setup  (v4 — agent agnostic, workspace-native)
//
// Works with any agent. Inbox/outbox go inside the agent's workspace so
// the read/write file tools work with zero extra configuration.
//
// Usage:
//   node setup.mjs                    # uses default workspace
//   node setup.mjs --agent lana       # targets a specific named agent
//   node setup.mjs --skip-auth        # skip login (do it later)
//   node setup.mjs --skip-pm2         # don't start pm2
// =============================================================================

import fs           from "fs";
import path         from "path";
import os           from "os";
import readline     from "readline";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath }       from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const b = s => `\x1b[1m${s}\x1b[0m`;
const g = s => `\x1b[32m${s}\x1b[0m`;
const y = s => `\x1b[33m${s}\x1b[0m`;
const c = s => `\x1b[36m${s}\x1b[0m`;
const d = s => `\x1b[2m${s}\x1b[0m`;
const r = s => `\x1b[31m${s}\x1b[0m`;

const args     = process.argv.slice(2);
const skipAuth = args.includes("--skip-auth");
const skipPm2  = args.includes("--skip-pm2");
const getArg   = f => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; };
const agentId  = getArg("--agent");

const HOME       = os.homedir();
const OC_DIR     = process.env.OPENCLAW_CONFIG_PATH
  ? path.dirname(process.env.OPENCLAW_CONFIG_PATH)
  : path.join(HOME, ".openclaw");
const OC_CFG     = path.join(OC_DIR, "openclaw.json");
const BRIDGE_DIR = path.join(OC_DIR, "tguser-bridge"); // bridge process files only
const CFG_PATH   = path.join(BRIDGE_DIR, "config.json");
const BRIDGE_SRC = path.join(__dirname, "bridge");
const SKILL_SRC  = path.join(__dirname, "skill", "SKILL.md");

// ── Find workspace ────────────────────────────────────────────────────────

function findWorkspace() {
  // Named agent
  if (agentId) {
    // Try reading it from openclaw.json
    if (fs.existsSync(OC_CFG)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(OC_CFG, "utf8"));
        const entry = (cfg.agents?.list ?? []).find(a => a.id === agentId);
        if (entry?.workspace) return path.resolve(entry.workspace.replace(/^~/, HOME));
      } catch {}
    }
    // Fall back to conventional path
    return path.join(OC_DIR, "agents", agentId, "workspace");
  }
  // Default workspace
  const def = path.join(OC_DIR, "workspace");
  if (fs.existsSync(def)) return def;
  // First agent found
  const agentsDir = path.join(OC_DIR, "agents");
  if (fs.existsSync(agentsDir)) {
    const first = fs.readdirSync(agentsDir)
      .find(a => fs.statSync(path.join(agentsDir, a)).isDirectory());
    if (first) return path.join(agentsDir, first, "workspace");
  }
  return def;
}

// ── Find openclaw binary ──────────────────────────────────────────────────

function findOpenclaw() {
  const candidates = [
    "/usr/local/bin/openclaw", "/usr/bin/openclaw",
    path.join(HOME, ".npm-global", "bin", "openclaw"),
    path.join(HOME, ".local", "bin", "openclaw"),
    "/opt/homebrew/bin/openclaw",
  ];
  if (process.env.NVM_DIR) candidates.push(
    path.join(process.env.NVM_DIR, "versions", "node", `v${process.version.slice(1)}`, "bin", "openclaw")
  );
  for (const p of candidates) if (fs.existsSync(p)) return p;
  try { const r = execSync("which openclaw", { encoding:"utf8" }).trim(); if (r) return r; } catch {}
  return null;
}

// ── Patch openclaw.json ───────────────────────────────────────────────────
// Only two settings needed:
//   heartbeat.target = "last" — heartbeat results are delivered to last channel
//   heartbeat.every  = "2m"  — agent checks inbox every 2 minutes

function patchOpenclawJson(openclawBin) {
  if (!fs.existsSync(OC_CFG)) {
    console.log(y(`  ⚠  openclaw.json not found at ${OC_CFG}`));
    console.log(y('     Add manually: agents.defaults.heartbeat.target = "last"'));
    console.log(y('                   agents.defaults.heartbeat.every  = "2m"'));
    return;
  }

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(OC_CFG, "utf8")); }
  catch { console.log(y("  ⚠  Cannot parse openclaw.json")); return; }

  let changed = false;
  const hb = agentId
    ? (() => {
        cfg.agents        ??= {};
        cfg.agents.list   ??= [];
        let e = cfg.agents.list.find(a => a.id === agentId);
        if (!e) { e = { id: agentId }; cfg.agents.list.push(e); }
        e.heartbeat ??= {};
        return e.heartbeat;
      })()
    : (() => {
        cfg.agents                    ??= {};
        cfg.agents.defaults           ??= {};
        cfg.agents.defaults.heartbeat ??= {};
        return cfg.agents.defaults.heartbeat;
      })();

  if (hb.target !== "last") { hb.target = "last"; changed = true; console.log(g('  ✓  heartbeat.target = "last"')); }
  if (!hb.every)            { hb.every  = "2m";   changed = true; console.log(g('  ✓  heartbeat.every  = "2m"')); }

  if (changed) {
    fs.writeFileSync(OC_CFG, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    if (openclawBin) {
      try { execSync(`"${openclawBin}" gateway restart`, { stdio:"ignore", timeout:10000 }); console.log(g("  ✓  Gateway restarted")); }
      catch { console.log(y("  ⚠  Run manually: openclaw gateway restart")); }
    }
  } else {
    console.log(g("  ✓  openclaw.json already correctly configured"));
  }
}

// ── HEARTBEAT.md ──────────────────────────────────────────────────────────

function ensureHeartbeatMd(ws) {
  const p = path.join(ws, "HEARTBEAT.md");
  const block = `
## Telegram inbox (tguser)
- List conversations: read tguser-inbox/
- For each .json file: read it, compose reply in persona, write to the replyFilePath shown in the file
- If tguser-inbox/ is empty or has no .json files: nothing to do here
`;
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, `# Heartbeat\n\nCheck Telegram inbox and reply to any messages.\n${block}`, "utf8");
    console.log(g("  ✓  HEARTBEAT.md created"));
  } else {
    const existing = fs.readFileSync(p, "utf8");
    if (!existing.includes("tguser")) {
      fs.appendFileSync(p, block);
      console.log(g("  ✓  tguser task added to HEARTBEAT.md"));
    } else {
      console.log(d("     HEARTBEAT.md already has tguser block"));
    }
    // Prevent effectively-empty file (would cause system event skips)
    if (existing.replace(/#.*$/gm, "").replace(/\s/g, "").length === 0) {
      fs.appendFileSync(p, "\nCheck Telegram inbox.\n");
    }
  }
}

// ── Prompts ───────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q, def = "") {
  return new Promise(res => rl.question(`  ${q}${def ? d(` [${def}]`) : ""}: `, a => res(a.trim() || def)));
}
function askSecret(q) {
  return new Promise(res => {
    process.stdout.write(`  ${q}: `);
    let s = "";
    const h = b => {
      const ch = b.toString();
      if (ch==="\r"||ch==="\n") { process.stdin.setRawMode?.(false); process.stdin.removeListener("data",h); process.stdout.write("\n"); res(s); }
      else if (ch==="\x7f") { if(s.length){s=s.slice(0,-1);process.stdout.write("\b \b");} }
      else { s+=ch; process.stdout.write("*"); }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.on("data", h);
  });
}
function askChoice(q, choices, def) {
  return ask(`${q} (${choices.map(x => x===def ? b(x) : x).join(" / ")})`, def);
}
function run(cmd, silent=false) { try { execSync(cmd, { stdio: silent?"pipe":"inherit" }); return true; } catch { return false; } }
function hasBin(bin) { return run(`which ${bin}`, true); }

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(c("  ╔════════════════════════════════════════════════════╗"));
  console.log(c("  ║") + b("   openclaw-tguser  ·  Setup v4                  ") + c("║"));
  console.log(c("  ║") + d("   Any agent · Any Telegram user account         ") + c("║"));
  console.log(c("  ╚════════════════════════════════════════════════════╝"));
  console.log();

  const workspace = findWorkspace();
  console.log(d(`  Target: ${agentId ? `agent "${agentId}"` : "default agent"}`));
  console.log(d(`  Workspace: ${workspace}\n`));

  // 1. Credentials
  console.log(b("  1 / 5  Telegram API Credentials"));
  console.log(d("         https://my.telegram.org → API development tools\n"));
  const apiIdStr = await ask("API ID (integer)");
  if (!apiIdStr || isNaN(Number(apiIdStr))) { console.error(r("  ✗  API ID must be a number.")); process.exit(1); }
  const apiHash = await askSecret("API Hash");
  if (!apiHash || apiHash.length < 10) { console.error(r("  ✗  API Hash looks wrong.")); process.exit(1); }

  // 2. Policies
  console.log(); console.log(b("  2 / 5  Access Policies\n"));
  const dmPolicy = await askChoice("DM policy", ["pairing","allowlist","open","closed"], "pairing");
  let allowFrom = [];
  if (dmPolicy==="allowlist"||dmPolicy==="pairing") {
    const raw = await ask("Pre-approved @usernames or IDs (comma-separated, blank for none)", "");
    allowFrom = raw.split(",").map(s=>s.trim()).filter(Boolean);
  }
  const groupPolicy = await askChoice("Group policy", ["mention","open","closed"], "mention");

  // 3. Behaviour
  console.log(); console.log(b("  3 / 5  Behaviour\n"));
  const contextMessages = parseInt(await ask("History messages per conversation", "30"), 10);
  const chunkSize       = parseInt(await ask("Max chars per Telegram message", "4096"), 10);
  const readDelay       = parseInt(await ask("Read-receipt delay ms", "1200"), 10);

  // 4. Install
  console.log(); console.log(b("  4 / 5  Installing\n"));

  const openclawBin = findOpenclaw();
  console.log(openclawBin ? g(`  ✓  openclaw: ${openclawBin}`) : y("  ⚠  openclaw not found — patch openclaw.json manually after setup"));

  // Bridge dirs (process files only — not workspace)
  for (const dir of [BRIDGE_DIR, path.join(BRIDGE_DIR,"context"), path.join(BRIDGE_DIR,"logs")]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Workspace inbox/outbox — inside workspace so file tools work
  fs.mkdirSync(path.join(workspace, "tguser-inbox"),  { recursive: true });
  fs.mkdirSync(path.join(workspace, "tguser-outbox"), { recursive: true });
  console.log(g(`  ✓  tguser-inbox/  created in workspace`));
  console.log(g(`  ✓  tguser-outbox/ created in workspace`));

  // Write config — includes workspaceDir so bridge knows where to write files
  const config = {
    apiId:           Number(apiIdStr),
    apiHash,
    bridgeDir:       BRIDGE_DIR,
    workspaceDir:    workspace,   // critical — tells bridge where inbox/outbox are
    dmPolicy,
    allowFrom,
    groupPolicy,
    contextMessages: contextMessages || 30,
    chunkSize:       chunkSize       || 4096,
    readDelay:       readDelay       || 1200,
    selfRespond:     false,
  };
  fs.writeFileSync(CFG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
  console.log(g(`  ✓  Config: ${CFG_PATH}`));

  // Copy bridge files
  for (const f of ["bridge.mjs","auth.mjs","package.json"]) {
    const src = path.join(BRIDGE_SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(BRIDGE_DIR, f));
    else console.warn(y(`  ⚠  Missing: bridge/${f}`));
  }
  console.log(g(`  ✓  Bridge → ${BRIDGE_DIR}`));

  run(`cd "${BRIDGE_DIR}" && npm install --silent`)
    ? console.log(g("  ✓  Dependencies installed"))
    : console.log(y(`  ⚠  npm install failed — run: cd ${BRIDGE_DIR} && npm install`));

  // Install skill
  fs.mkdirSync(path.join(workspace, "skills", "tguser"), { recursive: true });
  if (fs.existsSync(SKILL_SRC)) {
    fs.copyFileSync(SKILL_SRC, path.join(workspace, "skills", "tguser", "SKILL.md"));
    console.log(g(`  ✓  Skill → ${workspace}/skills/tguser/SKILL.md`));
  } else {
    console.log(y("  ⚠  skill/SKILL.md not found — copy manually"));
  }

  ensureHeartbeatMd(workspace);
  patchOpenclawJson(openclawBin);

  // 5. Auth + start
  console.log(); console.log(b("  5 / 5  Authentication & Start\n"));

  if (!skipAuth) {
    console.log(d("     Starting Telegram login…\n"));
    const res = spawnSync("node", [path.join(BRIDGE_DIR, "auth.mjs")], { stdio:"inherit", cwd:BRIDGE_DIR });
    if (res.status !== 0) console.log(y(`\n  ⚠  Auth incomplete. Run: node ${BRIDGE_DIR}/auth.mjs`));
  } else {
    console.log(y(`  --skip-auth. Run when ready: node ${BRIDGE_DIR}/auth.mjs`));
  }

  if (!skipPm2) {
    if (hasBin("pm2")) {
      run(`pm2 delete openclaw-tguser 2>/dev/null; true`, true);
      run(`pm2 start "${BRIDGE_DIR}/bridge.mjs" --name openclaw-tguser --restart-delay=3000`);
      run("pm2 save");
      console.log(g("  ✓  Bridge running under pm2"));
      console.log(d("     Survive reboots: pm2 startup  (then run the command it prints)"));
    } else {
      console.log(y("  pm2 not installed:"));
      console.log(c("     npm install -g pm2"));
      console.log(c(`     pm2 start "${BRIDGE_DIR}/bridge.mjs" --name openclaw-tguser --restart-delay=3000`));
      console.log(c("     pm2 save && pm2 startup"));
    }
  } else {
    console.log(y(`  --skip-pm2. Start: pm2 start "${BRIDGE_DIR}/bridge.mjs" --name openclaw-tguser`));
  }

  console.log();
  console.log(g("  ✅  Setup complete!\n"));
  console.log(d("  How it works:"));
  console.log(d("  • Someone messages the Telegram account"));
  console.log(d(`  • Bridge writes to ${workspace}/tguser-inbox/`));
  console.log(d("  • Agent reads it during heartbeat (every 2 min)"));
  console.log(d(`  • Agent writes reply to ${workspace}/tguser-outbox/`));
  console.log(d("  • Bridge sends it via Telegram within 1 second"));
  console.log();
  console.log(d("  Reference:"));
  console.log(`  ${c("pm2 logs openclaw-tguser")}                ← bridge logs`);
  console.log(`  ${c("pm2 restart openclaw-tguser")}             ← restart after config change`);
  console.log(`  ${c(`node ${BRIDGE_DIR}/auth.mjs`)}     ← re-authenticate`);
  console.log(`  ${c(`ls ${workspace}/tguser-inbox/`)}   ← pending messages`);
  console.log();

  rl.close();
}

main().catch(e => { console.error(r("  ✗"), e.message); rl.close(); process.exit(1); });
