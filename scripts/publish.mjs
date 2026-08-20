/* dsh-notify · one-click GitHub publish.
 * Requires the GitHub CLI (https://cli.github.com) and `gh auth login`.
 * Flow: ensure repo exists → commit everything → push main → tag v<version> →
 *       npm pack → create a GitHub Release with the tarball attached.
 * Run from the repo root: node scripts/publish.mjs [--private] [--repo owner/name]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const tag = `v${version}`;

const args = process.argv.slice(2);
const privateFlag = args.includes("--private");
const repoArgIndex = args.indexOf("--repo");
const repoArg = repoArgIndex >= 0 ? args[repoArgIndex + 1] : null;
/* A scoped npm name (@scope/pkg) is not a valid GitHub repo name; the
 * repository lives under the GitHub account (lovesiss/dsh-notify). */
const repoName = repoArg || "lovesiss/dsh-notify";

function run(command, options = {}) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: options.cwd || root,
    stdio: options.quiet ? "pipe" : "inherit",
    shell: false
  });
  if (result.status !== 0) {
    console.error(`✗ ${command.join(" ")} exited with ${result.status}`);
    process.exit(result.status == null ? 1 : result.status);
  }
  return result;
}

function runCaptured(command) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    console.error(`✗ ${command.join(" ")} exited with ${result.status}`);
    process.exit(result.status == null ? 1 : result.status);
  }
  return result.stdout.trim();
}

console.log(`dsh-notify publish · ${repoName} @ ${tag}`);

const ghStatus = spawnSync("gh", ["auth", "status"], { stdio: "ignore" });
if (ghStatus.status !== 0) {
  console.error("✗ gh CLI 未安装或未登录,请先: gh auth login");
  process.exit(1);
}

/* 1. git repo: init if needed, commit everything on main. */
if (!existsSync(join(root, ".git"))) {
  run(["git", "init", "-b", "main"]);
  console.log("· initialized git repository");
}
const dirty = runCaptured(["git", "status", "--porcelain"]);
if (dirty) {
  run(["git", "add", "-A"]);
  run(["git", "commit", "-m", `chore: ${tag}`]);
  console.log("· committed changes");
} else {
  console.log("· working tree clean");
}

/* 2. Repo on GitHub: create when missing, otherwise reuse.
 * Non-fatal probe: a fresh repo has no origin yet (exit 128). */
const remoteProbe = spawnSync("git", ["remote", "get-url", "origin"], {
  cwd: root,
  encoding: "utf8"
});
const remote = (remoteProbe.status === 0 ? remoteProbe.stdout : "").trim();
if (!remote) {
  const createArgs = ["gh", "repo", "create", repoName, "--source", ".", "--push"];
  if (privateFlag) createArgs.push("--private"); else createArgs.push("--public");
  run(createArgs);
  console.log(`· created github.com/${repoName}`);
} else {
  run(["git", "push", "-u", "origin", "main"]);
  console.log(`· pushed to ${remote}`);
}

/* 2b. Discoverability: repos never appear under github.com/topics/dsh-plugin
 * automatically — the topic must be set on the repo (idempotent). */
run(["gh", "repo", "edit", repoName,
  "--add-topic", "dsh-plugin",
  "--add-topic", "deepseek-harness",
  "--add-topic", "notification"]);
console.log("· topics ensured: dsh-plugin, deepseek-harness, notification");

/* 3. Tag + release with the packed tarball.
 * Overwrite semantics: the tag is force-moved and any existing release for it
 * is deleted first — same tag, no old version kept, no extra branches. */
run(["git", "tag", "-f", tag]);
run(["git", "push", "origin", tag, "--force"]);
const releaseProbe = spawnSync("gh", ["release", "view", tag], { stdio: "ignore" });
if (releaseProbe.status === 0) {
  run(["gh", "release", "delete", tag, "--yes"]);
  console.log(`· deleted previous release ${tag}`);
}
run(["npm", "pack"]);
/* npm pack names a scoped package `scope-name-version.tgz` (no `@`, `/` → `-`). */
const tarball = join(root, `${pkg.name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`);
run([
  "gh", "release", "create", tag,
  "--title", tag,
  "--notes", "See README.md for install instructions.\n\n" +
    "Install via GitHub:\n`dsh plugin --profile web add \"github:lovesiss/dsh-notify\"`\n\n" +
    `Artifacts:\n- \`${basename(tarball)}\` (client bundle)`
]);
run(["gh", "release", "upload", tag, tarball, "--clobber"]);
console.log(`✓ published github.com/${repoName} ${tag} (${basename(tarball)})`);
