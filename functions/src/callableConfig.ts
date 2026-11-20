import { CallableOptions } from 'firebase-functions/v2/https';

/**
 * Enable strict Firebase App Check enforcement in production by setting
 * ENFORCE_APP_CHECK=true in Cloud Functions environment configuration once
 * VITE_FIREBASE_APPCHECK_SITE_KEY is configured on the web client.
 */
export const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

export function getCallableOptions(overrides: Partial<CallableOptions> = {}): CallableOptions {
  return {
    enforceAppCheck: ENFORCE_APP_CHECK,
    consumeAppCheckToken: false,
    ...overrides,
  };
}
