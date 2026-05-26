export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`invalid config: ${field}: ${reason}`);
    this.name = "ConfigValidationError";
  }
}
