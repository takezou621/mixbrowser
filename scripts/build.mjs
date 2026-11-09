import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const common = { bundle: true, sourcemap: "inline", logLevel: "warning" };

build({
  ...common,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

build({
  ...common,
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/preload.js",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});

build({
  ...common,
  entryPoints: ["src/renderer/app.ts"],
  outfile: "dist/renderer.js",
  platform: "browser",
  format: "iife",
  target: "chrome140",
});

cpSync("src/renderer/index.html", "dist/index.html");
cpSync("src/renderer/styles.css", "dist/styles.css");
console.log("build ok");
