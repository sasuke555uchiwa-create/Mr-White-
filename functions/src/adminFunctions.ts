import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { executeCheckAdminStatus } from './adminPolicy';
import { DbLike, FunctionActionError } from './errors';
import { adminAuth, db } from './firebaseAdmin';

/**
 * Verifies admin privilege strictly from server state (admins/{uid}.active === true)
 * and grants or revokes Firebase Auth custom claims accordingly.
 */
export const checkAdminStatus = onCall(async (request) => {
  try {
    const result = await executeCheckAdminStatus(
      { db: db as unknown as DbLike, adminAuth },
      {
        uid: request.auth?.uid,
        token: request.auth?.token as Record<string, any> | undefined,
      }
    );
    return {
      isAdmin: result.isAdmin,
      shouldRefreshToken: result.shouldRefreshToken,
    };
  } catch (err) {
    if (err instanceof FunctionActionError) {
      throw new HttpsError(err.code, err.message);
    }
    throw err;
  }
});
