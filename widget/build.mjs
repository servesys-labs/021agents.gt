import { build, context } from "esbuild";

const isWatch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ["src/widget.ts"],
  bundle: true,
  minify: !isWatch,
  sourcemap: isWatch ? "inline" : false,
  format: "iife",
  target: ["es2020", "chrome80", "firefox78", "safari14"],
  outfile: "dist/widget.js",
  charset: "utf8",
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": isWatch ? '"development"' : '"production"',
  },
};

if (isWatch) {
  const ctx = await context(config);
  await ctx.watch();
  console.log("[widget] watching for changes...");
} else {
  const result = await build(config);
  const fs = await import("fs");
  const stat = fs.statSync("dist/widget.js");
  console.log(
    `[widget] built dist/widget.js (${(stat.size / 1024).toFixed(1)} KB)`
  );
}
