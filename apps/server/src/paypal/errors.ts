/** A failed PayPal REST call (also thrown by the mock so both behave the same). */
export class PayPalApiError extends Error {
  constructor(
    public readonly status: number, // HTTP status
    public readonly paypalName: string, // e.g. "UNPROCESSABLE_ENTITY"
    public readonly issue: string | undefined, // e.g. "MAX_CAPTURE_AMOUNT_EXCEEDED"
    public readonly debugId: string | undefined, // quote this if you ask PayPal support
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }

  toJSON() {
    return { status: this.status, name: this.paypalName, issue: this.issue ?? null, debugId: this.debugId ?? null, message: this.message };
  }
}

export const isPayPalIssue = (err: unknown, issue: string) => err instanceof PayPalApiError && err.issue === issue;
