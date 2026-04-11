export class ChatError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'ChatError';
    this.status = status;
    this.code = code;
  }
}

export const isChatError = (error: unknown): error is ChatError => error instanceof ChatError;
