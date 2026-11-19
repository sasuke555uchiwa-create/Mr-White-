"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendRoomChat = exports.toggleReady = exports.promoteHost = exports.kickPlayer = exports.updateRoomSettings = exports.leaveRoom = exports.quickJoinRoom = exports.joinRoom = exports.createRoom = void 0;
const crypto_1 = require("crypto");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firebaseAdmin_1 = require("./firebaseAdmin");
const gameLogic_1 = require("./gameLogic");
const matchSettlement_1 = require("./matchSettlement");
const ALLOWED_LANGUAGES = new Set(['ar', 'en', 'fr', 'es', 'de', 'tr', 'pt']);
const ALLOWED_CATEGORIES = new Set(['standard', 'animals', 'food', 'places', 'objects']);
function sanitizeRoomSettings(raw) {
    const maxPlayersNum = Number(raw?.maxPlayers ?? 8);
    const maxPlayers = Number.isFinite(maxPlayersNum)
        ? Math.max(3, Math.min(10, Math.round(maxPlayersNum)))
        : 8;
    const language = typeof raw?.language === 'string' && ALLOWED_LANGUAGES.has(raw.language)
        ? raw.language
        : 'ar';
    const category = typeof raw?.category === 'string' && ALLOWED_CATEGORIES.has(raw.category)
        ? raw.category
        : 'standard';
    const difficulty = raw?.difficulty === 'hard' ? 'hard' : 'easy';
    const turnNum = Number(raw?.turnDurationSeconds ?? 45);
    const turnDurationSeconds = Number.isFinite(turnNum)
        ? Math.max(15, Math.min(180, Math.round(turnNum)))
        : 45;
    const isPrivate = Boolean(raw?.isPrivate);
    return { maxPlayers, language, category, difficulty, turnDurationSeconds, isPrivate };
}
function generateRoomCode() {
    return String((0, crypto_1.randomInt)(100000, 1000000));
}
async function resolveCallerPlayerInfo(uid, authToken) {
    const [pubSnap, userSnap] = await Promise.all([
        firebaseAdmin_1.db.collection('publicProfiles').doc(uid).get(),
        firebaseAdmin_1.db.collection('users').doc(uid).get(),
    ]);
    const src = (pubSnap.exists ? pubSnap.data() : userSnap.exists ? userSnap.data() : null) || {};
    const rawName = (typeof src.displayName === 'string' && src.displayName.trim()) ||
        (typeof authToken?.name === 'string' && authToken.name.trim()) ||
        'لاعب جديد';
    const rawAvatar = (typeof src.photoURL === 'string' && src.photoURL) ||
        (typeof authToken?.picture === 'string' && authToken.picture) ||
        `https://api.dicebear.com/7.x/avataaars/svg?seed=${uid}`;
    return {
        name: rawName.slice(0, 40),
        avatar: rawAvatar.slice(0, 2097152),
    };
}
async function cleanupEmptyRoomDocs(roomId) {
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const [privatePlayersSnap, metaSnap, stateSnap] = await Promise.all([
        roomRef.collection('privatePlayers').get(),
        roomRef.collection('privateMeta').doc('invite').get(),
        roomRef.collection('privateState').doc('current').get(),
    ]);
    const batch = firebaseAdmin_1.db.batch();
    privatePlayersSnap.docs.forEach((d) => batch.delete(d.ref));
    if (metaSnap.exists) {
        const code = metaSnap.data()?.secretCode;
        if (typeof code === 'string' && code) {
            batch.delete(firebaseAdmin_1.db.collection('roomCodes').doc(code));
        }
        batch.delete(metaSnap.ref);
    }
    if (stateSnap.exists) {
        batch.delete(stateSnap.ref);
    }
    batch.delete(roomRef);
    await batch.commit();
}
exports.createRoom = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const settings = sanitizeRoomSettings(request.data || {});
    const hostInfo = await resolveCallerPlayerInfo(uid, request.auth.token);
    for (let attempt = 0; attempt < 5; attempt++) {
        const secretCode = generateRoomCode();
        const roomRef = firebaseAdmin_1.db.collection('rooms').doc();
        const codeRef = firebaseAdmin_1.db.collection('roomCodes').doc(secretCode);
        const metaRef = roomRef.collection('privateMeta').doc('invite');
        try {
            await firebaseAdmin_1.db.runTransaction(async (tx) => {
                const [codeSnap, userSnap, pubSnap] = await Promise.all([
                    tx.get(codeRef),
                    tx.get(firebaseAdmin_1.db.collection('users').doc(uid)),
                    tx.get(firebaseAdmin_1.db.collection('publicProfiles').doc(uid)),
                ]);
                if (codeSnap.exists) {
                    throw new Error('CODE_COLLISION');
                }
                const hostPlayer = {
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
                    createdAt: firestore_1.FieldValue.serverTimestamp(),
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                });
                tx.set(metaRef, {
                    secretCode,
                    roomId: roomRef.id,
                    createdAt: firestore_1.FieldValue.serverTimestamp(),
                });
                tx.set(codeRef, {
                    roomId: roomRef.id,
                    hostId: uid,
                    createdAt: firestore_1.FieldValue.serverTimestamp(),
                });
                if (userSnap.exists) {
                    const stats = userSnap.data()?.stats || {};
                    tx.update(userSnap.ref, {
                        'stats.hosted': Number(stats.hosted || 0) + 1,
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    });
                }
                if (pubSnap.exists) {
                    const stats = pubSnap.data()?.stats || {};
                    tx.update(pubSnap.ref, {
                        'stats.hosted': Number(stats.hosted || 0) + 1,
                        updatedAt: firestore_1.FieldValue.serverTimestamp(),
                    });
                }
            });
            return { roomId: roomRef.id, secretCode };
        }
        catch (err) {
            if (err?.message === 'CODE_COLLISION') {
                continue;
            }
            throw err;
        }
    }
    throw new https_1.HttpsError('resource-exhausted', 'Could not allocate unique room code.');
});
exports.joinRoom = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const rawRoomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const rawCode = typeof request.data?.secretCode === 'string' ? request.data.secretCode.trim() : '';
    let targetRoomId = rawRoomId;
    if (!targetRoomId && rawCode) {
        if (!/^\d{4,8}$/.test(rawCode)) {
            throw new https_1.HttpsError('invalid-argument', 'Invalid room code format.');
        }
        const codeSnap = await firebaseAdmin_1.db.collection('roomCodes').doc(rawCode).get();
        if (!codeSnap.exists) {
            return { success: false, reason: 'roomNotFound' };
        }
        targetRoomId = codeSnap.data()?.roomId || '';
    }
    if (!targetRoomId || !/^[a-zA-Z0-9_-]{3,128}$/.test(targetRoomId)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid room ID.');
    }
    const callerInfo = await resolveCallerPlayerInfo(uid, request.auth.token);
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(targetRoomId);
    return firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists) {
            return { success: false, reason: 'roomNotFound' };
        }
        const data = snap.data();
        const kickedPlayers = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
        if (kickedPlayers.includes(uid)) {
            return { success: false, reason: 'kickedFromRoom' };
        }
        const players = Array.isArray(data.players) ? data.players : [];
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
        const nextPlayer = {
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
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return { success: true, roomId: targetRoomId };
    });
});
exports.quickJoinRoom = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const callerInfo = await resolveCallerPlayerInfo(uid, request.auth.token);
    const candidatesSnap = await firebaseAdmin_1.db
        .collection('rooms')
        .where('isPrivate', '==', false)
        .where('status', '==', 'waiting')
        .limit(25)
        .get();
    const sortedRooms = candidatesSnap.docs
        .map((d) => ({ id: d.id, data: d.data() }))
        .filter(({ data }) => {
        const players = Array.isArray(data.players) ? data.players : [];
        const kicked = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
        return !kicked.includes(uid) && players.length < Number(data.maxPlayers || 8);
    })
        .sort((a, b) => (b.data.players?.length || 0) - (a.data.players?.length || 0));
    for (const candidate of sortedRooms) {
        const roomRef = firebaseAdmin_1.db.collection('rooms').doc(candidate.id);
        const joined = await firebaseAdmin_1.db.runTransaction(async (tx) => {
            const snap = await tx.get(roomRef);
            if (!snap.exists)
                return false;
            const data = snap.data();
            if (data.status !== 'waiting' || data.isPrivate)
                return false;
            const kicked = Array.isArray(data.kickedPlayers) ? data.kickedPlayers : [];
            if (kicked.includes(uid))
                return false;
            const players = Array.isArray(data.players) ? data.players : [];
            if (players.some((p) => p.uid === uid))
                return true;
            if (players.length >= Number(data.maxPlayers || 8))
                return false;
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
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return true;
        });
        if (joined) {
            return { success: true, roomId: candidate.id };
        }
    }
    return { success: false, roomId: null };
});
exports.leaveRoom = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        return { success: true };
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    const privatePlayerRef = roomRef.collection('privatePlayers').doc(uid);
    const result = await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateStateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists) {
            return { shouldDeleteRoom: false };
        }
        const data = roomSnap.data();
        const players = Array.isArray(data.players) ? data.players : [];
        const remainingPlayers = players.filter((p) => p.uid !== uid);
        if (remainingPlayers.length === 0) {
            return { shouldDeleteRoom: true };
        }
        const privateState = privateStateSnap.exists
            ? privateStateSnap.data()
            : null;
        // Pre-read player profiles if mid-match leave could end the game
        let profileMap = new Map();
        if (data.status === 'playing' &&
            privateState &&
            data.gameState?.phase &&
            !['SETUP_PENDING', 'RESULT'].includes(data.gameState.phase)) {
            profileMap = await (0, matchSettlement_1.readPlayerProfileDocs)(tx, remainingPlayers.map((p) => p.uid));
        }
        const updates = {
            players: remainingPlayers,
            playerIds: remainingPlayers.map((p) => p.uid),
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        };
        if (data.hostId === uid) {
            const nextHost = remainingPlayers[0];
            updates.hostId = nextHost.uid;
            updates.hostName = nextHost.name;
            updates.hostAvatar = nextHost.avatar;
        }
        tx.delete(privatePlayerRef);
        if (data.status === 'playing' &&
            privateState &&
            data.gameState?.phase &&
            !['SETUP_PENDING', 'RESULT'].includes(data.gameState.phase)) {
            const winCheck = (0, gameLogic_1.evaluateOnlineWin)(remainingPlayers, privateState.rolesByUid);
            if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
                if (data.hostId === uid) {
                    tx.update(roomRef, {
                        hostId: updates.hostId,
                        hostName: updates.hostName,
                        hostAvatar: updates.hostAvatar,
                    });
                }
                (0, matchSettlement_1.applyMatchSettlementWrites)({
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
                const aliveSet = new Set(remainingPlayers.filter((p) => !p.isEliminated).map((p) => p.uid));
                const order = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
                const activeUid = order[gameState.currentTurnIndex || 0];
                if (activeUid === uid) {
                    let nextIdx = (gameState.currentTurnIndex || 0) + 1;
                    while (nextIdx < order.length && !aliveSet.has(order[nextIdx])) {
                        nextIdx += 1;
                    }
                    if (nextIdx >= order.length) {
                        gameState.turnsCompleted = true;
                        gameState.turnEndsAt = null;
                    }
                    else {
                        gameState.currentTurnIndex = nextIdx;
                        gameState.turnEndsAt = Date.now() + Number(data.turnDurationSeconds || 45) * 1000;
                    }
                }
            }
            else if (gameState.phase === 'REVEAL') {
                gameState.readyPlayers = (gameState.readyPlayers || []).filter((id) => id !== uid);
                if (gameState.readyPlayers.length >= remainingPlayers.length) {
                    gameState.phase = 'PLAYING';
                    gameState.round = 1;
                    gameState.turnOrder = (0, gameLogic_1.buildServerTurnOrder)(remainingPlayers, privateState.rolesByUid, 1);
                    gameState.currentTurnIndex = 0;
                    gameState.turnEndsAt = Date.now() + Number(data.turnDurationSeconds || 45) * 1000;
                    gameState.turnsCompleted = false;
                    gameState.clues = [];
                }
            }
            else if (gameState.phase === 'VOTING') {
                gameState.votedUids = (gameState.votedUids || []).filter((id) => id !== uid);
            }
            gameState.aliveInfiltratorsCount = remainingPlayers.filter((p) => {
                if (p.isEliminated)
                    return false;
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
exports.updateRoomSettings = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const settings = sanitizeRoomSettings(request.data || {});
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can edit room settings.');
        }
        if (data.status !== 'waiting') {
            throw new https_1.HttpsError('failed-precondition', 'Cannot edit settings during active game.');
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
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.kickPlayer = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!roomId || !targetUid || targetUid === uid) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid kick parameters.');
    }
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can kick players.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const remaining = players.filter((p) => p.uid !== targetUid);
        const kicked = Array.from(new Set([...(data.kickedPlayers || []), targetUid]));
        tx.update(roomRef, {
            players: remaining,
            playerIds: remaining.map((p) => p.uid),
            kickedPlayers: kicked,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.delete(roomRef.collection('privatePlayers').doc(targetUid));
    });
    return { success: true };
});
exports.promoteHost = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const targetUid = typeof request.data?.targetUid === 'string' ? request.data.targetUid.trim() : '';
    if (!roomId || !targetUid || targetUid === uid) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid promoteHost parameters.');
    }
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only current host can promote.');
        }
        const targetPlayer = (data.players || []).find((p) => p.uid === targetUid);
        if (!targetPlayer) {
            throw new https_1.HttpsError('not-found', 'Target player not in room.');
        }
        tx.update(roomRef, {
            hostId: targetPlayer.uid,
            hostName: targetPlayer.name,
            hostAvatar: targetPlayer.avatar,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.toggleReady = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        if (data.status !== 'waiting') {
            throw new https_1.HttpsError('failed-precondition', 'Match is already active.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const idx = players.findIndex((p) => p.uid === uid);
        if (idx === -1) {
            throw new https_1.HttpsError('permission-denied', 'You are not a member of this room.');
        }
        const updatedPlayers = players.map((p) => p.uid === uid ? { ...p, isReady: !p.isReady } : p);
        tx.update(roomRef, {
            players: updatedPlayers,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.sendRoomChat = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const text = typeof request.data?.text === 'string' ? request.data.text.trim().slice(0, 200) : '';
    if (!roomId || !text) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid chat message.');
    }
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        const players = Array.isArray(data.players) ? data.players : [];
        const member = players.find((p) => p.uid === uid);
        if (!member) {
            throw new https_1.HttpsError('permission-denied', 'Only room members can send messages.');
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
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
//# sourceMappingURL=roomFunctions.js.map