import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from './firebaseAdmin';

function assertSafeUid(uid: unknown): string {
  if (typeof uid !== 'string' || !/^[a-zA-Z0-9_-]{3,128}$/.test(uid)) {
    throw new HttpsError('invalid-argument', 'Invalid target user ID.');
  }
  return uid;
}

function getFriendshipDocId(uidA: string, uidB: string): { id: string; user1: string; user2: string } {
  return uidA < uidB
    ? { id: `${uidA}_${uidB}`, user1: uidA, user2: uidB }
    : { id: `${uidB}_${uidA}`, user1: uidB, user2: uidA };
}

export const sendFriendRequest = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const fromId = request.auth.uid;
  const toId = assertSafeUid(request.data?.toId);

  if (fromId === toId) {
    throw new HttpsError('invalid-argument', 'Cannot send friend request to yourself.');
  }

  const friendshipMeta = getFriendshipDocId(fromId, toId);
  const forwardReqId = `${fromId}_${toId}`;
  const reverseReqId = `${toId}_${fromId}`;

  return db.runTransaction(async (tx) => {
    const targetPublicRef = db.collection('publicProfiles').doc(toId);
    const targetUserRef = db.collection('users').doc(toId);
    const friendshipRef = db.collection('friendships').doc(friendshipMeta.id);
    const forwardReqRef = db.collection('friendRequests').doc(forwardReqId);
    const reverseReqRef = db.collection('friendRequests').doc(reverseReqId);

    const [targetPubSnap, targetUserSnap, friendshipSnap, forwardSnap, reverseSnap] =
      await Promise.all([
        tx.get(targetPublicRef),
        tx.get(targetUserRef),
        tx.get(friendshipRef),
        tx.get(forwardReqRef),
        tx.get(reverseReqRef),
      ]);

    if (!targetPubSnap.exists && !targetUserSnap.exists) {
      throw new HttpsError('not-found', 'Target user does not exist.');
    }

    if (friendshipSnap.exists) {
      return { success: false, message: 'alreadyFriends' };
    }

    if (
      (forwardSnap.exists && forwardSnap.data()?.status === 'pending') ||
      (reverseSnap.exists && reverseSnap.data()?.status === 'pending')
    ) {
      return { success: false, message: 'friendRequestExists' };
    }

    tx.set(forwardReqRef, {
      fromId,
      toId,
      status: 'pending',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, message: 'friendRequestSent', requestId: forwardReqId };
  });
});

export const acceptFriendRequest = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const responderUid = request.auth.uid;
  const requestId = assertSafeUid(request.data?.requestId);

  return db.runTransaction(async (tx) => {
    const reqRef = db.collection('friendRequests').doc(requestId);
    const reqSnap = await tx.get(reqRef);

    if (!reqSnap.exists) {
      throw new HttpsError('not-found', 'Friend request not found.');
    }

    const reqData = reqSnap.data()!;
    if (reqData.toId !== responderUid) {
      throw new HttpsError('permission-denied', 'Only the recipient can accept this request.');
    }
    if (reqData.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'Friend request is no longer pending.');
    }

    const friendshipMeta = getFriendshipDocId(reqData.fromId, reqData.toId);
    const friendshipRef = db.collection('friendships').doc(friendshipMeta.id);
    const existingFriendship = await tx.get(friendshipRef);

    tx.update(reqRef, {
      status: 'accepted',
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (!existingFriendship.exists) {
      tx.set(friendshipRef, {
        user1: friendshipMeta.user1,
        user2: friendshipMeta.user2,
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    return { success: true, friendshipId: friendshipMeta.id };
  });
});

export const rejectFriendRequest = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const callerUid = request.auth.uid;
  const requestId = assertSafeUid(request.data?.requestId);

  return db.runTransaction(async (tx) => {
    const reqRef = db.collection('friendRequests').doc(requestId);
    const reqSnap = await tx.get(reqRef);

    if (!reqSnap.exists) {
      return { success: true };
    }

    const reqData = reqSnap.data()!;
    if (reqData.toId !== callerUid && reqData.fromId !== callerUid) {
      throw new HttpsError('permission-denied', 'Not authorized to cancel this friend request.');
    }

    tx.delete(reqRef);
    return { success: true };
  });
});

export const removeFriend = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const callerUid = request.auth.uid;
  const friendUid = assertSafeUid(request.data?.friendUid);
  const { id } = getFriendshipDocId(callerUid, friendUid);

  await db.collection('friendships').doc(id).delete();
  return { success: true };
});
