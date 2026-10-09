import {messages} from '../shared/messages.js';

export class AppError extends Error {
  constructor(status, code, messageKey) {
    super(messages.en[messageKey] || messages.en.request_failed);
    this.status = status;
    this.code = code;
    this.messageKey = messageKey;
  }
}
