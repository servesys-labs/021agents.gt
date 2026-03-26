/**
 * Security command - Security scanning and findings
 */
import chalk from "chalk";
import ora from "ora";
import { apiGet, apiPost } from "../lib/api.js";

interface Scan {
  scan_id: string;
  agent_name: string;
  scan_type: string;
  risk_score: number;
  risk_level: string;
  total_probes: number;
  passed: number;
  failed: number;
  started_at: string;
}

interface Finding {
  finding_id: string;
  probe_id: string;
  severity: string;
  title: string;
  description: string;
  aivss_score: number;
  remediation?: string;
}

export const securityCommand = {
  async list(options: {
    agent?: string;
    limit?: number;
  }): Promise<void> {
    const spinner = ora("Loading scans...").start();
    try {
      const params = new URLSearchParams();
      if (options.agent) params.set("agent_name", options.agent);
      if (options.limit) params.set("limit", String(options.limit));

      const data = await apiGet<{ scans: Scan[] }>(`/api/v1/security/scans?${params}`);
      spinner.stop();

      if (data.scans.length === 0) {
        console.log(chalk.yellow("No security scans found."));
        return;
      }

      console.log(chalk.blue(`\n${data.scans.length} scan(s):\n`));
      console.log(
        "ID".padEnd(12) +
        "Agent".padEnd(20) +
        "Risk".padEnd(10) +
        "Score".padEnd(8) +
        "Passed".padEnd(8) +
        "Failed"
      );
      console.log(chalk.gray("─".repeat(80)));

      for (const scan of data.scans) {
        const riskColor = scan.risk_level === "critical" ? chalk.red :
                         scan.risk_level === "high" ? chalk.red :
                         scan.risk_level === "medium" ? chalk.yellow : chalk.green;

        console.log(
          scan.scan_id.slice(0, 10).padEnd(12) +
          scan.agent_name.slice(0, 18).padEnd(20) +
          riskColor(scan.risk_level.padEnd(10)) +
          scan.risk_score.toFixed(1).padEnd(8) +
          String(scan.passed).padEnd(8) +
          (scan.failed > 0 ? chalk.red(String(scan.failed)) : chalk.green("0"))
        );
      }
      console.log();
    } catch (error) {
      spinner.fail("Failed to load scans");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async scan(agentName: string, options: {
    type?: string;
  }): Promise<void> {
    const spinner = ora(`Scanning ${agentName}...`).start();
    try {
      const result = await apiPost<{
        scan_id: string;
        status: string;
      }>("/api/v1/security/scans", {
        agent_name: agentName,
        scan_type: options.type || "config",
      });

      spinner.succeed("Scan initiated!");
      console.log(chalk.blue(`Scan ID: ${result.scan_id}`));
      console.log(chalk.gray(`Check results: agentos security findings --scan ${result.scan_id}`));
    } catch (error) {
      spinner.fail("Scan failed");
      console.error(chalk.red(error));
      process.exit(1);
    }
  },

  async findings(options: {
    scan?: string;
    agent?: string;
    severity?: string;
  }): Promise<void> {
    try {
      const params = new URLSearchParams();
      if (options.scan) params.set("scan_id", options.scan);
      if (options.agent) params.set("agent_name", options.agent);
      if (options.severity) params.set("severity", options.severity);

      const data = await apiGet<{ findings: Finding[] }>(`/api/v1/security/findings?${params}`);

      if (data.findings.length === 0) {
        console.log(chalk.green("No security findings! 🎉"));
        return;
      }

      console.log(chalk.blue(`\n${data.findings.length} finding(s):\n`));

      for (const f of data.findings.slice(0, 20)) {
        const sevColor = f.severity === "critical" ? chalk.red :
                        f.severity === "high" ? chalk.red :
                        f.severity === "medium" ? chalk.yellow : chalk.gray;

        console.log(`${sevColor(`[${f.severity.toUpperCase()}]`)} ${chalk.bold(f.title)}`);
        console.log(chalk.gray(`  AIVSS: ${f.aivss_score.toFixed(1)} | ${f.probe_id}`));
        if (f.description) {
          console.log(chalk.gray(`  ${f.description.slice(0, 100)}${f.description.length > 100 ? "..." : ""}`));
        }
        if (f.remediation) {
          console.log(chalk.green(`  Fix: ${f.remediation.slice(0, 60)}...`));
        }
        console.log();
      }
    } catch (error) {
      console.error(chalk.red("Failed to get findings:"), error);
      process.exit(1);
    }
  },

  async probes(): Promise<void> {
    try {
      const data = await apiGet<{ probes: Array<{
        id: string;
        name: string;
        category: string;
        description: string;
      }> }>("/api/v1/security/probes");

      console.log(chalk.blue(`\n${data.probes.length} security probe(s):\n`));

      const byCategory: Record<string, typeof data.probes> = {};
      for (const p of data.probes) {
        byCategory[p.category] = byCategory[p.category] || [];
        byCategory[p.category].push(p);
      }

      for (const [cat, probes] of Object.entries(byCategory)) {
        console.log(chalk.bold(cat));
        for (const p of probes) {
          console.log(`  ${p.name}`);
          console.log(chalk.gray(`    ${p.description.slice(0, 60)}...`));
        }
        console.log();
      }
    } catch (error) {
      console.error(chalk.red("Failed to get probes:"), error);
      process.exit(1);
    }
  },
};
