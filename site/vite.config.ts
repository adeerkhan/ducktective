import { readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import viteReact from "@vitejs/plugin-react";
import tanstackRouter from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";

/** The canonical skill artifact — this file is the only copy in the repo. */
const SKILL_MD = fileURLToPath(new URL("../skills/ducktective/SKILL.md", import.meta.url));

/**
 * GitHub Pages serves this repo as a *project* site, so every asset URL is
 * prefixed with `/ducktective/`. A root-mounted host (a custom domain or an
 * org-owned repo) sets `SITE_BASE=/`. Dev matches the deployed prefix unless
 * you want the shorter URL — `SITE_BASE=/ npm run dev`.
 */
const base = process.env.SITE_BASE ?? "/ducktective/";

/**
 * Serve the skill file, and make deep links survive a static host.
 *
 * `?raw` gets SKILL.md into the bundle for the on-page copy button; the URL
 * below is what `curl` and the Download button hit, so the same file has to
 * exist at `<base>skill/SKILL.md` in dev and in `dist/`.
 *
 * `404.html` is a copy of the SPA shell: Pages has no history-fallback rewrite,
 * so without it `/ducktective/protocol` 404s on refresh and on direct entry.
 */
function skillFileAndSpaFallback(): Plugin {
  let outDir = "";
  let root = "";
  return {
    name: "ducktective:skill-and-fallback",
    configResolved(config) {
      root = config.root;
      outDir = resolve(root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(`${base}skill/SKILL.md`, (_req, res) => {
        res.setHeader("content-type", "text/markdown; charset=utf-8");
        res.end(readFileSync(SKILL_MD));
      });
    },
    closeBundle() {
      mkdirSync(join(outDir, "skill"), { recursive: true });
      copyFileSync(SKILL_MD, join(outDir, "skill", "SKILL.md"));
      copyFileSync(join(outDir, "index.html"), join(outDir, "404.html"));
    },
  };
}

export default defineConfig({
  base,
  resolve: { tsconfigPaths: true },
  server: {
    // Live-preview contract: 0.0.0.0:8080. `allow: ".."` lets ?raw read the
    // skill file one level up, outside the Vite root.
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
    fs: { allow: [dirname(dirname(SKILL_MD))] },
  },
  preview: { host: "127.0.0.1", port: 8081, strictPort: true },
  plugins: [
    tailwindcss(),
    tanstackRouter({
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
    }),
    viteReact(),
    skillFileAndSpaFallback(),
  ],
});
