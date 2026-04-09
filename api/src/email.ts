import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST!,
  port: parseInt(process.env.SMTP_PORT ?? "587"),
  secure: false, // STARTTLS via requireTLS
  requireTLS: (process.env.SMTP_STARTTLS ?? "true") === "true",
  auth: {
    user: process.env.SMTP_USER!,
    pass: process.env.SMTP_PASSWORD!,
  },
});

export async function sendEmail(opts: {
  to: string[];
  subject: string;
  text: string;
}): Promise<void> {
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM!,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
    });
  } catch {
    throw new Error("Email delivery failed");
  }
}
