#!/usr/bin/env node
/**
 * AgentOS CLI - TypeScript implementation
 * 
 * Commands:
 *   agentos init [dir]          Scaffold a new agent project
 *   agentos create              Create an agent (conversational)
 *   agentos create -1 DESC      Create from one-line description
 *   agentos run <agent> "task"  Run an agent locally
 *   agentos list                List all agents
 *   agentos deploy <agent>      Deploy to Cloudflare Workers
 *   agentos chat <agent>        Interactive chat session
 *   agentos sandbox <cmd>       Manage sandboxes
 *   agentos login/logout        Authentication
 * 
 * Extended commands:
 *   agentos eval <cmd>          Run/view evaluations
 *   agentos evolve <cmd>        Analyze/improve agents
 *   agentos issues <cmd>        Manage issues
 *   agentos security <cmd>      Security scanning
 *   agentos sessions            View sessions
 *   agentos traces <id>         View session traces
 *   agentos skills              Manage skills
 *   agentos tools               List tools
 *   agentos graph <cmd>         View agent graphs
 *   agentos memory <cmd>        View agent memory
 *   agentos releases <agent>    Manage releases
 *   agentos workflow <cmd>      Manage workflows
 *   agentos schedule <cmd>      Manage schedules
 *   agentos jobs                View background jobs
 *   agentos research <cmd>      Autonomous research
 *   agentos connectors          Manage connectors
 *   agentos billing             View usage/costs
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
import { codemapCommand } from "./commands/codemap.js";

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

import { getVersion } from "./lib/version.js";

const program = new Command();

program
  .name("agentos")
  .description("AgentOS — Build, run, and deploy autonomous agents")
  .version(getVersion(), "-v, --version", "Display version number");

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
  .option("-s, --stream", "Stream output", true)
  .option("-v, --verbose", "Verbose output")
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
  .action(chatCommand);

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
  .description("Authenticate with AgentOS")
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
// Utility Commands
// ═════════════════════════════════════════════════════════════════════════════

program
  .command("codemap")
  .description("Generate visual code graph maps")
  .option("-o, --output <path>", "Output file")
  .option("--json", "Output as JSON")
  .action(codemapCommand);

// Parse arguments
program.parse();

// Show help if no args
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
