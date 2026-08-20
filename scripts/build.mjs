/* dsh-notify · zero-dependency bundle builder.
 * Produces lib/client.js in the exact format the DSH client kernel expects:
 *   window.__ModuleLoader__.load({ id, factory })   (plain CJS factory, no transform) */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

if (!pkg.name || !/^[a-z0-9@/._-]+$/i.test(pkg.name)) {
  console.error("build: package.json name is missing or invalid:", pkg.name);
  process.exit(1);
}

const logic = readFileSync(join(root, "src", "logic.cjs"), "utf8");
const client = readFileSync(join(root, "src", "client.js"), "utf8");
const host = readFileSync(join(root, "src", "host.js"), "utf8");

const bundle = [
  "/* built by scripts/build.mjs — do not edit directly */",
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
  logic,
  client,
  "} });",
  ""
].join("\n");

mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib", "client.js"), bundle);
writeFileSync(join(root, "lib", "index.js"), "/* built by scripts/build.mjs — do not edit directly */\n" + host);
console.log(`built lib/client.js (${Buffer.byteLength(bundle)} bytes) and lib/index.js`);
