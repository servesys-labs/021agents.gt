/**
 * Transactional email via MailChannels (free for Cloudflare Workers).
 *
 * MailChannels provides free outbound email for any Cloudflare Worker.
 * No API keys needed — they verify the request comes from a CF Worker.
 *
 * Requires DNS TXT record for SPF:
 *   oneshots.co TXT "v=spf1 a mx include:relay.mailchannels.net ~all"
 *
 * Optional DKIM setup for better deliverability.
 */

const FROM_EMAIL = "noreply@oneshots.co";
const FROM_NAME = "OneShots";
const APP_URL = "https://app.oneshots.co";

interface SendEmailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email via MailChannels API (free for CF Workers).
 * Returns true on success, false on failure (never throws).
 */
export async function sendEmail(opts: SendEmailOptions): Promise<boolean> {
  try {
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: opts.to }],
          },
        ],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject: opts.subject,
        content: [
          ...(opts.html ? [{ type: "text/html", value: opts.html }] : []),
          { type: "text/plain", value: opts.text },
        ],
      }),
    });

    if (!resp.ok) {
      const err = await resp.text().catch(() => "unknown");
      console.error(`[email] MailChannels error ${resp.status}: ${err}`);
      return false;
    }

    console.log(`[email] Sent "${opts.subject}" to ${opts.to}`);
    return true;
  } catch (err) {
    console.error("[email] Send failed:", err);
    return false;
  }
}

/**
 * Send password reset email.
 */
export async function sendPasswordResetEmail(email: string, token: string): Promise<boolean> {
  const resetUrl = `${APP_URL}/login?reset_token=${token}`;
  return sendEmail({
    to: email,
    subject: "Reset your OneShots password",
    text: `You requested a password reset for your OneShots account.\n\nClick this link to reset your password (expires in 1 hour):\n${resetUrl}\n\nIf you didn't request this, you can safely ignore this email.\n\n— OneShots`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; color: #1a1a1a; margin-bottom: 16px;">Reset your password</h2>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          You requested a password reset for your OneShots account. Click the button below to set a new password.
        </p>
        <div style="margin: 24px 0;">
          <a href="${resetUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500;">
            Reset password
          </a>
        </div>
        <p style="color: #999; font-size: 12px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #bbb; font-size: 11px;">OneShots — the open agent economy</p>
      </div>
    `,
  });
}

/**
 * Send email verification email.
 */
export async function sendVerificationEmail(email: string, token: string): Promise<boolean> {
  const verifyUrl = `${APP_URL}/login?verify_token=${token}`;
  return sendEmail({
    to: email,
    subject: "Verify your OneShots email",
    text: `Welcome to OneShots!\n\nPlease verify your email address by clicking this link:\n${verifyUrl}\n\nThis link expires in 24 hours.\n\n— OneShots`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; color: #1a1a1a; margin-bottom: 16px;">Welcome to OneShots</h2>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Please verify your email address to get started.
        </p>
        <div style="margin: 24px 0;">
          <a href="${verifyUrl}" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500;">
            Verify email
          </a>
        </div>
        <p style="color: #999; font-size: 12px;">This link expires in 24 hours.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #bbb; font-size: 11px;">OneShots — the open agent economy</p>
      </div>
    `,
  });
}

/**
 * Send welcome email after signup.
 */
export async function sendWelcomeEmail(email: string, name: string): Promise<boolean> {
  return sendEmail({
    to: email,
    subject: "Welcome to OneShots",
    text: `Hi ${name},\n\nWelcome to OneShots — the open agent economy.\n\nYour account is ready. Here's what you can do:\n\n1. Create AI agents with tools like web search, code execution, and data analysis\n2. Publish them to the marketplace for others to use\n3. Earn credits when your agents complete tasks\n\nGet started: ${APP_URL}/dashboard\n\nYour referral code lets you invite others and earn from their transactions.\n\n— The OneShots Team`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 0;">
        <h2 style="font-size: 20px; color: #1a1a1a; margin-bottom: 16px;">Welcome to OneShots, ${name}!</h2>
        <p style="color: #555; font-size: 14px; line-height: 1.6;">
          Your account is ready. Here's what you can do:
        </p>
        <ul style="color: #555; font-size: 14px; line-height: 1.8; padding-left: 20px;">
          <li>Create AI agents with tools like web search, code execution, and data analysis</li>
          <li>Publish them to the marketplace for others to use</li>
          <li>Earn credits when your agents complete tasks</li>
        </ul>
        <div style="margin: 24px 0;">
          <a href="${APP_URL}/dashboard" style="display: inline-block; padding: 12px 24px; background: #2563eb; color: #fff; text-decoration: none; border-radius: 8px; font-size: 14px; font-weight: 500;">
            Go to dashboard
          </a>
        </div>
        <p style="color: #999; font-size: 12px;">Your referral code lets you invite others and earn from their transactions.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #bbb; font-size: 11px;">OneShots — the open agent economy</p>
      </div>
    `,
  });
}
