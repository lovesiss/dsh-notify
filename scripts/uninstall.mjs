#!/usr/bin/env node
/* dsh-notify · one-command global uninstaller (zero dependencies).
 *
 * Reverses scripts/install.mjs:
 *   1. removes this plugin's row from $DSH_HOME/cordis.patch.yml;
 *   2. removes the junction/symlink in $DSH_HOME/profiles/node_modules/<name>
 *      when (and only when) it points at this repository — a real npm-installed
 *      directory is left alone (uninstall it with npm instead).
 *
 * Idempotent; `--dry-run` prints the plan without touching the disk. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const dryRun = process.argv.includes("--dry-run");
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
const notes = [];

/* --- 1. module link ----------------------------------------------------- */
if (fs.existsSync(linkPath)) {
  const stat = fs.lstatSync(linkPath);
  if (stat.isSymbolicLink() && samePath(path.resolve(fs.realpathSync(linkPath)), pkgRoot)) {
    steps.push(`移除链接 ${linkPath}`);
  } else if (stat.isSymbolicLink()) {
    notes.push(`链接指向别处,不属于本包,跳过:${linkPath}`);
  } else {
    notes.push(`该位置是 npm 真装的目录,请用 npm 卸载,跳过:${linkPath}`);
  }
} else {
  notes.push(`模块链接不存在,无需处理:${linkPath}`);
}

/* --- 2. global patch row ------------------------------------------------ */
const namePattern = new RegExp(`name:\\s*['"]?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]?`);
if (!fs.existsSync(patchPath)) {
  notes.push(`补丁文件不存在,无需处理:${patchPath}`);
} else {
  const lines = fs.readFileSync(patchPath, "utf8").split(/\r?\n/);
  let rowFound = false;
  const kept = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*- insert:\s*$/.test(line)) {
      let j = i + 1;
      let hasName = false;
      while (j < lines.length && (lines[j].trim() === "" || /^\s/.test(lines[j]))) {
        if (namePattern.test(lines[j])) hasName = true;
        j++;
      }
      if (hasName) {
        rowFound = true;
        i = j; // drop the whole insert block
        continue;
      }
    }
    kept.push(line);
    i++;
  }
  if (rowFound) {
    steps.push(`从 ${patchPath} 移除本插件行`);
    if (dryRun) {
      console.log("[dsh-notify] dry-run(不写盘):");
      for (const line of notes) console.log("  · " + line);
      for (const line of steps) console.log("  → " + line);
      process.exit(0);
    }
    fs.writeFileSync(patchPath, kept.join("\n").replace(/^\s*\n+/, "").replace(/\s+$/, "\n"));
  } else {
    notes.push(`补丁文件中没有本插件行,无需处理:${patchPath}`);
  }
}

if (dryRun) {
  console.log("[dsh-notify] dry-run(不写盘):");
  for (const line of notes) console.log("  · " + line);
  for (const line of steps) console.log("  → " + line);
  process.exit(0);
}

for (const line of steps) {
  console.log("[dsh-notify] " + line);
  if (line.startsWith("移除链接")) {
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
}
for (const line of notes) console.log("[dsh-notify] " + line);
console.log("[dsh-notify] ✔ 完成。重启 dsh web 后插件即被移除。");
