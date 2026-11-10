/** JSON response statuses actually emitted by the shared CRM/agent handlers.
 * Type-only, with no server initialization or framework runtime dependency. */
export type JsonHttpStatus =
  | 200
  | 201
  | 202
  | 400
  | 401
  | 403
  | 404
  | 409
  | 422
  | 429
  | 500
  | 502
  | 503;
