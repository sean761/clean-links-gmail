// Bundle the server into one file and collect license notices for every
// third-party package that ends up inside it.
import { build } from "esbuild";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

const out = "dist/bundle";
await rm("dist", { recursive: true, force: true });
await mkdir(join(out, "server"), { recursive: true });

const result = await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: join(out, "server/index.cjs"),
  metafile: true,
  legalComments: "none",
  minify: false,
  logLevel: "warning",
});

// Find each package that contributed code to the bundle.
const pkgRoots = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (m) pkgRoots.add(m[1]);
}

const sections = [];
for (const root of [...pkgRoots].sort()) {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf-8"));
  const files = await readdir(root);
  const licenseFile = files.find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  const text = licenseFile ? (await readFile(join(root, licenseFile), "utf-8")).trim() : `License: ${pkg.license ?? "see package"}`;
  sections.push(`${pkg.name}@${pkg.version} (${pkg.license ?? "unknown"})\n${"-".repeat(60)}\n${text}`);
}
await writeFile(
  join(out, "THIRD-PARTY-NOTICES.txt"),
  "Clean Links Gmail includes the following open-source software.\n\n" + sections.join("\n\n\n") + "\n"
);
console.log(`Bundled ${pkgRoots.size} packages into ${out}/server/index.cjs`);
