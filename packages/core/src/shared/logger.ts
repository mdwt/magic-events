// The logger the core writes to. It belongs to no domain. Pino fits it as it is.
// The context comes first and the message second, so every line carries its details as fields.
export interface Logger {
  debug(context: object, message: string): void;
  info(context: object, message: string): void;
  warn(context: object, message: string): void;
  error(context: object, message: string): void;
  // A logger that adds the given context to every line it writes.
  child(context: object): Logger;
}
