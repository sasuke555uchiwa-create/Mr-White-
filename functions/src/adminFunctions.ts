import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { adminAuth, db } from './firebaseAdmin';

/**
 * Verifies admin privilege strictly from server state (Firebase Custom Claims OR admins/{uid} doc)
 * and synchronizes the Auth custom claim if granted in admins/{uid}.
 */
export const checkAdminStatus = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const hasClaim = request.auth.token?.admin === true;

  const adminDoc = await db.collection('admins').doc(uid).get();
  const hasAdminRecord = adminDoc.exists && adminDoc.data()?.active !== false;

  const isAdmin = hasClaim || hasAdminRecord;

  if (hasAdminRecord && !hasClaim) {
    const userRecord = await adminAuth.getUser(uid);
    const existingClaims = userRecord.customClaims || {};
    await adminAuth.setCustomUserClaims(uid, { ...existingClaims, admin: true });
  } else if (!isAdmin && hasClaim) {
    const userRecord = await adminAuth.getUser(uid);
    const existingClaims = { ...(userRecord.customClaims || {}) };
    delete existingClaims.admin;
    await adminAuth.setCustomUserClaims(uid, existingClaims);
  }

  return {
    isAdmin,
    shouldRefreshToken: hasAdminRecord !== hasClaim,
  };
});
