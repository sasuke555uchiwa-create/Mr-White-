import { DbLike, FunctionActionError } from './errors';

export interface RateLimitRule {
  action: string;
  maxRequests: number;
  windowMs: number;
}

export interface RateLimitDeps {
  db: DbLike;
  now?: () => number;
}

export const RATE_LIMITS = {
  createRoom: { action: 'createRoom', maxRequests: 5, windowMs: 5 * 60_000 },
  joinRoom: { action: 'joinRoom', maxRequests: 20, windowMs: 60_000 },
  quickJoinRoom: { action: 'quickJoinRoom', maxRequests: 15, windowMs: 60_000 },
  sendRoomChat: { action: 'sendRoomChat', maxRequests: 20, windowMs: 30_000 },
  kickPlayer: { action: 'kickPlayer', maxRequests: 20, windowMs: 60_000 },
  toggleReady: { action: 'toggleReady', maxRequests: 30, windowMs: 60_000 },
  beginMatch: { action: 'beginMatch', maxRequests: 15, windowMs: 2 * 60_000 },
  startRound: { action: 'startRound', maxRequests: 15, windowMs: 2 * 60_000 },
  nextMatch: { action: 'nextMatch', maxRequests: 15, windowMs: 2 * 60_000 },
  submitClue: { action: 'submitClue', maxRequests: 15, windowMs: 60_000 },
  submitVote: { action: 'submitVote', maxRequests: 15, windowMs: 60_000 },
  submitMrWhiteGuess: { action: 'submitMrWhiteGuess', maxRequests: 10, windowMs: 60_000 },
  sendFriendRequest: { action: 'sendFriendRequest', maxRequests: 15, windowMs: 5 * 60_000 },
  respondFriendRequest: { action: 'respondFriendRequest', maxRequests: 30, windowMs: 5 * 60_000 },
  checkAdminStatus: { action: 'checkAdminStatus', maxRequests: 20, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Transactional fixed-window rate limiter backed by server-only Firestore documents (`rateLimits/{action}_{uid}`).
 * Throws FunctionActionError('resource-exhausted') when an authenticated caller exceeds the threshold.
 */
export async function enforceRateLimit(
  deps: RateLimitDeps,
  uid: string,
  rule: RateLimitRule
): Promise<void> {
  const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96);
  const safeAction = rule.action.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  const bucketRef = deps.db.collection('rateLimits').doc(`${safeAction}_${safeUid}`);
  const currentMs = deps.now ? deps.now() : Date.now();

  await deps.db.runTransaction(async (tx) => {
    const snap = await tx.get(bucketRef);
    const data = snap.exists ? snap.data() : undefined;
    const windowStart = typeof data?.windowStart === 'number' ? data.windowStart : 0;
    const count = typeof data?.count === 'number' ? data.count : 0;

    if (!snap.exists || currentMs - windowStart >= rule.windowMs) {
      tx.set(bucketRef, {
        uid: safeUid,
        action: safeAction,
        windowStart: currentMs,
        count: 1,
        expiresAt: currentMs + rule.windowMs,
      });
      return;
    }

    if (count >= rule.maxRequests) {
      throw new FunctionActionError(
        'resource-exhausted',
        `Rate limit exceeded for ${safeAction}. Please wait a moment before trying again.`
      );
    }

    tx.set(bucketRef, {
      uid: safeUid,
      action: safeAction,
      windowStart,
      count: count + 1,
      expiresAt: windowStart + rule.windowMs,
    });
  });
}
