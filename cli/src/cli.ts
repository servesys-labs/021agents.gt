#!/usr/bin/env node
/**
 * OneShots CLI - TypeScript implementation
 *
 * Commands:
 *   oneshots init [dir]          Scaffold a new agent project
 *   oneshots create              Create an agent (conversational)
 *   oneshots create -1 DESC      Create from one-line description
 *   oneshots run <agent> "task"  Run an agent locally
 *   oneshots list                List all agents
 *   oneshots deploy <agent>      Deploy to Cloudflare Workers
 *   oneshots chat <agent>        Interactive chat session
 *   oneshots sandbox <cmd>       Manage sandboxes
 *   oneshots login/logout        Authentication
 *
 * Extended commands:
 *   oneshots eval <cmd>          Run/view evaluations
 *   oneshots evolve <cmd>        Analyze/improve agents
 *   oneshots issues <cmd>        Manage issues
 *   oneshots security <cmd>      Security scanning
 *   oneshots sessions            View sessions
 *   oneshots traces <id>         View session traces
 *   oneshots skills              Manage skills
 *   oneshots tools               List tools
 *   oneshots graph <cmd>         View agent graphs
 *   oneshots memory <cmd>        View agent memory
 *   oneshots releases <agent>    Manage releases
 *   oneshots workflow <cmd>      Manage workflows
 *   oneshots schedule <cmd>      Manage schedules
 *   oneshots jobs                View background jobs
 *   oneshots research <cmd>      Autonomous research
 *   oneshots connectors          Manage connectors
 *   oneshots billing             View usage/costs
 */

import { Command } from "commander";
import chalk from "chalk";
import { initCommand } from "./commands/init.js";
import { createCommand } from "./commands/create.js";
import { runCommand } from "./commands/run.js";
import { listCommand } from "./commands/list.js";
import { deployCommand } from "./commands/deploy.js";
import { chatCommand } from "./commands/chat.js";
import { sandboxCommand } from "./commands/sandbox.js";
import { loginCommand, logoutCommand, whoamiCommand } from "./commands/auth.js";

// Extended commands
import { evalCommand } from "./commands/eval.js";
import { evolveCommand } from "./commands/evolve.js";
import { issuesCommand } from "./commands/issues.js";
import { securityCommand } from "./commands/security.js";
import { sessionsCommand } from "./commands/sessions.js";
import { skillsCommand } from "./commands/skills.js";
import { toolsCommand } from "./commands/tools.js";
import { graphCommand } from "./commands/graph.js";
import { memoryCommand } from "./commands/memory.js";
import { releasesCommand } from "./commands/releases.js";
import { workflowsCommand } from "./commands/workflows.js";
import { schedulesCommand } from "./commands/schedules.js";
import { jobsCommand } from "./commands/jobs.js";
import { researchCommand } from "./commands/research.js";
import { connectorsCommand } from "./commands/connectors.js";
import { billingCommand } from "./commands/billing.js";
import { tokensCommand } from "./commands/tokens.js";
import { batchCommand } from "./commands/batch.js";
import { domainsCommand } from "./commands/domains.js";
import { opsCommand } from "./commands/ops.js";
import { secretsCommand } from "./commands/secrets.js";
import { complianceCommand } from "./commands/compliance.js";
import { apiKeysCommand } from "./commands/api-keys.js";

import { getVersion } from "./lib/version.js";

const program = new Command();

program
  .name("oneshots")
  .description("OneShots — Build, run, and deploy AI agents")
  .version(getVersion(), "-v, --version", "Display version number")
  .argument("[agent]", "Agent name for interactive mode")
  .option("-s, --system <prompt>", "Override system prompt")
  .option("--autopilot", "Start in autonomous autopilot mode")
  .action(async (agent?: string, options?: { system?: string; autopilot?: boolean }) => {
    // Default action: launch interactive TUI (like 'claude' with no args)
    const agentName = agent || "personal-assistant";
    try {
      const { launchTUI } = await import("./tui/index.js");
      await launchTUI(agentName, options);
    } catch (e: any) {
      // Fallback to basic chat if Ink fails (e.g., non-interactive terminal)
      if (e.message?.includes("render") || e.message?.includes("ink")) {
        console.log(chalk.yellow("Interactive mode unavailable. Falling back to basic chat."));
        const { chatCommand: basicChat } = await import("./commands/chat.js");
        await basicChat(agentName, options || {});
      } else {
        throw e;
      }
    }
  });

// ═════════════════════════════════════════════════════════════════════════════
// Core Commands
// ═════════════════════════════════════════════════════════════════════════════

program
  .command("init [directory]")
  .description("Scaffold a new agent project")
  .option("-n, --name <name>", "Agent name (default: directory name)")
  .option("-t, --template <template>", "Use preset template", "orchestrator")
  .option("-r, --remote <url>", "Git remote URL to connect")
  .option("--no-git", "Skip git repository initialization")
  .option("--dry-run", "Preview what would be created")
  .option("-f, --force", "Overwrite existing files")
  .action(initCommand);

program
  .command("create")
  .description("Create a new agent (conversational)")
  .option("-1, --one-shot <description>", "Create from one-line description")
  .option("-n, --name <name>", "Override generated agent name")
  .option("-o, --output <path>", "Custom output path")
  .option("-m, --model <model>", "LLM model for builder")
  .option("-f, --force", "Overwrite existing agent")
  .action(createCommand);

program
  .command("run <agent> <task>")
  .description("Run an agent on a task")
  .option("-s, --stream", "Stream with tree rendering (default)", true)
  .option("--no-stream", "Non-streaming mode")
  .option("-v, --verbose", "Show live cost/token status bar")
  .option("--json", "Output raw JSON result")
  .action(runCommand);

program
  .command("list")
  .alias("ls")
  .description("List all available agents")
  .option("-a, --all", "Show all agents including drafts")
  .action(listCommand);

program
  .command("deploy <agent>")
  .description("Deploy an agent to Cloudflare Workers")
  .option("-e, --env <environment>", "Deployment environment", "production")
  .option("--canary <percent>", "Canary rollout percentage", "0")
  .action(deployCommand);

program
  .command("chat <agent>")
  .description("Interactive chat session with an agent")
  .option("-s, --system <prompt>", "Override system prompt")
  .option("-v, --verbose", "Show per-turn cost/token info")
  .option("--basic", "Use basic readline mode instead of TUI")
  .action(async (agent: string, options: any) => {
    if (options.basic) {
      chatCommand(agent, options);
    } else {
      try {
        const { launchTUI } = await import("./tui/index.js");
        await launchTUI(agent, options);
      } catch {
        chatCommand(agent, options);
      }
    }
  });

// ═════════════════════════════════════════════════════════════════════════════
// Eval Commands
// ═════════════════════════════════════════════════════════════════════════════

const evalCmd = program
  .command("eval")
  .description("Run and view evaluations");

evalCmd
  .command("list")
  .alias("ls")
  .description("List eval runs")
  .option("-a, --agent <name>", "Filter by agent")
  .option("-l, --limit <n>", "Limit results", "20")
  .action((opts) => evalCommand.list({ agent: opts.agent, limit: parseInt(opts.limit) }));

evalCmd
  .command("run <agent>")
  .description("Run evaluation for an agent")
  .option("-t, --tasks <path>", "Tasks JSON file")
  .option("-n, --trials <n>", "Number of trials", "3")
  .option("--no-stream", "Don't stream output")
  .action((agent, opts) => evalCommand.run(agent, {
    tasks: opts.tasks,
    trials: parseInt(opts.trials),
    stream: opts.stream,
  }));

evalCmd
  .command("status <runId>")
  .description("Get eval run status")
  .action(evalCommand.status);

evalCmd
  .command("datasets")
  .description("List available datasets")
  .action(evalCommand.datasets);

// ═════════════════════════════════════════════════════════════════════════════
// Evolve Commands
// ═════════════════════════════════════════════════════════════════════════════

const evolveCmd = program
  .command("evolve")
  .description("Agent evolution and improvement");

evolveCmd
  .command("analyze <agent>")
  .description("Analyze agent for improvement opportunities")
  .option("-d, --days <n>", "Days of history to analyze", "7")
  .action((agent, opts) => evolveCommand.analyze(agent, { days: parseInt(opts.days) }));

evolveCmd
  .command("proposals <agent>")
  .description("List improvement proposals")
  .action(evolveCommand.proposals);

evolveCmd
  .command("approve <agent> <proposalId>")
  .description("Approve a proposal")
  .action(evolveCommand.approve);

evolveCmd
  .command("reject <agent> <proposalId>")
  .description("Reject a proposal")
  .option("-r, --reason <text>", "Rejection reason")
  .action((agent, id, opts) => evolveCommand.reject(agent, id, opts));

evolveCmd
  .command("apply <agent> <proposalId>")
  .description("Apply a proposal to the agent")
  .action(evolveCommand.apply);

evolveCmd
  .command("ledger <agent>")
  .description("View evolution history")
  .action(evolveCommand.ledger);

// ═════════════════════════════════════════════════════════════════════════════
// Issues Commands
// ═════════════════════════════════════════════════════════════════════════════

const issuesCmd = program
  .command("issues")
  .description("Issue tracking and remediation");

issuesCmd
  .command("list")
  .alias("ls")
  .description("List issues")
  .option("-a, --agent <name>", "Filter by agent")
  .option("-s, --status <status>", "Filter by status")
  .option("-S, --severity <sev>", "Filter by severity")
  .action((opts) => issuesCommand.list(opts));

issuesCmd
  .command("summary")
  .description("Show issues summary")
  .option("-a, --agent <name>", "Filter by agent")
  .action((opts) => issuesCommand.summary(opts));

issuesCmd
  .command("show <issueId>")
  .description("Show issue details")
  .action(issuesCommand.show);

issuesCmd
  .command("fix <issueId>")
  .description("Attempt auto-fix for issue")
  .action(issuesCommand.fix);

issuesCmd
  .command("triage <issueId> <severity>")
  .description("Set issue severity")
  .action(issuesCommand.triage);

// ═════════════════════════════════════════════════════════════════════════════
// Security Commands
// ═════════════════════════════════════════════════════════════════════════════

const securityCmd = program
  .command("security")
  .description("Security scanning and findings");

securityCmd
  .command("list")
  .alias("ls")
  .description("List security scans")
  .option("-a, --agent <name>", "Filter by agent")
  .option("-l, --limit <n>", "Limit results", "20")
  .action((opts) => securityCommand.list({ agent: opts.agent, limit: parseInt(opts.limit) }));

securityCmd
  .command("scan <agent>")
  .description("Run security scan on agent")
  .option("-t, --type <type>", "Scan type", "config")
  .action((agent, opts) => securityCommand.scan(agent, opts));

securityCmd
  .command("findings")
  .description("List security findings")
  .option("-s, --scan <id>", "Filter by scan")
  .option("-a, --agent <name>", "Filter by agent")
  .option("-S, --severity <sev>", "Filter by severity")
  .action((opts) => securityCommand.findings(opts));

securityCmd
  .command("probes")
  .description("List available security probes")
  .action(securityCommand.probes);

// ═════════════════════════════════════════════════════════════════════════════
// Sessions & Traces
// ═════════════════════════════════════════════════════════════════════════════

program
  .command("sessions")
  .description("List recent sessions")
  .option("-a, --agent <name>", "Filter by agent")
  .option("-s, --status <status>", "Filter by status")
  .option("-l, --limit <n>", "Limit results", "20")
  .action((opts) => sessionsCommand.list({
    agent: opts.agent,
    status: opts.status,
    limit: parseInt(opts.limit),
  }));

program
  .command("traces <sessionId>")
  .description("View session traces")
  .action(sessionsCommand.show);

// ═════════════════════════════════════════════════════════════════════════════
// Skills Commands
// ═════════════════════════════════════════════════════════════════════════════

const skillsCmd = program
  .command("skills")
  .description("Manage skills");

skillsCmd
  .command("list")
  .alias("ls")
  .description("List skills")
  .action(skillsCommand.list);

skillsCmd
  .command("show <name>")
  .description("Show skill details")
  .action(skillsCommand.show);

skillsCmd
  .command("enable <name>")
  .description("Enable a skill")
  .action(skillsCommand.enable);

skillsCmd
  .command("disable <name>")
  .description("Disable a skill")
  .action(skillsCommand.disable);

skillsCmd
  .command("reload")
  .description("Reload skills registry")
  .action(skillsCommand.reload);

// ═════════════════════════════════════════════════════════════════════════════
// Tools Commands
// ═════════════════════════════════════════════════════════════════════════════

const toolsCmd = program
  .command("tools")
  .description("List and inspect tools");

toolsCmd
  .command("list")
  .alias("ls")
  .description("List available tools")
  .option("-s, --search <query>", "Search query")
  .option("--source <source>", "Filter by source")
  .action((opts) => toolsCommand.list(opts));

toolsCmd
  .command("show <name>")
  .description("Show tool details")
  .action(toolsCommand.show);

toolsCmd
  .command("reload")
  .description("Reload tool registry")
  .action(toolsCommand.reload);

// ═════════════════════════════════════════════════════════════════════════════
// Graph Commands
// ═════════════════════════════════════════════════════════════════════════════

const graphCmd = program
  .command("graph")
  .description("View and manage agent graphs");

graphCmd
  .command("show <agent>")
  .description("Show agent graph")
  .action(graphCommand.show);

graphCmd
  .command("export <agent>")
  .description("Export agent graph to JSON")
  .option("-o, --output <path>", "Output file")
  .action((agent, opts) => graphCommand.export(agent, opts));

graphCmd
  .command("validate <agent>")
  .description("Validate agent graph")
  .action(graphCommand.validate);

// ═════════════════════════════════════════════════════════════════════════════
// Memory Commands
// ═════════════════════════════════════════════════════════════════════════════

const memoryCmd = program
  .command("memory")
  .description("View agent memory");

memoryCmd
  .command("working <agent>")
  .description("View working memory")
  .action(memoryCommand.working);

memoryCmd
  .command("episodic <agent>")
  .description("View episodic memory")
  .option("-l, --limit <n>", "Limit results", "20")
  .action((agent, opts) => memoryCommand.episodic(agent, { limit: parseInt(opts.limit) }));

memoryCmd
  .command("semantic <agent>")
  .description("View semantic memory")
  .option("-q, --query <text>", "Search query")
  .action((agent, opts) => memoryCommand.semantic(agent, opts));

// ═════════════════════════════════════════════════════════════════════════════
// Releases Commands
// ═════════════════════════════════════════════════════════════════════════════

const releasesCmd = program
  .command("releases")
  .description("Manage agent releases");

releasesCmd
  .command("list <agent>")
  .alias("ls")
  .description("List releases for agent")
  .action(releasesCommand.list);

releasesCmd
  .command("promote <agent> <version>")
  .description("Promote version to channel")
  .option("-c, --channel <channel>", "Target channel", "production")
  .option("-t, --traffic <percent>", "Traffic percentage", "100")
  .action((agent, version, opts) => releasesCommand.promote(agent, version, {
    channel: opts.channel,
    traffic: parseInt(opts.traffic),
  }));

releasesCmd
  .command("rollback <agent>")
  .description("Rollback to previous version")
  .action(releasesCommand.rollback);

// ═════════════════════════════════════════════════════════════════════════════
// Workflows Commands
// ═════════════════════════════════════════════════════════════════════════════

const workflowCmd = program
  .command("workflow")
  .description("Manage workflows");

workflowCmd
  .command("list")
  .alias("ls")
  .description("List workflows")
  .action(workflowsCommand.list);

workflowCmd
  .command("show <id>")
  .description("Show workflow details")
  .action(workflowsCommand.show);

workflowCmd
  .command("create <name>")
  .description("Create new workflow")
  .option("-f, --file <path>", "Workflow definition JSON")
  .action((name, opts) => workflowsCommand.create(name, opts));

workflowCmd
  .command("delete <id>")
  .description("Delete workflow")
  .action(workflowsCommand.delete);

// ═════════════════════════════════════════════════════════════════════════════
// Schedules Commands
// ═════════════════════════════════════════════════════════════════════════════

const scheduleCmd = program
  .command("schedule")
  .description("Manage cron schedules");

scheduleCmd
  .command("list")
  .alias("ls")
  .description("List schedules")
  .option("-a, --agent <name>", "Filter by agent")
  .action((opts) => schedulesCommand.list(opts));

scheduleCmd
  .command("create <agent> <task> <cron>")
  .description("Create new schedule")
  .action((agent, task, cron) => schedulesCommand.create(agent, task, cron));

scheduleCmd
  .command("delete <id>")
  .description("Delete schedule")
  .action(schedulesCommand.delete);

// ═════════════════════════════════════════════════════════════════════════════
// Jobs Commands
// ═════════════════════════════════════════════════════════════════════════════

const jobsCmd = program
  .command("jobs")
  .description("Background job management");

jobsCmd
  .command("list")
  .alias("ls")
  .description("List jobs")
  .option("-s, --status <status>", "Filter by status")
  .option("-l, --limit <n>", "Limit results", "20")
  .action((opts) => jobsCommand.list({
    status: opts.status,
    limit: parseInt(opts.limit),
  }));

jobsCmd
  .command("show <jobId>")
  .description("Show job details")
  .action(jobsCommand.show);

// ═════════════════════════════════════════════════════════════════════════════
// Research Commands (Autoresearch)
// ═════════════════════════════════════════════════════════════════════════════

const researchCmd = program
  .command("research")
  .description("Autonomous research (autoresearch)");

researchCmd
  .command("status")
  .description("Show research status")
  .option("-w, --workspace <path>", "Workspace path")
  .action((opts) => researchCommand.status(opts));

researchCmd
  .command("start")
  .description("Start research")
  .option("-w, --workspace <path>", "Workspace path")
  .option("-a, --agent <name>", "Agent to research")
  .action((opts) => researchCommand.start(opts));

researchCmd
  .command("stop")
  .description("Stop research")
  .option("-w, --workspace <path>", "Workspace path")
  .action((opts) => researchCommand.stop(opts));

researchCmd
  .command("results")
  .description("Show research results")
  .option("-w, --workspace <path>", "Workspace path")
  .option("-l, --last <n>", "Show last N results")
  .action((opts) => researchCommand.results(opts));

researchCmd
  .command("runs")
  .description("List research runs")
  .option("-a, --agent <name>", "Filter by agent")
  .action((opts) => researchCommand.runs(opts));

// ═════════════════════════════════════════════════════════════════════════════
// Connectors Commands
// ═════════════════════════════════════════════════════════════════════════════

const connectorsCmd = program
  .command("connectors")
  .description("Manage integrations");

connectorsCmd
  .command("list")
  .alias("ls")
  .description("List connectors")
  .action(connectorsCommand.list);

connectorsCmd
  .command("show <id>")
  .description("Show connector details")
  .action(connectorsCommand.show);

connectorsCmd
  .command("create <name> <type>")
  .description("Create connector")
  .option("-c, --config <json>", "Config JSON")
  .action((name, type, opts) => connectorsCommand.create(name, type, opts));

connectorsCmd
  .command("delete <id>")
  .description("Delete connector")
  .action(connectorsCommand.delete);

connectorsCmd
  .command("test <id>")
  .description("Test connector")
  .action(connectorsCommand.test);

// ═════════════════════════════════════════════════════════════════════════════
// Billing Commands
// ═════════════════════════════════════════════════════════════════════════════

const billingCmd = program
  .command("billing")
  .description("View usage and costs");

billingCmd
  .command("usage")
  .description("Show usage statistics")
  .option("-d, --days <n>", "Days to show", "30")
  .action((opts) => billingCommand.usage({ days: parseInt(opts.days) }));

billingCmd
  .command("invoices")
  .alias("ls")
  .description("List invoices")
  .action(billingCommand.invoices);

billingCmd
  .command("limits")
  .description("Show billing limits")
  .action(billingCommand.limits);

// ═════════════════════════════════════════════════════════════════════════════
// Sandbox Commands
// ═════════════════════════════════════════════════════════════════════════════

const sandbox = program
  .command("sandbox")
  .description("Manage E2B sandboxes");

sandbox
  .command("create")
  .description("Create a new sandbox")
  .option("-t, --timeout <seconds>", "Sandbox timeout", "3600")
  .action(sandboxCommand.create);

sandbox
  .command("list")
  .alias("ls")
  .description("List active sandboxes")
  .action(sandboxCommand.list);

sandbox
  .command("exec <id> <command>")
  .description("Execute command in sandbox")
  .action(sandboxCommand.exec);

sandbox
  .command("kill <id>")
  .description("Kill a sandbox")
  .action(sandboxCommand.kill);

// ═════════════════════════════════════════════════════════════════════════════
// Auth Commands
// ═════════════════════════════════════════════════════════════════════════════

program
  .command("login")
  .description("Authenticate with OneShots")
  .option("-m, --manual", "Use email/password instead of browser login")
  .action(loginCommand);

program
  .command("logout")
  .description("Remove stored credentials")
  .action(logoutCommand);

program
  .command("whoami")
  .description("Show current authenticated user")
  .action(whoamiCommand);

// ═════════════════════════════════════════════════════════════════════════════
// Consumption & Enterprise Commands
// ═════════════════════════════════════════════════════════════════════════════

// End-user tokens (SaaS multi-tenant)
const tokensCmd = program
  .command("tokens")
  .description("Manage end-user tokens (SaaS multi-tenant)");

tokensCmd.command("list").description("List end-user tokens").action(tokensCommand.list);
tokensCmd.command("create")
  .description("Mint a new end-user token")
  .requiredOption("-u, --user-id <id>", "End-user ID")
  .option("-a, --agents <names>", "Allowed agents (comma-separated)")
  .option("--rpm <n>", "Rate limit requests/minute", "20")
  .option("--rpd <n>", "Rate limit requests/day", "1000")
  .option("-e, --expiry <seconds>", "Token expiry in seconds", "3600")
  .action((opts) => tokensCommand.create(opts));
tokensCmd.command("revoke <tokenId>").description("Revoke a token").action(tokensCommand.revoke);
tokensCmd.command("usage <userId>").description("View end-user usage").action(tokensCommand.usage);

// Batch processing
const batchCmd = program
  .command("batch")
  .description("Batch agent processing");

batchCmd.command("submit <agent>")
  .description("Submit a batch job")
  .option("-f, --file <path>", "JSON file with tasks array")
  .option("-i, --input <text>", "Single input task")
  .option("--callback <url>", "Webhook URL for completion")
  .action((agent, opts) => batchCommand.submit(agent, opts));
batchCmd.command("status <agent> <batchId>").description("Get batch status").action((a, b) => batchCommand.status(a, b));
batchCmd.command("list <agent>").description("List batch jobs").option("-l, --limit <n>", "Limit", "20").action((a, opts) => batchCommand.list(a, opts));
batchCmd.command("cancel <agent> <batchId>").description("Cancel a batch").action((a, b) => batchCommand.cancel(a, b));

// Custom domains
const domainsCmd = program
  .command("domains")
  .description("Manage custom domains");

domainsCmd.command("list").description("List domains").action(domainsCommand.list);
domainsCmd.command("add")
  .description("Add a domain")
  .option("-t, --type <type>", "Domain type: subdomain or custom", "subdomain")
  .option("-h, --hostname <host>", "Custom hostname (for type=custom)")
  .action((opts) => domainsCommand.add(opts));
domainsCmd.command("verify <domainId>").description("Verify DNS").action(domainsCommand.verify);
domainsCmd.command("remove <domainId>").description("Remove domain").action(domainsCommand.remove);

// API keys
const apiKeysCmd = program
  .command("api-keys")
  .description("Manage API keys");

apiKeysCmd.command("list").description("List API keys").action(apiKeysCommand.list);
apiKeysCmd.command("create")
  .description("Create API key")
  .option("-n, --name <name>", "Key name", "default")
  .option("-s, --scopes <scopes>", "Scopes (comma-separated)", "*")
  .option("--rpm <n>", "Rate limit requests/minute", "60")
  .option("--rpd <n>", "Rate limit requests/day", "10000")
  .option("--agents <names>", "Allowed agents (comma-separated)")
  .option("--ips <cidrs>", "IP allowlist (comma-separated)")
  .option("--expiry <days>", "Expiry in days")
  .action((opts) => apiKeysCommand.create(opts));
apiKeysCmd.command("revoke <keyId>").description("Revoke key").action(apiKeysCommand.revoke);
apiKeysCmd.command("rotate <keyId>").description("Rotate key").action(apiKeysCommand.rotate);

// Secrets
const secretsCmd = program
  .command("secrets")
  .description("Manage encrypted secrets");

secretsCmd.command("list").description("List secrets").action(secretsCommand.list);
secretsCmd.command("create <name>")
  .description("Create secret")
  .option("-v, --value <value>", "Secret value (prompted if omitted)")
  .action((name, opts) => secretsCommand.create(name, opts));
secretsCmd.command("delete <name>").description("Delete secret").action(secretsCommand.delete);
secretsCmd.command("rotate").description("Rotate encryption key").action(secretsCommand.rotate);
secretsCmd.command("rotations").description("View rotation history").action(secretsCommand.rotations);

// Ops monitoring
const opsCmd = program
  .command("ops")
  .description("Operations monitoring & alerts");

opsCmd.command("health <agent>").description("Agent health check").action(opsCommand.health);
opsCmd.command("latency")
  .description("Latency percentiles")
  .option("-a, --agent <name>", "Filter by agent")
  .option("--hours <n>", "Time window", "24")
  .action((opts) => opsCommand.latency(opts));
opsCmd.command("errors")
  .description("Error breakdown")
  .option("-a, --agent <name>", "Filter by agent")
  .option("--hours <n>", "Time window", "24")
  .action((opts) => opsCommand.errors(opts));
opsCmd.command("budget").description("Cost vs budget").action(opsCommand.budget);
opsCmd.command("concurrent").description("Active sessions").action(opsCommand.concurrent);
opsCmd.command("alerts").description("List alert configs & history").action(() => opsCommand.alerts({}));

// Compliance (GDPR)
const complianceCmd = program
  .command("compliance")
  .description("GDPR compliance & data management");

complianceCmd.command("export").description("Request data export").action(complianceCommand.exportData);
complianceCmd.command("export-status <exportId>").description("Check export status").action(complianceCommand.exportStatus);
complianceCmd.command("exports").description("List export requests").action(complianceCommand.exports);
complianceCmd.command("delete-account <userId>")
  .description("Delete user account (GDPR Art. 17)")
  .option("-r, --reason <reason>", "Reason for deletion")
  .action((userId, opts) => complianceCommand.deleteAccount(userId, opts));
complianceCmd.command("deletions").description("List deletion requests").action(complianceCommand.deletions);

// Parse arguments
program.parse();

// Show help if no args
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
