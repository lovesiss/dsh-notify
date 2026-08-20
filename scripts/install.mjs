#!/usr/bin/env node
/* dsh-notify · one-command global installer (zero dependencies).
 *
 * Makes the plugin plug-and-play for users who cloned the repository:
 *   1. links this package into $DSH_HOME/profiles/node_modules/<pkg-name>
 *      (a junction on Windows, a directory symlink elsewhere — no admin rights);
 *   2. ensures the plugin row exists in $DSH_HOME/cordis.patch.yml.
 *
 * Both steps are idempotent: running it twice is a no-op. `--dry-run` prints
 * the plan without touching the disk. `--force` replaces a conflicting link.
 *
 * The plugin row id/name follow package.json; the row id is "notify". If your
 * deployment already uses that id, edit PLUGIN_ROW_ID below once. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_ROW_ID = "notify";
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const pkgRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
const name = pkg.name;

const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const linkPath = path.join(home, "profiles", "node_modules", name);
const patchPath = path.join(home, "cordis.patch.yml");

const samePath = (a, b) => (process.platform === "win32"
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

const steps = [];
const info = [];
let exitHint = "";

/* --- 1. module link ----------------------------------------------------- */
if (!fs.existsSync(path.join(pkgRoot, "lib", "client.js"))) {
  console.error("[dsh-notify] lib/client.js is missing — run `npm run build` first.");
  process.exit(1);
}

let linkStep = null;
if (fs.existsSync(linkPath)) {
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink()) {
    const real = fs.realpathSync(linkPath);
    if (samePath(path.resolve(real), pkgRoot)) {
      info.push(`模块链接已存在且指向本仓库:${linkPath}`);
    } else {
      linkStep = `替换链接 ${linkPath} → 当前指向 ${real}(目标 ${pkgRoot})`;
      if (!force) exitHint = "链接指向别处,确认无误后加 --force 覆盖";
    }
  } else {
    const meta = path.join(linkPath, "package.json");
    if (fs.existsSync(meta)) {
      try {
        const installed = JSON.parse(fs.readFileSync(meta, "utf8"));
        if (installed.name === name) {
          info.push(`已通过 npm 真装在该位置:${linkPath}(跳过链接,只补补丁行)`);
        } else {
          linkStep = `该位置是另一个包 ${installed.name},需 --force 替换`;
        }
      } catch {
        linkStep = `该位置已有目录但 package.json 无法读取,需 --force 替换`;
      }
    } else {
      linkStep = `该位置已有普通目录(非本包),需 --force 替换`;
    }
  }
} else {
  linkStep = `创建 ${process.platform === "win32" ? "junction" : "目录符号链接"} ${linkPath} → ${pkgRoot}`;
}
if (linkStep) steps.push(linkStep);

/* --- 2. global patch row ------------------------------------------------ */
let patchStep = null;
if (!fs.existsSync(patchPath)) {
  patchStep = `创建 ${patchPath} 并写入插件行(- insert: id: ${PLUGIN_ROW_ID} / name: '${name}')`;
} else {
  const text = fs.readFileSync(patchPath, "utf8");
  if (new RegExp(`name:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?`).test(text)) {
    info.push(`补丁行已存在:${patchPath}`);
  } else {
    patchStep = `向 ${patchPath} 追加插件行(- insert: id: ${PLUGIN_ROW_ID} / name: '${name}')`;
  }
}
if (patchStep) steps.push(patchStep);

/* --- execute ------------------------------------------------------------ */
if (dryRun) {
  console.log("[dsh-notify] dry-run(不写盘):");
  for (const line of info) console.log("  · " + line);
  for (const line of steps) console.log("  → " + line);
  if (exitHint) console.log("  ⚠ " + exitHint);
  process.exit(0);
}
if (exitHint) {
  console.error("[dsh-notify] " + exitHint);
  process.exit(1);
}

for (const line of steps) {
  console.log("[dsh-notify] " + line);
  if (line.startsWith("创建")) {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    fs.symlinkSync(pkgRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
  } else if (line.startsWith("替换")) {
    fs.rmSync(linkPath, { recursive: true, force: true });
    fs.symlinkSync(pkgRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
  } else if (line.startsWith("向")) {
    const block = `- insert:\n    - id: ${PLUGIN_ROW_ID}\n      name: '${name}'\n`;
    const existing = fs.readFileSync(patchPath, "utf8");
    fs.writeFileSync(patchPath, existing.replace(/\s*$/, "\n") + "\n" + block);
  } else if (line.startsWith("创建 " + patchPath)) {
    fs.mkdirSync(path.dirname(patchPath), { recursive: true });
    fs.writeFileSync(patchPath,
      "# Machine-level patch layer ($DSH_HOME/cordis.patch.yml).\n" +
      "# Applied to EVERY profile on this machine, after each profile's own cordis.patch.yml.\n" +
      `- insert:\n    - id: ${PLUGIN_ROW_ID}\n      name: '${name}'\n`);
  }
}

console.log("[dsh-notify] ✔ 完成。生效方式:");
console.log("  1. 重启 DSH:在启动 dsh web 的终端里 Ctrl+C 后重新执行(改补丁行必须重启);");
console.log("  2. 若 DSH 已在运行且之前已装过本插件(仅更新代码):浏览器 Ctrl+F5 即可,无需重启。");
