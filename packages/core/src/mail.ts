/**
 * Outbound mail.
 *
 * An interface plus a development implementation. The real provider drops in
 * behind the same shape without touching a call site.
 *
 * ---------------------------------------------------------------------------
 * Mail failure must never roll back a signup
 * ---------------------------------------------------------------------------
 *
 * By the time the verification email is sent, the transaction that created the
 * company and the owner user has already committed — deliberately, because an
 * interactive transaction must not be held open across a network call to a
 * third party. So a send failure cannot undo the account even in principle.
 *
 * Which means: catch it, log it, and carry on. Letting a mail error propagate
 * out of signup would show the user a failure page for an account that exists,
 * and they would then try to register again and be told their email is taken.
 * The recovery path for an unsent verification email is the resend button, not
 * a rollback.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface Mailer {
  sendMail(message: MailMessage): Promise<void>;
}

/**
 * Development mailer: writes the message to the server log.
 *
 * The verification URL is printed in full and on its own line, because the only
 * way to complete a signup locally is to copy it out of the terminal.
 */
export function createConsoleMailer(): Mailer {
  return {
    async sendMail(message: MailMessage): Promise<void> {
      // eslint-disable-next-line no-console
      console.info(
        [
          "",
          "──────────────────────────────────────────────",
          " mail (console transport — not actually sent)",
          "──────────────────────────────────────────────",
          ` to:      ${message.to}`,
          ` subject: ${message.subject}`,
          "",
          message.text,
          "──────────────────────────────────────────────",
          "",
        ].join("\n"),
      );
    },
  };
}

/**
 * Send without letting a failure reach the caller.
 *
 * Every send in the signup path goes through this. See the note above: the
 * account already exists, so a throw here can only produce a misleading error.
 */
export async function sendMailSafely(
  mailer: Mailer,
  message: MailMessage,
): Promise<boolean> {
  try {
    await mailer.sendMail(message);
    return true;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `Failed to send "${message.subject}" to ${message.to}:`,
      error,
    );
    return false;
  }
}
