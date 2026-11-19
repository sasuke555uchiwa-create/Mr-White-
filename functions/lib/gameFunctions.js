"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextMatch = exports.returnToLobby = exports.submitMrWhiteGuess = exports.proceedAfterVoteReveal = exports.resolveVotes = exports.submitVote = exports.startVoting = exports.advanceTurn = exports.submitClue = exports.markRevealReady = exports.startRound = exports.beginMatch = void 0;
const crypto_1 = require("crypto");
const firestore_1 = require("firebase-admin/firestore");
const https_1 = require("firebase-functions/v2/https");
const firebaseAdmin_1 = require("./firebaseAdmin");
const gameLogic_1 = require("./gameLogic");
const wordData_1 = require("./wordData");
const matchSettlement_1 = require("./matchSettlement");
exports.beginMatch = (0, https_1.onCall)(async (request) => {
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
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can start the match.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        if (players.length < 3) {
            throw new https_1.HttpsError('failed-precondition', 'At least 3 players required.');
        }
        const allReady = players.every((p) => p.isReady || p.uid === data.hostId);
        if (!allReady) {
            throw new https_1.HttpsError('failed-precondition', 'Not all players are ready.');
        }
        tx.update(roomRef, {
            status: 'playing',
            gameState: {
                phase: 'SETUP_PENDING',
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.startRound = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, prevPrivateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = roomSnap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can start a round.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        if (players.length < 3) {
            throw new https_1.HttpsError('failed-precondition', 'Need at least 3 players.');
        }
        const language = typeof data.language === 'string' ? data.language : 'ar';
        const category = typeof data.category === 'string' ? data.category : 'standard';
        const difficulty = data.difficulty === 'hard' ? 'hard' : 'easy';
        const { civilianWord, undercoverWord, decoys } = (0, wordData_1.pickServerWordPair)(language, category);
        const playerUids = players.map((p) => p.uid);
        const rolesByUid = (0, gameLogic_1.assignServerRoles)(playerUids);
        const impostorIds = playerUids.filter((id) => rolesByUid[id] === 'mrwhite');
        const undercoverIds = playerUids.filter((id) => rolesByUid[id] === 'undercover');
        const matchId = (0, crypto_1.randomUUID)();
        const prevSettled = prevPrivateSnap.exists
            ? prevPrivateSnap.data()?.settledMatches || []
            : [];
        const privateState = {
            matchId,
            round: 1,
            civilianWord,
            undercoverWord,
            decoys,
            impostorIds,
            undercoverIds,
            rolesByUid,
            votesByUid: {},
            settledMatches: prevSettled,
        };
        tx.set(privateStateRef, {
            ...privateState,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        for (const p of players) {
            const actualRole = rolesByUid[p.uid] || 'citizen';
            const assignedWord = actualRole === 'mrwhite'
                ? null
                : actualRole === 'undercover'
                    ? undercoverWord
                    : civilianWord;
            // In Hard mode, hide citizen vs undercover role even from the player's own privatePlayers doc
            const visiblePrivateRole = actualRole === 'mrwhite'
                ? 'mrwhite'
                : difficulty === 'hard'
                    ? 'hidden'
                    : actualRole;
            const privPlayerRef = roomRef.collection('privatePlayers').doc(p.uid);
            tx.set(privPlayerRef, {
                uid: p.uid,
                matchId,
                round: 1,
                role: visiblePrivateRole,
                secretWord: assignedWord,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        const resetPlayers = players.map((p) => ({
            uid: p.uid,
            name: p.name,
            avatar: p.avatar,
            isReady: p.isReady,
            isEliminated: false,
            score: p.score || 0,
            revealedRole: null,
        }));
        tx.update(roomRef, {
            status: 'playing',
            players: resetPlayers,
            playerIds: playerUids,
            gameState: {
                phase: 'REVEAL',
                matchId,
                round: 1,
                category,
                difficulty,
                infiltratorsCount: impostorIds.length + undercoverIds.length,
                aliveInfiltratorsCount: impostorIds.length + undercoverIds.length,
                mrWhiteCount: difficulty === 'easy' ? impostorIds.length : null,
                undercoverCount: difficulty === 'easy' ? undercoverIds.length : null,
                readyPlayers: [],
                turnOrder: [],
                currentTurnIndex: 0,
                turnEndsAt: null,
                turnsCompleted: false,
                clues: [],
                votedUids: [],
                mostVotedId: null,
                mostVotedRevealedRole: null,
                votersForEliminated: [],
                tieBroken: false,
                guesserUid: null,
                winner: null,
                winReason: null,
                winningMrWhiteUid: null,
                revealedResult: null,
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.markRevealReady = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        const gameState = data.gameState || {};
        if (gameState.phase !== 'REVEAL') {
            return;
        }
        const players = Array.isArray(data.players) ? data.players : [];
        if (!players.some((p) => p.uid === uid)) {
            throw new https_1.HttpsError('permission-denied', 'Not a member of this room.');
        }
        const readySet = new Set(Array.isArray(gameState.readyPlayers) ? gameState.readyPlayers : []);
        readySet.add(uid);
        const readyPlayers = Array.from(readySet);
        if (readyPlayers.length >= players.length) {
            const privateState = privateSnap.data();
            const turnDuration = Number(data.turnDurationSeconds || 45);
            const turnOrder = (0, gameLogic_1.buildServerTurnOrder)(players, privateState.rolesByUid, 1);
            tx.update(roomRef, {
                gameState: {
                    ...gameState,
                    phase: 'PLAYING',
                    round: 1,
                    readyPlayers: [],
                    turnOrder,
                    currentTurnIndex: 0,
                    turnEndsAt: Date.now() + turnDuration * 1000,
                    turnsCompleted: false,
                    clues: [],
                },
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
        else {
            tx.update(roomRef, {
                'gameState.readyPlayers': readyPlayers,
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
        }
    });
    return { success: true };
});
function buildNextTurnPatch(gameState, players, turnDurationSeconds, extraClue) {
    const aliveSet = new Set(players.filter((p) => !p.isEliminated).map((p) => p.uid));
    const turnOrder = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
    const currentIndex = Number(gameState.currentTurnIndex || 0);
    let nextIdx = currentIndex + 1;
    while (nextIdx < turnOrder.length && !aliveSet.has(turnOrder[nextIdx])) {
        nextIdx += 1;
    }
    const existingClues = Array.isArray(gameState.clues) ? gameState.clues : [];
    const clues = extraClue ? [...existingClues, extraClue].slice(-80) : existingClues;
    if (nextIdx >= turnOrder.length) {
        return {
            ...gameState,
            clues,
            turnsCompleted: true,
            turnEndsAt: null,
        };
    }
    return {
        ...gameState,
        clues,
        currentTurnIndex: nextIdx,
        turnEndsAt: Date.now() + turnDurationSeconds * 1000,
        turnsCompleted: false,
    };
}
exports.submitClue = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const text = typeof request.data?.text === 'string' ? request.data.text.trim().slice(0, 80) : '';
    if (!roomId || !text) {
        throw new https_1.HttpsError('invalid-argument', 'Clue text is required.');
    }
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            throw new https_1.HttpsError('not-found', 'Room not found.');
        const data = snap.data();
        const gameState = data.gameState || {};
        if (gameState.phase !== 'PLAYING' || gameState.turnsCompleted) {
            throw new https_1.HttpsError('failed-precondition', 'Not currently accepting clues.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const speaker = players.find((p) => p.uid === uid && !p.isEliminated);
        if (!speaker) {
            throw new https_1.HttpsError('permission-denied', 'Eliminated or non-member cannot speak.');
        }
        const turnOrder = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
        const currentIndex = Number(gameState.currentTurnIndex || 0);
        if (turnOrder[currentIndex] !== uid) {
            throw new https_1.HttpsError('permission-denied', 'It is not your turn to speak.');
        }
        const clue = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            uid: speaker.uid,
            name: speaker.name,
            avatar: speaker.avatar,
            text,
            round: Number(gameState.round || 1),
            skipped: false,
        };
        const nextGameState = buildNextTurnPatch(gameState, players, Number(data.turnDurationSeconds || 45), clue);
        tx.update(roomRef, {
            gameState: nextGameState,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.advanceTurn = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const reason = request.data?.reason === 'timeout' ? 'timeout' : 'skip';
    const expectedTurnIndex = typeof request.data?.expectedTurnIndex === 'number' ? request.data.expectedTurnIndex : null;
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists)
            return;
        const data = snap.data();
        const gameState = data.gameState || {};
        if (gameState.phase !== 'PLAYING' || gameState.turnsCompleted)
            return;
        const currentIndex = Number(gameState.currentTurnIndex || 0);
        if (expectedTurnIndex !== null && expectedTurnIndex !== currentIndex) {
            return; // Already advanced by another client (idempotent)
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const turnOrder = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
        const activeUid = turnOrder[currentIndex];
        const activePlayer = players.find((p) => p.uid === activeUid && !p.isEliminated);
        const isHost = data.hostId === uid;
        const isSpeaker = activeUid === uid;
        const isTimedOut = typeof gameState.turnEndsAt === 'number' && Date.now() >= gameState.turnEndsAt - 1000;
        if (activePlayer && !isHost && !isSpeaker && !isTimedOut) {
            throw new https_1.HttpsError('permission-denied', 'Cannot skip another player before timer expires.');
        }
        const language = typeof data.language === 'string' ? data.language : 'ar';
        const labelText = reason === 'timeout'
            ? language === 'ar'
                ? '(انتهى الوقت)'
                : '(Timed out)'
            : language === 'ar'
                ? '(تم التخطي)'
                : '(Skipped)';
        const extraClue = activePlayer
            ? {
                id: `${Date.now()}-skip`,
                uid: activePlayer.uid,
                name: activePlayer.name,
                avatar: activePlayer.avatar,
                text: labelText,
                round: Number(gameState.round || 1),
                skipped: true,
            }
            : undefined;
        const nextGameState = buildNextTurnPatch(gameState, players, Number(data.turnDurationSeconds || 45), extraClue);
        tx.update(roomRef, {
            gameState: nextGameState,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.startVoting = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can start voting.');
        }
        if (data.gameState?.phase !== 'PLAYING') {
            return;
        }
        tx.update(privateStateRef, {
            votesByUid: {},
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.update(roomRef, {
            gameState: {
                ...data.gameState,
                phase: 'VOTING',
                readyPlayers: [],
                votedUids: [],
                turnEndsAt: null,
                tieBroken: false,
                mostVotedId: null,
                mostVotedRevealedRole: null,
                votersForEliminated: [],
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.submitVote = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const suspectUid = typeof request.data?.suspectUid === 'string' ? request.data.suspectUid.trim() : '';
    if (!roomId || !suspectUid || suspectUid === uid) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid vote target.');
    }
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        const gameState = data.gameState || {};
        if (gameState.phase !== 'VOTING') {
            throw new https_1.HttpsError('failed-precondition', 'Voting is not active.');
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const alivePlayers = players.filter((p) => !p.isEliminated);
        const aliveUids = new Set(alivePlayers.map((p) => p.uid));
        if (!aliveUids.has(uid) || !aliveUids.has(suspectUid)) {
            throw new https_1.HttpsError('permission-denied', 'Both voter and target must be alive room members.');
        }
        const privateState = privateSnap.data();
        const votesByUid = { ...(privateState.votesByUid || {}), [uid]: suspectUid };
        const votedUids = Array.from(new Set(Object.keys(votesByUid).filter((v) => aliveUids.has(v))));
        tx.update(privateStateRef, {
            votesByUid,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        if (votedUids.length >= alivePlayers.length) {
            const tally = (0, gameLogic_1.tallyVotesServer)(votesByUid, aliveUids);
            if (tally) {
                const revealedRole = privateState.rolesByUid[tally.mostVotedId] || 'citizen';
                const votersForEliminated = Object.entries(votesByUid)
                    .filter(([, target]) => target === tally.mostVotedId)
                    .map(([voter]) => voter);
                tx.update(roomRef, {
                    gameState: {
                        ...gameState,
                        phase: 'REVEAL_VOTE_RESULT',
                        votedUids,
                        mostVotedId: tally.mostVotedId,
                        mostVotedRevealedRole: revealedRole,
                        votersForEliminated,
                        tieBroken: tally.tieBroken,
                    },
                    updatedAt: firestore_1.FieldValue.serverTimestamp(),
                });
                return;
            }
        }
        tx.update(roomRef, {
            'gameState.votedUids': votedUids,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.resolveVotes = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can force resolve votes.');
        }
        const gameState = data.gameState || {};
        if (gameState.phase !== 'VOTING')
            return;
        const players = Array.isArray(data.players) ? data.players : [];
        const aliveUids = new Set(players.filter((p) => !p.isEliminated).map((p) => p.uid));
        const privateState = privateSnap.data();
        const votesByUid = privateState.votesByUid || {};
        const tally = (0, gameLogic_1.tallyVotesServer)(votesByUid, aliveUids);
        if (!tally) {
            throw new https_1.HttpsError('failed-precondition', 'No valid votes cast yet.');
        }
        const revealedRole = privateState.rolesByUid[tally.mostVotedId] || 'citizen';
        const votersForEliminated = Object.entries(votesByUid)
            .filter(([, target]) => target === tally.mostVotedId)
            .map(([voter]) => voter);
        tx.update(roomRef, {
            gameState: {
                ...gameState,
                phase: 'REVEAL_VOTE_RESULT',
                mostVotedId: tally.mostVotedId,
                mostVotedRevealedRole: revealedRole,
                votersForEliminated,
                tieBroken: tally.tieBroken,
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.proceedAfterVoteReveal = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    await firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can proceed.');
        }
        const gameState = data.gameState || {};
        if (gameState.phase !== 'REVEAL_VOTE_RESULT' || !gameState.mostVotedId)
            return;
        const privateState = privateSnap.data();
        const targetUid = gameState.mostVotedId;
        const targetRole = privateState.rolesByUid[targetUid] || 'citizen';
        if (targetRole === 'mrwhite') {
            tx.update(roomRef, {
                gameState: {
                    ...gameState,
                    phase: 'IMPOSTOR_GUESS',
                    guesserUid: targetUid,
                },
                updatedAt: firestore_1.FieldValue.serverTimestamp(),
            });
            return;
        }
        const players = Array.isArray(data.players) ? data.players : [];
        const updatedPlayers = players.map((p) => p.uid === targetUid ? { ...p, isEliminated: true, revealedRole: targetRole } : p);
        const profileMap = await (0, matchSettlement_1.readPlayerProfileDocs)(tx, updatedPlayers.map((p) => p.uid));
        const winCheck = (0, gameLogic_1.evaluateOnlineWin)(updatedPlayers, privateState.rolesByUid);
        if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
            (0, matchSettlement_1.applyMatchSettlementWrites)({
                tx,
                roomRef,
                roomData: data,
                privateStateRef,
                privateState,
                players: updatedPlayers,
                profileMap,
                winner: winCheck.winner,
                winReason: winCheck.winReason,
            });
            return;
        }
        const nextRound = Number(gameState.round || 1) + 1;
        const turnOrder = (0, gameLogic_1.buildServerTurnOrder)(updatedPlayers, privateState.rolesByUid, nextRound);
        const turnDuration = Number(data.turnDurationSeconds || 45);
        const aliveInfiltratorsCount = updatedPlayers.filter((p) => {
            if (p.isEliminated)
                return false;
            const r = privateState.rolesByUid[p.uid];
            return r === 'mrwhite' || r === 'undercover';
        }).length;
        const aliveMrWhiteCount = updatedPlayers.filter((p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'mrwhite').length;
        const aliveUndercoverCount = updatedPlayers.filter((p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'undercover').length;
        const isEasy = (gameState.difficulty || data.difficulty || 'easy') === 'easy';
        tx.update(privateStateRef, {
            round: nextRound,
            votesByUid: {},
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.update(roomRef, {
            players: updatedPlayers,
            gameState: {
                ...gameState,
                phase: 'PLAYING',
                round: nextRound,
                aliveInfiltratorsCount,
                mrWhiteCount: isEasy ? aliveMrWhiteCount : null,
                undercoverCount: isEasy ? aliveUndercoverCount : null,
                turnOrder,
                currentTurnIndex: 0,
                turnEndsAt: Date.now() + turnDuration * 1000,
                turnsCompleted: false,
                votedUids: [],
                mostVotedId: null,
                mostVotedRevealedRole: null,
                votersForEliminated: [],
                tieBroken: false,
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.submitMrWhiteGuess = (0, https_1.onCall)(async (request) => {
    if (!request.auth?.uid) {
        throw new https_1.HttpsError('unauthenticated', 'Authentication required.');
    }
    const uid = request.auth.uid;
    const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
    const guess = typeof request.data?.guess === 'string' ? request.data.guess.trim().slice(0, 80) : '';
    const forceEliminateMissing = Boolean(request.data?.forceEliminateMissing);
    if (!roomId)
        throw new https_1.HttpsError('invalid-argument', 'Missing roomId.');
    const roomRef = firebaseAdmin_1.db.collection('rooms').doc(roomId);
    const privateStateRef = roomRef.collection('privateState').doc('current');
    return firebaseAdmin_1.db.runTransaction(async (tx) => {
        const [roomSnap, privateSnap] = await Promise.all([
            tx.get(roomRef),
            tx.get(privateStateRef),
        ]);
        if (!roomSnap.exists || !privateSnap.exists) {
            throw new https_1.HttpsError('not-found', 'Active match not found.');
        }
        const data = roomSnap.data();
        const gameState = data.gameState || {};
        if (gameState.phase !== 'IMPOSTOR_GUESS') {
            throw new https_1.HttpsError('failed-precondition', 'Not currently in guess phase.');
        }
        const privateState = privateSnap.data();
        const guesserUid = gameState.guesserUid || gameState.mostVotedId || '';
        const players = Array.isArray(data.players) ? data.players : [];
        const guesserStillInRoom = players.some((p) => p.uid === guesserUid);
        if (forceEliminateMissing && data.hostId === uid && !guesserStillInRoom) {
            // Allow host to continue if Mr. White disconnected before guessing
        }
        else if (uid !== guesserUid) {
            throw new https_1.HttpsError('permission-denied', 'Only caught Mr. White can submit the guess.');
        }
        const isCorrect = !forceEliminateMissing && (0, wordData_1.isMrWhiteGuessMatch)(guess, privateState.civilianWord);
        const profileMap = await (0, matchSettlement_1.readPlayerProfileDocs)(tx, players.map((p) => p.uid));
        if (isCorrect) {
            (0, matchSettlement_1.applyMatchSettlementWrites)({
                tx,
                roomRef,
                roomData: data,
                privateStateRef,
                privateState,
                players,
                profileMap,
                winner: 'impostor',
                winReason: 'impostor_guessed',
                winningMrWhiteUid: guesserUid,
            });
            return { isCorrect: true, secretWord: privateState.civilianWord };
        }
        const updatedPlayers = players.map((p) => p.uid === guesserUid ? { ...p, isEliminated: true, revealedRole: 'mrwhite' } : p);
        const winCheck = (0, gameLogic_1.evaluateOnlineWin)(updatedPlayers, privateState.rolesByUid);
        if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
            (0, matchSettlement_1.applyMatchSettlementWrites)({
                tx,
                roomRef,
                roomData: data,
                privateStateRef,
                privateState,
                players: updatedPlayers,
                profileMap,
                winner: winCheck.winner,
                winReason: winCheck.winReason,
            });
            return { isCorrect: false, secretWord: privateState.civilianWord };
        }
        const nextRound = Number(gameState.round || 1) + 1;
        const turnOrder = (0, gameLogic_1.buildServerTurnOrder)(updatedPlayers, privateState.rolesByUid, nextRound);
        const turnDuration = Number(data.turnDurationSeconds || 45);
        const aliveInfiltratorsCount = updatedPlayers.filter((p) => {
            if (p.isEliminated)
                return false;
            const r = privateState.rolesByUid[p.uid];
            return r === 'mrwhite' || r === 'undercover';
        }).length;
        const aliveMrWhiteCount = updatedPlayers.filter((p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'mrwhite').length;
        const aliveUndercoverCount = updatedPlayers.filter((p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'undercover').length;
        const isEasy = (gameState.difficulty || data.difficulty || 'easy') === 'easy';
        tx.update(privateStateRef, {
            round: nextRound,
            votesByUid: {},
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        tx.update(roomRef, {
            players: updatedPlayers,
            gameState: {
                ...gameState,
                phase: 'PLAYING',
                round: nextRound,
                aliveInfiltratorsCount,
                mrWhiteCount: isEasy ? aliveMrWhiteCount : null,
                undercoverCount: isEasy ? aliveUndercoverCount : null,
                turnOrder,
                currentTurnIndex: 0,
                turnEndsAt: Date.now() + turnDuration * 1000,
                turnsCompleted: false,
                votedUids: [],
                mostVotedId: null,
                mostVotedRevealedRole: null,
                votersForEliminated: [],
                guesserUid: null,
                tieBroken: false,
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
        return { isCorrect: false, secretWord: privateState.civilianWord };
    });
});
exports.returnToLobby = (0, https_1.onCall)(async (request) => {
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
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can return to lobby.');
        }
        const resetPlayers = (data.players || []).map((p) => ({
            uid: p.uid,
            name: p.name,
            avatar: p.avatar,
            isReady: false,
            isEliminated: false,
            score: p.score || 0,
            revealedRole: null,
        }));
        tx.update(roomRef, {
            status: 'waiting',
            players: resetPlayers,
            gameState: null,
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
exports.nextMatch = (0, https_1.onCall)(async (request) => {
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
        if (data.hostId !== uid) {
            throw new https_1.HttpsError('permission-denied', 'Only host can prepare next match.');
        }
        const resetPlayers = (data.players || []).map((p) => ({
            ...p,
            isEliminated: false,
            revealedRole: null,
        }));
        tx.update(roomRef, {
            status: 'playing',
            players: resetPlayers,
            gameState: {
                phase: 'SETUP_PENDING',
            },
            updatedAt: firestore_1.FieldValue.serverTimestamp(),
        });
    });
    return { success: true };
});
//# sourceMappingURL=gameFunctions.js.map