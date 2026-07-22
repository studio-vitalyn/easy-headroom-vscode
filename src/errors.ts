// Node's fetch (undici) throws a bare "fetch failed" TypeError on any network/TLS failure —
// the actual reason (e.g. a corporate MITM proxy's cert rejected by Node's own CA store, unlike
// curl which trusts the system keychain) lives in err.cause, not err.message.
export function formatError(err: unknown): string {
  const e = err as Error & { cause?: unknown };
  const parts = [e.message];
  let cause = e.cause;
  while (cause) {
    if (cause instanceof Error) {
      parts.push(cause.message);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      break;
    }
  }
  return parts.join(' — caused by: ');
}
