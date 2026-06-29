// PermanentError is thrown when a message can never succeed regardless of retries:
//  - the object exceeds MAX_FILE_SIZE_BYTES
//  - the ROOTKey API rejects with a 4xx (other than 429)
//
// The Cloudflare Queue runs retries externally (up to `max_retries`), then sends
// the message to the dead-letter queue. For a PermanentError that retry budget is
// wasted, so the queue consumer catches it, emits a structured log marker, and
// acks the message — bypassing both queue retries and the DLQ.
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}
