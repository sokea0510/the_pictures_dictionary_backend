const nodemailer = require("nodemailer");

let transporter;

const getTransporter = () => {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true") !== "false";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    throw new Error("SMTP_USER and SMTP_PASS must be configured for email OTP login.");
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
  return transporter;
};

async function sendLoginOtpEmail({ to, code, expiresMinutes }) {
  const from = process.env.SMTP_FROM || `Picture Dictionary <${process.env.SMTP_USER || "info.picturedictionary@gmail.com"}>`;
  const appName = process.env.APP_NAME || "Picture Dictionary";
  const minutes = Number(expiresMinutes || process.env.LOGIN_OTP_EXPIRES_MINUTES || 10);

  await getTransporter().sendMail({
    from,
    to,
    subject: `${appName} login verification code`,
    text: [
      `Your ${appName} login verification code is: ${code}`,
      "",
      `This code expires in ${minutes} minutes.`,
      "If you did not request this login, you can ignore this email.",
    ].join("\n"),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        <h2 style="margin:0 0 12px">${appName} login verification</h2>
        <p>Your 6-digit verification code is:</p>
        <div style="font-size:28px;font-weight:700;letter-spacing:6px;background:#f3f4f6;border-radius:12px;padding:16px 20px;display:inline-block">${code}</div>
        <p style="margin-top:16px;color:#4b5563">This code expires in ${minutes} minutes.</p>
        <p style="color:#6b7280;font-size:13px">If you did not request this login, you can ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { sendLoginOtpEmail };
