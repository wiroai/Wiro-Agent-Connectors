export interface FailureDetails {
  /** The vendor's HTTP status, when the failure came from one. */
  status?: number;
  /** Seconds to wait before retrying, when the vendor said so. */
  retryAfter?: number;
  /** The vendor's own error code, when its reply had one, e.g. "ExpiredToken". */
  vendorCode?: string;
}

/**
 * A failure the caller can act on, with a message that says what happened.
 * For a write tool it also means the change was not made.
 */
export class ToolFailure extends Error {
  readonly details: FailureDetails;

  constructor(message: string, details: FailureDetails = {}) {
    super(message);
    this.name = 'ToolFailure';
    this.details = details;
  }
}

/**
 * A write request was sent and no clear answer came back (a timeout, a broken
 * connection, a 5xx). The change may or may not have been made, so the result
 * tells the caller which read tool to check before trying again.
 */
export class OutcomeUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeUnknown';
  }
}
