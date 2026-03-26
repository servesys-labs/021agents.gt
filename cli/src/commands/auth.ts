/**
 * Authentication commands
 */
import chalk from "chalk";
import open from "open";
import { createServer } from "http";
import { getAuth, setAuth, isAuthenticated } from "../lib/config.js";
import { apiGet } from "../lib/api.js";

const AUTH_SERVER_PORT = 8787;

export async function loginCommand(): Promise<void> {
  console.log(chalk.blue("🔐 Authenticating with AgentOS..."));

  // Start local callback server
  const authPromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${AUTH_SERVER_PORT}`);
      const token = url.searchParams.get("token");

      if (token) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head>
              <title>AgentOS Login</title>
              <style>
                body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0C0A09; color: #FAFAF9; }
                .container { text-align: center; }
                .success { color: #22C55E; font-size: 48px; }
                h1 { margin: 20px 0; }
                p { color: #A8A29E; }
              </style>
            </head>
            <body>
              <div class="container">
                <div class="success">✓</div>
                <h1>Authentication successful!</h1>
                <p>You can close this window and return to the CLI.</p>
              </div>
            </body>
          </html>
        `);
        server.close();
        resolve(token);
      } else {
        res.writeHead(400);
        res.end("Missing token");
      }
    });

    server.listen(AUTH_SERVER_PORT, () => {
      console.log(chalk.gray(`Waiting for authentication on port ${AUTH_SERVER_PORT}...`));
    });

    server.on("error", reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("Authentication timeout"));
    }, 300000);
  });

  // Open browser to login page
  const loginUrl = `https://app.agentos.dev/login?callback=http://localhost:${AUTH_SERVER_PORT}`;
  console.log(chalk.gray("Opening browser for authentication..."));
  await open(loginUrl);

  try {
    const token = await authPromise;
    setAuth({
      token,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    console.log(chalk.green("✓ Successfully authenticated!"));
  } catch (error) {
    console.error(chalk.red("Authentication failed:"), error);
    process.exit(1);
  }
}

export async function logoutCommand(): Promise<void> {
  if (!isAuthenticated()) {
    console.log(chalk.yellow("⚠ Not currently authenticated"));
    return;
  }

  setAuth(null);
  console.log(chalk.green("✓ Logged out successfully"));
}

export async function whoamiCommand(): Promise<void> {
  const auth = getAuth();
  
  if (!auth?.token) {
    console.log(chalk.yellow("Not authenticated. Run 'agentos login' first."));
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
  } catch (error) {
    console.log(chalk.yellow("Session may have expired. Run 'agentos login' to re-authenticate."));
  }
}
