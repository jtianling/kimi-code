export function sessionProcessEnv(sessionId: string): Record<string, string> {
  return { KIMI_XATS_SESSION_ID: sessionId };
}
