/**
 * Authentication commands — OAuth-style browser login flow with manual fallback.
 */
import chalk from "chalk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import ora from "ora";
import inquirer from "inquirer";
import { getConfig, getAuth, setAuth, isAuthenticated } from "../lib/config.js";
import { apiGet, apiPost } from "../lib/api.js";

const CALLBACK_PORTS = [8976, 8977, 8978];
const LOGIN_TIMEOUT_MS = 120_000;

// ── JWT helpers (decode only, no verification — the control plane signed it) ──

interface JwtPayload {
  sub: string;
  email: string;
  org_id?: string;
  exp?: number;
  iat?: number;
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}

// ── Browser opener (cross-platform) ──────────────────────────────────────

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd, (err) => {
    if (err) {
      // Silently ignore — user will see the URL printed in the terminal
    }
  });
}

// ── Local callback server ────────────────────────────────────────────────

function tryListen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

async function startCallbackServer(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  for (const port of CALLBACK_PORTS) {
    try {
      const server = await tryListen(port);
      return { server, port };
    } catch {
      // Port taken, try next
    }
  }
  throw new Error(
    `Could not bind to any callback port (${CALLBACK_PORTS.join(", ")}). ` +
    "Free one of these ports or use --manual for email/password login."
  );
}

// ── OAuth browser flow ───────────────────────────────────────────────────

async function browserLogin(): Promise<void> {
  const config = getConfig();
  const state = randomBytes(16).toString("hex"); // 32 hex chars

  const { server, port } = await startCallbackServer();

  const loginUrl = `${config.apiUrl}/api/v1/auth/cli?port=${port}&state=${state}`;

  const spinner = ora("Waiting for browser login...").start();

  console.log(chalk.gray(`\n  If browser doesn't open, visit:\n  ${loginUrl}\n`));
  openBrowser(loginUrl);

  const result = await new Promise<{ token: string; email: string; orgId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      spinner.fail("Login timed out. Use --manual for email/password login.");
      reject(new Error("timeout"));
    }, LOGIN_TIMEOUT_MS);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const token = url.searchParams.get("token");
      const returnedState = url.searchParams.get("state");

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>State mismatch — possible CSRF. Please try again.</h2></body></html>");
        return;
      }

      if (!token) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Missing token. Please try again.</h2></body></html>");
        return;
      }

      // Decode JWT to extract user info
      let claims: JwtPayload;
      try {
        claims = decodeJwtPayload(token);
      } catch {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<html><body><h2>Invalid token format. Please try again.</h2></body></html>");
        return;
      }

      // Send success page to browser
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head><title>OneShots CLI Login</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0C0A09; color: #FAFAF9;">
  <div style="text-align: center;">
    <div style="color: #22C55E; font-size: 48px;">&#10003;</div>
    <h1>Logged in!</h1>
    <p style="color: #A8A29E;">You can close this tab and return to the terminal.</p>
  </div>
</body>
</html>`);

      clearTimeout(timeout);
      server.close();
      resolve({
        token,
        email: claims.email,
        orgId: claims.org_id || "",
      });
    });
  });

  // Persist auth
  const claims = decodeJwtPayload(result.token);
  setAuth({
    token: result.token,
    email: result.email,
    orgId: result.orgId,
    expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + 24 * 60 * 60 * 1000,
  });

  spinner.succeed(`Logged in as ${chalk.bold(result.email)}`);
}

// ── Manual email/password flow ───────────────────────────────────────────

async function manualLogin(): Promise<void> {
  const config = getConfig();

  const answers = await inquirer.prompt([
    { type: "input", name: "email", message: "Email:" },
    { type: "password", name: "password", message: "Password:", mask: "*" },
  ]);

  const spinner = ora("Authenticating...").start();

  try {
    const response = await apiPost<{
      token: string;
      user_id: string;
      email: string;
      org_id: string;
    }>("/api/v1/auth/login", {
      email: answers.email,
      password: answers.password,
    });

    setAuth({
      token: response.token,
      userId: response.user_id,
      email: response.email,
      orgId: response.org_id,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    spinner.succeed(`Logged in as ${chalk.bold(response.email)}`);
  } catch (error: any) {
    spinner.fail("Authentication failed");
    const message = error?.message || "Invalid credentials";
    console.error(chalk.red(`  ${message}`));
    process.exit(1);
  }
}

// ── Exported commands ────────────────────────────────────────────────────

export async function loginCommand(options: { manual?: boolean } = {}): Promise<void> {
  if (isAuthenticated()) {
    const auth = getAuth();
    const reauthAnswer = await inquirer.prompt([
      {
        type: "confirm",
        name: "reauth",
        message: `Already logged in${auth?.email ? ` as ${auth.email}` : ""}. Re-authenticate?`,
        default: false,
      },
    ]);
    if (!reauthAnswer.reauth) return;
  }

  if (options.manual) {
    await manualLogin();
  } else {
    try {
      await browserLogin();
    } catch (error: any) {
      if (error.message === "timeout") {
        process.exit(1);
      }
      // If browser flow fails for any other reason, suggest manual
      console.error(chalk.yellow("Browser login failed. Falling back to email/password..."));
      await manualLogin();
    }
  }
}

export async function logoutCommand(): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("Not currently authenticated."));
    return;
  }

  setAuth(null);
  console.log(chalk.green("Logged out successfully."));
}

export async function whoamiCommand(): Promise<void> {
  const auth = getAuth();

  if (!auth?.token) {
    console.log(chalk.yellow("Not authenticated. Run 'oneshots login' first."));
    return;
  }

  try {
    const user = await apiGet<{ email: string; id: string; org?: string }>("/api/v1/auth/me");
    console.log(chalk.blue("Authenticated as:"));
    console.log(`  Email: ${user.email}`);
    console.log(`  User ID: ${user.id}`);
    if (user.org) {
      console.log(`  Organization: ${user.org}`);
    }
  } catch {
    // Fall back to locally stored info
    if (auth.email) {
      console.log(chalk.blue("Authenticated as:"));
      console.log(`  Email: ${auth.email}`);
      if (auth.orgId) console.log(`  Org ID: ${auth.orgId}`);
      console.log(chalk.gray("  (Could not reach server to verify session)"));
    } else {
      console.log(chalk.yellow("Session may have expired. Run 'oneshots login' to re-authenticate."));
    }
  }
}
