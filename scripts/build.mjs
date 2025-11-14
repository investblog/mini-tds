import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");

await mkdir(resolve(projectRoot, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(projectRoot, "src/worker.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  outfile: resolve(projectRoot, "dist/worker.js"),
  legalComments: "none",
  logLevel: "info",
});
