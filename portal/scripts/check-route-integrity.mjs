import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const appPath = resolve(process.cwd(), "src/App.tsx");
const appSource = readFileSync(appPath, "utf8");

const routeRegex = /<Route\s+path="([^"]+)"/g;
const declared = new Set(["/"]);
let match;
while ((match = routeRegex.exec(appSource)) !== null) {
  declared.add(match[1]);
}

const referencedStaticRoutes = [
  "/",
  "/agents",
  "/agents/new",
  "/sessions",
  "/intelligence",
  "/compliance",
  "/issues",
  "/security",
  "/autoresearch",
  "/voice",
  "/settings",
  "/billing/pricing",
  "/billing/invoices",
  "/tools",
  "/a2a",
  "/a2a/compose",
  "/security/findings",
  "/security/report",
  "/connectors",
  "/releases",
  "/sandbox",
];

const missing = referencedStaticRoutes.filter((p) => !declared.has(p));
if (missing.length > 0) {
  console.error("Route integrity check failed. Missing routes in App.tsx:");
  for (const p of missing) console.error(`- ${p}`);
  process.exit(1);
}

console.log(`Route integrity check passed (${referencedStaticRoutes.length} static routes validated).`);
