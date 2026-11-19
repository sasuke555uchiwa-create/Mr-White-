import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DbLike, FunctionActionError } from './errors';
import { db } from './firebaseAdmin';
import {
  executeAdvanceTurn,
  executeBeginMatch,
  executeMarkRevealReady,
  executeNextMatch,
  executeProceedAfterVoteReveal,
  executeResolveVotes,
  executeReturnToLobby,
  executeStartRound,
  executeStartVoting,
  executeSubmitClue,
  executeSubmitMrWhiteGuess,
  executeSubmitVote,
} from './gameHandlers';

const deps = {
  db: db as unknown as DbLike,
  serverTimestamp: () => FieldValue.serverTimestamp(),
};

function handleCallable<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof FunctionActionError) {
      throw new HttpsError(err.code, err.message);
    }
    throw err;
  });
}

export const beginMatch = onCall((request) =>
  handleCallable(() => executeBeginMatch(deps, request.auth?.uid, request.data || {}))
);

export const startRound = onCall((request) =>
  handleCallable(() => executeStartRound(deps, request.auth?.uid, request.data || {}))
);

export const markRevealReady = onCall((request) =>
  handleCallable(() => executeMarkRevealReady(deps, request.auth?.uid, request.data || {}))
);

export const submitClue = onCall((request) =>
  handleCallable(() => executeSubmitClue(deps, request.auth?.uid, request.data || {}))
);

export const advanceTurn = onCall((request) =>
  handleCallable(() => executeAdvanceTurn(deps, request.auth?.uid, request.data || {}))
);

export const startVoting = onCall((request) =>
  handleCallable(() => executeStartVoting(deps, request.auth?.uid, request.data || {}))
);

export const submitVote = onCall((request) =>
  handleCallable(() => executeSubmitVote(deps, request.auth?.uid, request.data || {}))
);

export const resolveVotes = onCall((request) =>
  handleCallable(() => executeResolveVotes(deps, request.auth?.uid, request.data || {}))
);

export const proceedAfterVoteReveal = onCall((request) =>
  handleCallable(() =>
    executeProceedAfterVoteReveal(deps, request.auth?.uid, request.data || {})
  )
);

export const submitMrWhiteGuess = onCall((request) =>
  handleCallable(() => executeSubmitMrWhiteGuess(deps, request.auth?.uid, request.data || {}))
);

export const returnToLobby = onCall((request) =>
  handleCallable(() => executeReturnToLobby(deps, request.auth?.uid, request.data || {}))
);

export const nextMatch = onCall((request) =>
  handleCallable(() => executeNextMatch(deps, request.auth?.uid, request.data || {}))
);
