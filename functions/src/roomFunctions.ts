import { FieldValue } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { DbLike, FunctionActionError } from './errors';
import { db } from './firebaseAdmin';
import {
  executeCreateRoom,
  executeJoinRoom,
  executeKickPlayer,
  executeLeaveRoom,
  executePromoteHost,
  executeQuickJoinRoom,
  executeSendRoomChat,
  executeToggleReady,
  executeUpdateRoomSettings,
} from './roomHandlers';

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

export const createRoom = onCall((request) =>
  handleCallable(() =>
    executeCreateRoom(deps, request.auth?.uid, request.auth?.token, request.data || {})
  )
);

export const joinRoom = onCall((request) =>
  handleCallable(() =>
    executeJoinRoom(deps, request.auth?.uid, request.auth?.token, request.data || {})
  )
);

export const quickJoinRoom = onCall((request) =>
  handleCallable(() => executeQuickJoinRoom(deps, request.auth?.uid, request.auth?.token))
);

export const leaveRoom = onCall((request) =>
  handleCallable(() => executeLeaveRoom(deps, request.auth?.uid, request.data || {}))
);

export const updateRoomSettings = onCall((request) =>
  handleCallable(() => executeUpdateRoomSettings(deps, request.auth?.uid, request.data || {}))
);

export const kickPlayer = onCall((request) =>
  handleCallable(() => executeKickPlayer(deps, request.auth?.uid, request.data || {}))
);

export const promoteHost = onCall((request) =>
  handleCallable(() => executePromoteHost(deps, request.auth?.uid, request.data || {}))
);

export const toggleReady = onCall((request) =>
  handleCallable(() => executeToggleReady(deps, request.auth?.uid, request.data || {}))
);

export const sendRoomChat = onCall((request) =>
  handleCallable(() => executeSendRoomChat(deps, request.auth?.uid, request.data || {}))
);
