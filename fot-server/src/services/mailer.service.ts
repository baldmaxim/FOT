import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

export const mailerService = {
  isConfigured(): boolean {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  },

  async sendWithAttachment(params: {
    to: string;
    subject: string;
    text: string;
    attachments: Array<{ filename: string; content: Buffer; contentType: string }>;
  }): Promise<void> {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@example.com';
    await transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      attachments: params.attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    });
  },
};
