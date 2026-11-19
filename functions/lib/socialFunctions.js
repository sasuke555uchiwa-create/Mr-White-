"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.removeFriend = exports.rejectFriendRequest = exports.acceptFriendRequest = exports.sendFriendRequest = void 0;
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firebaseAdmin_1 = require("./firebaseAdmin");
function assertSafeUid(uid) {
    if (typeof uid !== 'string' || !/^[a-zA-Z0-9_-]{3,128}$/.test(uid)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid target user ID.');
    }
    return uid;
}
function getFriendshipDocId(uidA, uidB) {
    return uidA < uidB
        ? { id: `${uidA}_${uidB}`, user1: uidA, user2: uidB }
        : { id: `${uidB}_${uidA}`, user1: uidB, user2: uidA };
}
exports.sendFriendRequest = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const fromId = request.auth.uid;
    const toId = assertSafeUid(request.data?.toId);
    if (fromId === toId) {
        throw new https_1.HttpsError('invalid-argument', 'Cannot send friend request to yourself.');
    }
    const friendshipMeta = getFriendshipDocId(fromId, toId);
    const forwardReqId = `${fromId}_${toId}`;
    const reverseReqId = `${toId}_${fromId}`;
    return firebaseAdmin_1.db.runTransaction(async (tx) => {
        const targetPublicRef = firebaseAdmin_1.db.collection('publicProfiles').doc(toId);
        const targetUserRef = firebaseAdmin_1.db.collection('users').doc(toId);
        const friendshipRef = firebaseAdmin_1.db.collection('friendships').doc(friendshipMeta.id);
        const forwardReqRef = firebaseAdmin_1.db.collection('friendRequests').doc(forwardReqId);
        const reverseReqRef = firebaseAdmin_1.db.collection('friendRequests').doc(reverseReqId);
        const [targetPubSnap, targetUserSnap, friendshipSnap, forwardSnap, reverseSnap] = await Promise.all([
            tx.get(targetPublicRef),
            tx.get(targetUserRef),
            tx.get(friendshipRef),
            tx.get(forwardReqRef),
            tx.get(reverseReqRef),
        ]);
        if (!targetPubSnap.exists && !targetUserSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Target user does not exist.');
        }
        if (friendshipSnap.exists) {
            return { success: false, message: 'alreadyFriends' };
        }
        if ((forwardSnap.exists && forwardSnap.data()?.status === 'pending') ||
            (reverseSnap.exists && reverseSnap.data()?.status === 'pending')) {
            return { success: false, message: 'friendRequestExists' };
        }
        tx.set(forwardReqRef, {
            fromId,
            toId,
            status: 'pending',
            createdAt: firestore_1.FieldValue.serverTimestamp(),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return { success: true, message: 'friendRequestSent', requestId: forwardReqId };
    });
});
exports.acceptFriendRequest = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const responderUid = request.auth.uid;
    const requestId = assertSafeUid(request.data?.requestId);
    return firebaseAdmin_1.db.runTransaction(async (tx) => {
        const reqRef = firebaseAdmin_1.db.collection('friendRequests').doc(requestId);
        const reqSnap = await tx.get(reqRef);
        if (!reqSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Friend request not found.');
        }
        const reqData = reqSnap.data();
        if (reqData.toId !== responderUid) {
            throw new https_1.HttpsError('permission-denied', 'Only the recipient can accept this request.');
        }
        if (reqData.status !== 'pending') {
            throw new https_1.HttpsError('failed-precondition', 'Friend request is no longer pending.');
        }
        const friendshipMeta = getFriendshipDocId(reqData.fromId, reqData.toId);
        const friendshipRef = firebaseAdmin_1.db.collection('friendships').doc(friendshipMeta.id);
        const existingFriendship = await tx.get(friendshipRef);
        tx.update(reqRef, {
            status: 'accepted',
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        if (!existingFriendship.exists) {
            tx.set(friendshipRef, {
                user1: friendshipMeta.user1,
                user2: friendshipMeta.user2,
                createdAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        return { success: true, friendshipId: friendshipMeta.id };
    });
});
exports.rejectFriendRequest = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const callerUid = request.auth.uid;
    const requestId = assertSafeUid(request.data?.requestId);
    return firebaseAdmin_1.db.runTransaction(async (tx) => {
        const reqRef = firebaseAdmin_1.db.collection('friendRequests').doc(requestId);
        const reqSnap = await tx.get(reqRef);
        if (!reqSnap.exists) {
            return { success: true };
        }
        const reqData = reqSnap.data();
        if (reqData.toId !== callerUid && reqData.fromId !== callerUid) {
            throw new https_1.HttpsError('permission-denied', 'Not authorized to cancel this friend request.');
        }
        tx.delete(reqRef);
        return { success: true };
    });
});
exports.removeFriend = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const callerUid = request.auth.uid;
    const friendUid = assertSafeUid(request.data?.friendUid);
    const { id } = getFriendshipDocId(callerUid, friendUid);
    await firebaseAdmin_1.db.collection('friendships').doc(id).delete();
    return { success: true };
});
//# sourceMappingURL=socialFunctions.js.map