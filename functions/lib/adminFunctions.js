"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkAdminStatus = void 0;
const https_1 = require("firebase-functions/v2/https");
const firebaseAdmin_1 = require("./firebaseAdmin");
/**
 * Verifies admin privilege strictly from server state (Firebase Custom Claims OR admins/{uid} doc)
 * and synchronizes the Auth custom claim if granted in admins/{uid}.
 */
exports.checkAdminStatus = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const hasClaim = request.auth.token?.admin === true;
    const adminDoc = await firebaseAdmin_1.db.collection('admins').doc(uid).get();
    const hasAdminRecord = adminDoc.exists && adminDoc.data()?.active !== false;
    const isAdmin = hasClaim || hasAdminRecord;
    if (hasAdminRecord && !hasClaim) {
        const userRecord = await firebaseAdmin_1.adminAuth.getUser(uid);
        const existingClaims = userRecord.customClaims || {};
        await firebaseAdmin_1.adminAuth.setCustomUserClaims(uid, { ...existingClaims, admin: true });
    }
    else if (!isAdmin && hasClaim) {
        const userRecord = await firebaseAdmin_1.adminAuth.getUser(uid);
        const existingClaims = { ...(userRecord.customClaims || {}) };
        delete existingClaims.admin;
        await firebaseAdmin_1.adminAuth.setCustomUserClaims(uid, existingClaims);
    }
    return {
        isAdmin,
        shouldRefreshToken: hasAdminRecord !== hasClaim,
    };
});
//# sourceMappingURL=adminFunctions.js.map