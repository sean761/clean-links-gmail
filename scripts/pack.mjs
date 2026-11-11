// Copy the manifest and docs next to the bundled server, validate, and pack
// everything into a single .mcpb install file.
import { copyFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const dir = "dist/bundle";
for (const f of ["manifest.json", "README.md", "LICENSE"]) await copyFile(f, join(dir, f));
const { version } = JSON.parse(await readFile("manifest.json", "utf-8"));
const out = `dist/clean-links-gmail-${version}.mcpb`;
const mcpb = "node_modules/.bin/mcpb";
execFileSync(mcpb, ["validate", join(dir, "manifest.json")], { stdio: "inherit" });
execFileSync(mcpb, ["pack", dir, out], { stdio: "inherit" });
console.log(`\nInstall file: ${out}`);
