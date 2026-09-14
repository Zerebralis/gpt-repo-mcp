/* global process, console */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const version = "7.1.0";
const runtimeRoot = process.env.GPT_HOST_BREAKGLASS_COMPUTER_USE_RUNTIME_ROOT?.trim()
  || (process.platform === "win32" ? "C:\\Tools\\computer-use-runtime" : join(process.env.HOME ?? process.cwd(), ".local", "share", "gpt-host-breakglass", "computer-use-runtime"));
const packageRoot = join(runtimeRoot, "node_modules", "@zavora-ai", "computer-use-mcp");
const entry = join(packageRoot, "dist", "http.js");

await mkdir(runtimeRoot, { recursive: true });
await writeFile(join(runtimeRoot, "package.json"), JSON.stringify({
  name: "gpt-host-breakglass-computer-use-runtime",
  private: true,
  version: "1.0.0",
  dependencies: { "@zavora-ai/computer-use-mcp": version }
}, null, 2) + "\n", "utf8");

runNpm(runtimeRoot, ["install", "--omit=dev", "--ignore-scripts=false"]);
const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
if (installed.version !== version) throw new Error(`Unexpected Computer-Use version: ${installed.version}`);
await access(entry, constants.R_OK);
runNpm(runtimeRoot, ["audit", "--omit=dev", "--audit-level=high"]);
console.log(JSON.stringify({ ok: true, version, runtime_root: runtimeRoot, entry }, null, 2));

function runNpm(cwd, args) {
  const result = process.platform === "win32"
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `npm ${args.join(" ")}`], { cwd, stdio: "inherit", windowsHide: true })
    : spawnSync("npm", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed with exit code ${result.status}`);
}