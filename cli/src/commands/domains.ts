/**
 * Domains command - Custom domain management
 */
import chalk from "chalk";
import { apiGet, apiPost, apiDelete } from "../lib/api.js";

interface Domain {
  id: string;
  hostname: string;
  type: "subdomain" | "custom";
  status: string;
  ssl_status: string;
  verified_at: string | null;
  created_at: string;
  dns_records?: DnsRecord[];
}

interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

interface DomainCreateResponse {
  id: string;
  hostname: string;
  type: string;
  dns_records?: DnsRecord[];
}

interface DomainVerifyResponse {
  verified: boolean;
  hostname: string;
  message?: string;
}

export const domainsCommand = {
  async list(): Promise<void> {
    try {
      const domains = await apiGet<Domain[]>("/api/v1/domains");

      if (domains.length === 0) {
        console.log(chalk.yellow("No custom domains configured."));
        console.log(chalk.gray("Add one with: agentos domains add --hostname <host>"));
        return;
      }

      console.log(chalk.blue(`\n${domains.length} domain(s):\n`));

      console.log(
        "Hostname".padEnd(32) +
        "Type".padEnd(12) +
        "Status".padEnd(14) +
        "SSL".padEnd(14) +
        "Verified"
      );
      console.log(chalk.gray("─".repeat(90)));

      for (const d of domains) {
        const statusColor =
          d.status === "active" ? chalk.green :
          d.status === "pending" ? chalk.yellow :
          d.status === "error" ? chalk.red :
          chalk.gray;

        const sslColor =
          d.ssl_status === "active" ? chalk.green :
          d.ssl_status === "pending" ? chalk.yellow :
          chalk.red;

        const verified = d.verified_at
          ? chalk.green(new Date(d.verified_at).toLocaleDateString())
          : chalk.gray("pending");

        console.log(
          d.hostname.slice(0, 30).padEnd(32) +
          d.type.padEnd(12) +
          statusColor(d.status.padEnd(14)) +
          sslColor(d.ssl_status.padEnd(14)) +
          verified
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to list domains:"), error);
      process.exit(1);
    }
  },

  async add(options: { type?: string; hostname?: string }): Promise<void> {
    try {
      if (!options.hostname) {
        console.error(chalk.red("--hostname is required"));
        process.exit(1);
      }

      const domainType = options.type || "custom";
      if (domainType !== "subdomain" && domainType !== "custom") {
        console.error(chalk.red('--type must be "subdomain" or "custom"'));
        process.exit(1);
      }

      const result = await apiPost<DomainCreateResponse>("/api/v1/domains", {
        type: domainType,
        hostname: options.hostname,
      });

      console.log(chalk.green("\n✓ Domain added\n"));
      console.log(`Domain ID: ${result.id}`);
      console.log(`Hostname:  ${result.hostname}`);
      console.log(`Type:      ${result.type}`);

      if (result.dns_records && result.dns_records.length > 0) {
        console.log(chalk.yellow("\nDNS Configuration Required:"));
        console.log(
          chalk.gray("Add the following DNS records to your domain provider:\n")
        );

        console.log(
          "  " + "Type".padEnd(10) + "Name".padEnd(30) + "Value"
        );
        console.log(chalk.gray("  " + "─".repeat(70)));

        for (const record of result.dns_records) {
          console.log(
            "  " +
            record.type.padEnd(10) +
            record.name.padEnd(30) +
            record.value
          );
        }

        console.log(
          chalk.gray(`\nAfter adding DNS records, verify with: agentos domains verify ${result.id}`)
        );
      }
      console.log();
    } catch (error) {
      console.error(chalk.red("Failed to add domain:"), error);
      process.exit(1);
    }
  },

  async verify(domainId: string): Promise<void> {
    try {
      const result = await apiPost<DomainVerifyResponse>(
        `/api/v1/domains/${domainId}/verify`,
        {}
      );

      if (result.verified) {
        console.log(chalk.green(`✓ Domain ${result.hostname} verified successfully`));
      } else {
        console.log(chalk.yellow(`✗ Domain ${result.hostname} verification failed`));
        if (result.message) {
          console.log(chalk.gray(`  ${result.message}`));
        }
        console.log(
          chalk.gray("\nEnsure DNS records are configured and propagated, then try again.")
        );
      }
    } catch (error) {
      console.error(chalk.red("Failed to verify domain:"), error);
      process.exit(1);
    }
  },

  async remove(domainId: string): Promise<void> {
    try {
      await apiDelete(`/api/v1/domains/${domainId}`);
      console.log(chalk.green(`✓ Domain ${domainId} removed`));
    } catch (error) {
      console.error(chalk.red("Failed to remove domain:"), error);
      process.exit(1);
    }
  },
};
