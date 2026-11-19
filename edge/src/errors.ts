/** An error that maps directly onto an HTTP status. The message is safe to show to the sender. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message)
  }
}

export const badRequest = (reason: string): HttpError => new HttpError(400, reason)
export const tooLarge = (reason: string): HttpError => new HttpError(413, reason)
