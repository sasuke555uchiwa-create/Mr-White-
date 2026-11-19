import { randomInt } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from './firebaseAdmin';
import { ServerRoomPlayer, buildServerTurnOrder, evaluateOnlineWin } from './gameLogic';
import {
  PrivateGameStateDoc,
  applyMatchSettlementWrites,
  readPlayerProfileDocs,
} from './matchSettlement';

const ALLOWED_LANGUAGES = new Set(['ar', 'en', 'fr', 'es', 'de', 'tr', 'pt']);
const ALLOWED_CATEGORIES = new Set(['standard', 'animals', 'food', 'places', 'objects']);

function sanitizeRoomSettings(raw: any) {
  const maxPlayersNum = Number(raw?.maxPlayers ?? 8);
  const maxPlayers = Number.isFinite(maxPlayersNum)
    ? Math.max(3, Math.min(10, Math.round(maxPlayersNum)))
    : 8;

  const language =
    typeof raw?.language === 'string' && ALLOWED_LANGUAGES.has(raw.language)
      ? raw.language
      : 'ar';

  const category =
    typeof raw?.category === 'string' && ALLOWED_CATEGORIES.has(raw.category)
      ? raw.category
      : 'standard';

  const difficulty: 'easy' | 'hard' = raw?.difficulty === 'hard' ? 'hard' : 'easy';

  const turnNum = Number(raw?.turnDurationSeconds ?? 45);
  const turnDurationSeconds = Number.isFinite(turnNum)
    ? Math.max(15, Math.min(180, Math.round(turnNum)))
    : 45;

  const isPrivate = Boolean(raw?.isPrivate);

  return { maxPlayers, language, category, difficulty, turnDurationSeconds, isPrivate };
}

function generateRoomCode(): string {
  return String(randomInt(100000, 1000000));
}

async function resolveCallerPlayerInfo(uid: string, authToken: any): Promise<{
  name: string;
  avatar: string;
}> {
  const [pubSnap, userSnap] = await Promise.all([
    db.collection('publicProfiles').doc(uid).get(),
    db.collection('users').doc(uid).get(),
  ]);
  const src = (pubSnap.exists ? pubSnap.data() : userSnap.exists ? userSnap.data() : null) || {};
  const rawName =
    (typeof src.displayName === 'string' && src.displayName.trim()) ||
    (typeof authToken?.name === 'string' && authToken.name.trim()) ||
    'لاعب جديد';
  const rawAvatar =
    (typeof src.photoURL === 'string' && src.photoURL) ||
    (typeof authToken?.picture === 'string' && authToken.picture) ||
    `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`;
  return {
    name: rawName.slice(0, 40),
    avatar: rawAvatar.slice(0, 2097152),
  };
}

async function cleanupEmptyRoomDocs(roomId: string): Promise<void> {
  const roomRef = db.collection('rooms').doc(roomId);
  const [privatePlayersSnap, metaSnap, stateSnap] = await Promise.all([
    roomRef.collection('privatePlayers').get(),
    roomRef.collection('privateMeta').doc('invite').get(),
    roomRef.collection('privateState').doc('current').get(),
  ]);

  const batch = db.batch();
  privatePlayersSnap.docs.forEach((d) => batch.delete(d.ref));
  if (metaSnap.exists) {
    const code = metaSnap.data()?.secretCode;
    if (typeof code === 'string' && code) {
      batch.delete(db.collection('roomCodes').doc(code));
    }
    batch.delete(metaSnap.ref);
  }
  if (stateSnap.exists) {
    batch.delete(stateSnap.ref);
  }
  batch.delete(roomRef);
  await batch.commit();
}

export const createRoom = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const settings = sanitizeRoomSettings(request.data || {});
  const hostInfo = await resolveCallerPlayerInfo(uid, request.auth.token);

  for (let attempt = 0; attempt < 5; attempt++) {
    const secretCode = generateRoomCode();
    const roomRef = db.collection('rooms').doc();
    const codeRef = db.collection('roomCodes').doc(secretCode);
    const metaRef = roomRef.collection('privateMeta').doc('invite');

    try {
      await db.runTransaction(async (tx) => {
        const [codeSnap, userSnap, pubSnap] = await Promise.all([
          tx.get(codeRef),
          tx.get(db.collection('users').doc(uid)),
          tx.get(db.collection('publicProfiles').doc(uid)),
        ]);

        if (codeSnap.exists) {
          throw new Error('CODE_COLLISION');
        }

        const hostPlayer: ServerRoomPlayer = {
          uid,
          name: hostInfo.name,
          avatar: hostInfo.avatar,
          isReady: false,
          isEliminated: false,
          score: 0,
          revealedRole: null,
        };

        tx.set(roomRef, {
          id: roomRef.id,
          hostId: uid,
          hostName: hostInfo.name,
          hostAvatar: hostInfo.avatar,
          status: 'waiting',
          isPrivate: settings.isPrivate,
          hasSecretCode: true,
          maxPlayers: settings.maxPlayers,
          language: settings.language,
          category: settings.category,
          difficulty: settings.difficulty,
          turnDurationSeconds: settings.turnDurationSeconds,
          playerIds: [uid],
          players: [hostPlayer],
          kickedPlayers: [],
          messages: [],
          gameState: null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

        tx.set(metaRef, {
          secretCode,
          roomId: roomRef.id,
          createdAt: FieldValue.serverTimestamp(),
        });

        tx.set(codeRef, {
          roomId: roomRef.id,
          hostId: uid,
          createdAt: FieldValue.serverTimestamp(),
        });

        if (userSnap.exists) {
          const stats = userSnap.data()?.stats || {};
          tx.update(userSnap.ref, {
            'stats.hosted': Number(stats.hosted || 0) + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
        if (pubSnap.exists) {
          const stats = pubSnap.data()?.stats || {};
          tx.update(pubSnap.ref, {
            'stats.hosted': Number(stats.hosted || 0) + 1,
            updatedAt: FieldValue.serverTimestamp(),
          });
        }
      });

      return { roomId: roomRef.id, secretCode };
    } catch (err: any) {
      if (err?.message === 'CODE_COLLISION') {
        continue;
      }
      throw err;
    }
  }

  throw new HttpsError('resource-exhausted', 'Could not allocate unique room code.');
});

export const joinRoom = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const rawRoomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const rawCode = typeof request.data?.secretCode === 'string' ? request.data.secretCode.trim() : '';

  let targetRoomId = rawRoomId;
  if (!targetRoomId && rawCode) {
    if (!/^\d{4,8}$/.test(rawCode)) {
      throw new HttpsError('invalid-argument', 'Invalid room code format.');
    }
    const codeSnap = await db.collection('roomCodes').doc(rawCode).get();
    if (!codeSnap.exists) {
      return { success: false, reason: 'roomNotFound' };
    }
    targetRoomId = codeSnap.data()?.roomId || '';
  }

  if (!targetRoomId || !/^[a-zA-Z0-9_-]{3,128}$/.test(targetRoomId)) {
    throw new HttpsError('invalid-argument', 'Invalid room ID.');
  }

  const callerInfo = await resolveCallerPlayerInfo(uid, request.auth.token);
  const roomRef = db.collection('rooms').doc(targetRoomId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) {
      return { success: false, reason: 'roomNotFound' };
    }

    const data = snap.data()!;
    const kickedPlayers: string[] = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
    if (kickedPlayers.includes(uid)) {
      return { success: false, reason: 'kickedFromRoom' };
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const alreadyInRoom = players.some((p) => p.uid === uid);
    if (alreadyInRoom) {
      return { success: true, roomId: targetRoomId, alreadyJoined: true };
    }

    if (data.status !== 'waiting') {
      return { success: false, reason: 'matchAlreadyStarted' };
    }

    if (players.length >= Number(data.maxPlayers || 8)) {
      return { success: false, reason: 'roomFull' };
    }

    const nextPlayer: ServerRoomPlayer = {
      uid,
      name: callerInfo.name,
      avatar: callerInfo.avatar,
      isReady: false,
      isEliminated: false,
      score: 0,
      revealedRole: null,
    };

    const nextPlayers = [...players, nextPlayer];
    const nextPlayerIds = Array.from(new Set(nextPlayers.map((p) => p.uid)));

    tx.update(roomRef, {
      players: nextPlayers,
      playerIds: nextPlayerIds,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { success: true, roomId: targetRoomId };
  });
});

export const quickJoinRoom = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const callerInfo = await resolveCallerPlayerInfo(uid, request.auth.token);

  const candidatesSnap = await db
    .collection('rooms')
    .where('isPrivate', '==', false)
    .where('status', '==', 'waiting')
    .limit(25)
    .get();

  const sortedRooms = candidatesSnap.docs
    .map((d) => ({ id: d.id, data: d.data() }))
    .filter(({ data }) => {
      const players: any[] = Array.isArray(data.players) ? data.players : [];
      const kicked: string[] = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
      return !kicked.includes(uid) && players.length < Number(data.maxPlayers || 8);
    })
    .sort((a, b) => (b.data.players?.length || 0) - (a.data.players?.length || 0));

  for (const candidate of sortedRooms) {
    const roomRef = db.collection('rooms').doc(candidate.id);
    const joined = await db.runTransaction(async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists) return false;
      const data = snap.data()!;
      if (data.status !== 'waiting' || data.isPrivate) return false;
      const kicked: string[] = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
      if (kicked.includes(uid)) return false;
      const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
      if (players.some((p) => p.uid === uid)) return true;
      if (players.length >= Number(data.maxPlayers || 8)) return false;

      const nextPlayers = [
        ...players,
        {
          uid,
          name: callerInfo.name,
          avatar: callerInfo.avatar,
          isReady: false,
          isEliminated: false,
          score: 0,
          revealedRole: null,
        },
      ];
      tx.update(roomRef, {
        players: nextPlayers,
        playerIds: nextPlayers.map((p) => p.uid),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return true;
    });

    if (joined) {
      return { success: true, roomId: candidate.id };
    }
  }

  return { success: false, roomId: null };
});

export const leaveRoom = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) return { success: true };

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');
  const privatePlayerRef = roomRef.collection('privatePlayers').doc(uid);

  const result = await db.runTransaction(async (tx) => {
    const [roomSnap, privateStateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);

    if (!roomSnap.exists) {
      return { shouldDeleteRoom: false };
    }

    const data = roomSnap.data()!;
    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const remainingPlayers = players.filter((p) => p.uid !== uid);

    if (remainingPlayers.length === 0) {
      return { shouldDeleteRoom: true };
    }

    const privateState = privateStateSnap.exists
      ? (privateStateSnap.data() as PrivateGameStateDoc)
      : null;

    // Pre-read player profiles if mid-match leave could end the game
    let profileMap = new Map<string, { userExists: boolean; userData: any; pubExists: boolean; pubData: any }>();
    if (
      data.status === 'playing' &&
      privateState &&
      data.gameState?.phase &&
      !['SETUP_PENDING', 'RESULT'].includes(data.gameState.phase)
    ) {
      profileMap = await readPlayerProfileDocs(
        tx,
        remainingPlayers.map((p) => p.uid)
      );
    }

    const updates: Record<string, any> = {
      players: remainingPlayers,
      playerIds: remainingPlayers.map((p) => p.uid),
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (data.hostId === uid) {
      const nextHost = remainingPlayers[0];
      updates.hostId = nextHost.uid;
      updates.hostName = nextHost.name;
      updates.hostAvatar = nextHost.avatar;
    }

    tx.delete(privatePlayerRef);

    if (
      data.status === 'playing' &&
      privateState &&
      data.gameState?.phase &&
      !['SETUP_PENDING', 'RESULT'].includes(data.gameState.phase)
    ) {
      const winCheck = evaluateOnlineWin(remainingPlayers, privateState.rolesByUid);
      if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
        if (data.hostId === uid) {
          tx.update(roomRef, {
            hostId: updates.hostId,
            hostName: updates.hostName,
            hostAvatar: updates.hostAvatar,
          });
        }
        applyMatchSettlementWrites({
          tx,
          roomRef,
          roomData: { ...data, ...updates },
          privateStateRef,
          privateState,
          players: remainingPlayers,
          profileMap,
          winner: winCheck.winner,
          winReason: winCheck.winReason,
        });
        return { shouldDeleteRoom: false };
      }

      const gameState = { ...(data.gameState || {}) };
      if (gameState.phase === 'PLAYING' && !gameState.turnsCompleted) {
        const aliveSet = new Set(
          remainingPlayers.filter((p) => !p.isEliminated).map((p) => p.uid)
        );
        const order: string[] = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
        const activeUid = order[gameState.currentTurnIndex || 0];
        if (activeUid === uid) {
          let nextIdx = (gameState.currentTurnIndex || 0) + 1;
          while (nextIdx < order.length && !aliveSet.has(order[nextIdx])) {
            nextIdx += 1;
          }
          if (nextIdx >= order.length) {
            gameState.turnsCompleted = true;
            gameState.turnEndsAt = null;
          } else {
            gameState.currentTurnIndex = nextIdx;
            gameState.turnEndsAt = Date.now() + Number(data.turnDurationSeconds || 45) * 1000;
          }
        }
      } else if (gameState.phase === 'REVEAL') {
        gameState.readyPlayers = (gameState.readyPlayers || []).filter((id: string) => id !== uid);
        if (gameState.readyPlayers.length >= remainingPlayers.length) {
          gameState.phase = 'PLAYING';
          gameState.round = 1;
          gameState.turnOrder = buildServerTurnOrder(
            remainingPlayers,
            privateState.rolesByUid,
            1
          );
          gameState.currentTurnIndex = 0;
          gameState.turnEndsAt = Date.now() + Number(data.turnDurationSeconds || 45) * 1000;
          gameState.turnsCompleted = false;
          gameState.clues = [];
        }
      } else if (gameState.phase === 'VOTING') {
        gameState.votedUids = (gameState.votedUids || []).filter((id: string) => id !== uid);
      }

      gameState.aliveInfiltratorsCount = remainingPlayers.filter((p) => {
        if (p.isEliminated) return false;
        const r = privateState.rolesByUid[p.uid];
        return r === 'mrwhite' || r === 'undercover';
      }).length;
      updates.gameState = gameState;
    }

    tx.update(roomRef, updates);
    return { shouldDeleteRoom: false };
  });

  if (result.shouldDeleteRoom) {
    await cleanupEmptyRoomDocs(roomId);
  }

  return { success: true };
});

export const updateRoomSettings = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const settings = sanitizeRoomSettings(request.data || {});
  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can edit room settings.');
    }
    if (data.status !== 'waiting') {
      throw new HttpsError('failed-precondition', 'Cannot edit settings during active game.');
    }

    const playerCount = Array.isArray(data.players) ? data.players.length : 1;
    const safeMax = Math.max(Math.max(3, playerCount), settings.maxPlayers);

    tx.update(roomRef, {
      maxPlayers: safeMax,
      language: settings.language,
      category: settings.category,
      difficulty: settings.difficulty,
      turnDurationSeconds: settings.turnDurationSeconds,
      isPrivate: settings.isPrivate,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const kickPlayer = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
  if (!roomId || !targetUid || targetUid === uid) {
    throw new HttpsError('invalid-argument', 'Invalid kick parameters.');
  }

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can kick players.');
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const remaining = players.filter((p) => p.uid !== targetUid);
    const kicked = Array.from(new Set([...(data.kickedPlayers || []), targetUid]));

    tx.update(roomRef, {
      players: remaining,
      playerIds: remaining.map((p) => p.uid),
      kickedPlayers: kicked,
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.delete(roomRef.collection('privatePlayers').doc(targetUid));
  });

  return { success: true };
});

export const promoteHost = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
  if (!roomId || !targetUid || targetUid === uid) {
    throw new HttpsError('invalid-argument', 'Invalid promoteHost parameters.');
  }

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only current host can promote.');
    }
    const targetPlayer = (data.players || []).find((p: ServerRoomPlayer) => p.uid === targetUid);
    if (!targetPlayer) {
      throw new HttpsError('not-found', 'Target player not in room.');
    }

    tx.update(roomRef, {
      hostId: targetPlayer.uid,
      hostName: targetPlayer.name,
      hostAvatar: targetPlayer.avatar,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const toggleReady = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    if (data.status !== 'waiting') {
      throw new HttpsError('failed-precondition', 'Match is already active.');
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const idx = players.findIndex((p) => p.uid === uid);
    if (idx === -1) {
      throw new HttpsError('permission-denied', 'You are not a member of this room.');
    }

    const updatedPlayers = players.map((p) =>
      p.uid === uid ? { ...p, isReady: !p.isReady } : p
    );

    tx.update(roomRef, {
      players: updatedPlayers,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const sendRoomChat = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const text = typeof request.data?.text === 'string' ? request.data.text.trim().slice(0, 200) : '';
  if (!roomId || !text) {
    throw new HttpsError('invalid-argument', 'Invalid chat message.');
  }

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const member = players.find((p) => p.uid === uid);
    if (!member) {
      throw new HttpsError('permission-denied', 'Only room members can send messages.');
    }

    const existing = Array.isArray(data.messages) ? data.messages : [];
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      senderId: uid,
      senderName: member.name,
      text,
      timestamp: new Date().toISOString(),
    };
    tx.update(roomRef, {
      messages: [...existing, msg].slice(-60),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});
