export interface NotificationEmailSender {
  send(input: {
    recipient: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }>;
}

export class FakeNotificationEmailSender implements NotificationEmailSender {
  readonly sentEmails: Array<{
    recipient: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
    messageId: string;
  }> = [];

  shouldFail = false;
  failureMessage = 'Fake email error';

  async send(input: {
    recipient: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ messageId: string }> {
    if (this.shouldFail) {
      throw new Error(this.failureMessage);
    }
    const messageId = `msg_${Math.random().toString(36).slice(2, 12)}`;
    this.sentEmails.push({ ...input, messageId });
    return { messageId };
  }
}
