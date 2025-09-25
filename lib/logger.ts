/**
 * Structured logging with request correlation
 */

export interface LogContext {
  requestId?: string;
  userId?: string;
  path?: string;
  method?: string;
  duration?: number;
  [key: string]: unknown;
}

export class Logger {
  private context: LogContext;

  constructor(context: LogContext = {}) {
    this.context = context;
  }

  private formatMessage(level: string, message: string, extra?: Record<string, unknown>) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...this.context,
      ...extra,
    };

    return JSON.stringify(logEntry);
  }

  info(message: string, extra?: Record<string, unknown>) {
    console.log(this.formatMessage("INFO", message, extra));
  }

  warn(message: string, extra?: Record<string, unknown>) {
    console.warn(this.formatMessage("WARN", message, extra));
  }

  error(message: string, error?: Error | unknown, extra?: Record<string, unknown>) {
    const errorInfo = error instanceof Error 
      ? { error: error.message, stack: error.stack }
      : { error: String(error) };
    
    console.error(this.formatMessage("ERROR", message, { ...errorInfo, ...extra }));
  }

  debug(message: string, extra?: Record<string, unknown>) {
    if (process.env.NODE_ENV === "development") {
      console.debug(this.formatMessage("DEBUG", message, extra));
    }
  }

  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.context, ...additionalContext });
  }
}

export function createLogger(context: LogContext = {}): Logger {
  return new Logger(context);
}

export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}