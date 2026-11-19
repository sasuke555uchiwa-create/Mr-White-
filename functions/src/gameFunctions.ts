import { randomUUID } from 'crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { db } from './firebaseAdmin';
import {
  OnlineRole,
  ServerRoomPlayer,
  assignServerRoles,
  buildServerTurnOrder,
  evaluateOnlineWin,
  tallyVotesServer,
} from './gameLogic';
import { isMrWhiteGuessMatch, pickServerWordPair } from './wordData';
import {
  PrivateGameStateDoc,
  applyMatchSettlementWrites,
  readPlayerProfileDocs,
} from './matchSettlement';

export const beginMatch = onCall(async (request) => {
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
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can start the match.');
    }
    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    if (players.length < 3) {
      throw new HttpsError('failed-precondition', 'At least 3 players required.');
    }
    const allReady = players.every((p) => p.isReady || p.uid === data.hostId);
    if (!allReady) {
      throw new HttpsError('failed-precondition', 'Not all players are ready.');
    }

    tx.update(roomRef, {
      status: 'playing',
      gameState: {
        phase: 'SETUP_PENDING',
      },
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const startRound = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, prevPrivateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);

    if (!roomSnap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = roomSnap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can start a round.');
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    if (players.length < 3) {
      throw new HttpsError('failed-precondition', 'Need at least 3 players.');
    }

    const language = typeof data.language === 'string' ? data.language : 'ar';
    const category = typeof data.category === 'string' ? data.category : 'standard';
    const difficulty: 'easy' | 'hard' = data.difficulty === 'hard' ? 'hard' : 'easy';

    const { civilianWord, undercoverWord, decoys } = pickServerWordPair(language, category);
    const playerUids = players.map((p) => p.uid);
    const rolesByUid = assignServerRoles(playerUids);

    const impostorIds = playerUids.filter((id) => rolesByUid[id] === 'mrwhite');
    const undercoverIds = playerUids.filter((id) => rolesByUid[id] === 'undercover');
    const matchId = randomUUID();
    const prevSettled = prevPrivateSnap.exists
      ? (prevPrivateSnap.data()?.settledMatches as string[] | undefined) || []
      : [];

    const privateState: PrivateGameStateDoc = {
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
      updatedAt: FieldValue.serverTimestamp(),
    });

    for (const p of players) {
      const actualRole: OnlineRole = rolesByUid[p.uid] || 'citizen';
      const assignedWord =
        actualRole === 'mrwhite'
          ? null
          : actualRole === 'undercover'
          ? undercoverWord
          : civilianWord;

      // In Hard mode, hide citizen vs undercover role even from the player's own privatePlayers doc
      const visiblePrivateRole =
        actualRole === 'mrwhite'
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
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const resetPlayers: ServerRoomPlayer[] = players.map((p) => ({
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const markRevealReady = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }

    const data = roomSnap.data()!;
    const gameState = data.gameState || {};
    if (gameState.phase !== 'REVEAL') {
      return;
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    if (!players.some((p) => p.uid === uid)) {
      throw new HttpsError('permission-denied', 'Not a member of this room.');
    }

    const readySet = new Set<string>(Array.isArray(gameState.readyPlayers) ? gameState.readyPlayers : []);
    readySet.add(uid);
    const readyPlayers = Array.from(readySet);

    if (readyPlayers.length >= players.length) {
      const privateState = privateSnap.data() as PrivateGameStateDoc;
      const turnDuration = Number(data.turnDurationSeconds || 45);
      const turnOrder = buildServerTurnOrder(players, privateState.rolesByUid, 1);

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
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.update(roomRef, {
        'gameState.readyPlayers': readyPlayers,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  return { success: true };
});

function buildNextTurnPatch(
  gameState: any,
  players: ServerRoomPlayer[],
  turnDurationSeconds: number,
  extraClue?: any
) {
  const aliveSet = new Set(players.filter((p) => !p.isEliminated).map((p) => p.uid));
  const turnOrder: string[] = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
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

export const submitClue = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const text = typeof request.data?.text === 'string' ? request.data.text.trim().slice(0, 80) : '';
  if (!roomId || !text) {
    throw new HttpsError('invalid-argument', 'Clue text is required.');
  }

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Room not found.');
    const data = snap.data()!;
    const gameState = data.gameState || {};
    if (gameState.phase !== 'PLAYING' || gameState.turnsCompleted) {
      throw new HttpsError('failed-precondition', 'Not currently accepting clues.');
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const speaker = players.find((p) => p.uid === uid && !p.isEliminated);
    if (!speaker) {
      throw new HttpsError('permission-denied', 'Eliminated or non-member cannot speak.');
    }

    const turnOrder: string[] = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
    const currentIndex = Number(gameState.currentTurnIndex || 0);
    if (turnOrder[currentIndex] !== uid) {
      throw new HttpsError('permission-denied', 'It is not your turn to speak.');
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

    const nextGameState = buildNextTurnPatch(
      gameState,
      players,
      Number(data.turnDurationSeconds || 45),
      clue
    );

    tx.update(roomRef, {
      gameState: nextGameState,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const advanceTurn = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const reason: 'skip' | 'timeout' = request.data?.reason === 'timeout' ? 'timeout' : 'skip';
  const expectedTurnIndex =
    typeof request.data?.expectedTurnIndex === 'number' ? request.data.expectedTurnIndex : null;
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) return;
    const data = snap.data()!;
    const gameState = data.gameState || {};
    if (gameState.phase !== 'PLAYING' || gameState.turnsCompleted) return;

    const currentIndex = Number(gameState.currentTurnIndex || 0);
    if (expectedTurnIndex !== null && expectedTurnIndex !== currentIndex) {
      return; // Already advanced by another client (idempotent)
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const turnOrder: string[] = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
    const activeUid = turnOrder[currentIndex];
    const activePlayer = players.find((p) => p.uid === activeUid && !p.isEliminated);

    const isHost = data.hostId === uid;
    const isSpeaker = activeUid === uid;
    const isTimedOut =
      typeof gameState.turnEndsAt === 'number' && Date.now() >= gameState.turnEndsAt - 1000;

    if (activePlayer && !isHost && !isSpeaker && !isTimedOut) {
      throw new HttpsError('permission-denied', 'Cannot skip another player before timer expires.');
    }

    const language = typeof data.language === 'string' ? data.language : 'ar';
    const labelText =
      reason === 'timeout'
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

    const nextGameState = buildNextTurnPatch(
      gameState,
      players,
      Number(data.turnDurationSeconds || 45),
      extraClue
    );

    tx.update(roomRef, {
      gameState: nextGameState,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const startVoting = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }
    const data = roomSnap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can start voting.');
    }
    if (data.gameState?.phase !== 'PLAYING') {
      return;
    }

    tx.update(privateStateRef, {
      votesByUid: {},
      updatedAt: FieldValue.serverTimestamp(),
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const submitVote = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const suspectUid = typeof request.data?.suspectUid === 'string' ? request.data.suspectUid.trim() : '';
  if (!roomId || !suspectUid || suspectUid === uid) {
    throw new HttpsError('invalid-argument', 'Invalid vote target.');
  }

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }

    const data = roomSnap.data()!;
    const gameState = data.gameState || {};
    if (gameState.phase !== 'VOTING') {
      throw new HttpsError('failed-precondition', 'Voting is not active.');
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const alivePlayers = players.filter((p) => !p.isEliminated);
    const aliveUids = new Set(alivePlayers.map((p) => p.uid));

    if (!aliveUids.has(uid) || !aliveUids.has(suspectUid)) {
      throw new HttpsError('permission-denied', 'Both voter and target must be alive room members.');
    }

    const privateState = privateSnap.data() as PrivateGameStateDoc;
    const votesByUid: Record<string, string> = { ...(privateState.votesByUid || {}), [uid]: suspectUid };
    const votedUids = Array.from(new Set(Object.keys(votesByUid).filter((v) => aliveUids.has(v))));

    tx.update(privateStateRef, {
      votesByUid,
      updatedAt: FieldValue.serverTimestamp(),
    });

    if (votedUids.length >= alivePlayers.length) {
      const tally = tallyVotesServer(votesByUid, aliveUids);
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
          updatedAt: FieldValue.serverTimestamp(),
        });
        return;
      }
    }

    tx.update(roomRef, {
      'gameState.votedUids': votedUids,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const resolveVotes = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }

    const data = roomSnap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can force resolve votes.');
    }
    const gameState = data.gameState || {};
    if (gameState.phase !== 'VOTING') return;

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const aliveUids = new Set(players.filter((p) => !p.isEliminated).map((p) => p.uid));
    const privateState = privateSnap.data() as PrivateGameStateDoc;
    const votesByUid = privateState.votesByUid || {};
    const tally = tallyVotesServer(votesByUid, aliveUids);

    if (!tally) {
      throw new HttpsError('failed-precondition', 'No valid votes cast yet.');
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const proceedAfterVoteReveal = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  await db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }

    const data = roomSnap.data()!;
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can proceed.');
    }
    const gameState = data.gameState || {};
    if (gameState.phase !== 'REVEAL_VOTE_RESULT' || !gameState.mostVotedId) return;

    const privateState = privateSnap.data() as PrivateGameStateDoc;
    const targetUid: string = gameState.mostVotedId;
    const targetRole = privateState.rolesByUid[targetUid] || 'citizen';

    if (targetRole === 'mrwhite') {
      tx.update(roomRef, {
        gameState: {
          ...gameState,
          phase: 'IMPOSTOR_GUESS',
          guesserUid: targetUid,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });
      return;
    }

    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const updatedPlayers = players.map((p) =>
      p.uid === targetUid ? { ...p, isEliminated: true, revealedRole: targetRole } : p
    );

    const profileMap = await readPlayerProfileDocs(
      tx,
      updatedPlayers.map((p) => p.uid)
    );

    const winCheck = evaluateOnlineWin(updatedPlayers, privateState.rolesByUid);
    if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
      applyMatchSettlementWrites({
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
    const turnOrder = buildServerTurnOrder(updatedPlayers, privateState.rolesByUid, nextRound);
    const turnDuration = Number(data.turnDurationSeconds || 45);
    const aliveInfiltratorsCount = updatedPlayers.filter((p) => {
      if (p.isEliminated) return false;
      const r = privateState.rolesByUid[p.uid];
      return r === 'mrwhite' || r === 'undercover';
    }).length;
    const aliveMrWhiteCount = updatedPlayers.filter(
      (p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'mrwhite'
    ).length;
    const aliveUndercoverCount = updatedPlayers.filter(
      (p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'undercover'
    ).length;
    const isEasy = (gameState.difficulty || data.difficulty || 'easy') === 'easy';

    tx.update(privateStateRef, {
      round: nextRound,
      votesByUid: {},
      updatedAt: FieldValue.serverTimestamp(),
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const submitMrWhiteGuess = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }

  const uid = request.auth.uid;
  const roomId = typeof request.data?.roomId === 'string' ? request.data.roomId.trim() : '';
  const guess = typeof request.data?.guess === 'string' ? request.data.guess.trim().slice(0, 80) : '';
  const forceEliminateMissing = Boolean(request.data?.forceEliminateMissing);
  if (!roomId) throw new HttpsError('invalid-argument', 'Missing roomId.');

  const roomRef = db.collection('rooms').doc(roomId);
  const privateStateRef = roomRef.collection('privateState').doc('current');

  return db.runTransaction(async (tx) => {
    const [roomSnap, privateSnap] = await Promise.all([
      tx.get(roomRef),
      tx.get(privateStateRef),
    ]);
    if (!roomSnap.exists || !privateSnap.exists) {
      throw new HttpsError('not-found', 'Active match not found.');
    }

    const data = roomSnap.data()!;
    const gameState = data.gameState || {};
    if (gameState.phase !== 'IMPOSTOR_GUESS') {
      throw new HttpsError('failed-precondition', 'Not currently in guess phase.');
    }

    const privateState = privateSnap.data() as PrivateGameStateDoc;
    const guesserUid: string = gameState.guesserUid || gameState.mostVotedId || '';
    const players: ServerRoomPlayer[] = Array.isArray(data.players) ? data.players : [];
    const guesserStillInRoom = players.some((p) => p.uid === guesserUid);

    if (forceEliminateMissing && data.hostId === uid && !guesserStillInRoom) {
      // Allow host to continue if Mr. White disconnected before guessing
    } else if (uid !== guesserUid) {
      throw new HttpsError('permission-denied', 'Only caught Mr. White can submit the guess.');
    }

    const isCorrect =
      !forceEliminateMissing && isMrWhiteGuessMatch(guess, privateState.civilianWord);

    const profileMap = await readPlayerProfileDocs(
      tx,
      players.map((p) => p.uid)
    );

    if (isCorrect) {
      applyMatchSettlementWrites({
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

    const updatedPlayers = players.map((p) =>
      p.uid === guesserUid ? { ...p, isEliminated: true, revealedRole: 'mrwhite' as OnlineRole } : p
    );

    const winCheck = evaluateOnlineWin(updatedPlayers, privateState.rolesByUid);
    if (winCheck.isOver && winCheck.winner && winCheck.winReason) {
      applyMatchSettlementWrites({
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
    const turnOrder = buildServerTurnOrder(updatedPlayers, privateState.rolesByUid, nextRound);
    const turnDuration = Number(data.turnDurationSeconds || 45);
    const aliveInfiltratorsCount = updatedPlayers.filter((p) => {
      if (p.isEliminated) return false;
      const r = privateState.rolesByUid[p.uid];
      return r === 'mrwhite' || r === 'undercover';
    }).length;
    const aliveMrWhiteCount = updatedPlayers.filter(
      (p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'mrwhite'
    ).length;
    const aliveUndercoverCount = updatedPlayers.filter(
      (p) => !p.isEliminated && privateState.rolesByUid[p.uid] === 'undercover'
    ).length;
    const isEasy = (gameState.difficulty || data.difficulty || 'easy') === 'easy';

    tx.update(privateStateRef, {
      round: nextRound,
      votesByUid: {},
      updatedAt: FieldValue.serverTimestamp(),
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
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { isCorrect: false, secretWord: privateState.civilianWord };
  });
});

export const returnToLobby = onCall(async (request) => {
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
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can return to lobby.');
    }

    const resetPlayers: ServerRoomPlayer[] = (data.players || []).map((p: ServerRoomPlayer) => ({
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});

export const nextMatch = onCall(async (request) => {
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
    if (data.hostId !== uid) {
      throw new HttpsError('permission-denied', 'Only host can prepare next match.');
    }

    const resetPlayers: ServerRoomPlayer[] = (data.players || []).map((p: ServerRoomPlayer) => ({
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
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return { success: true };
});
