import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

export interface OnlineChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
  isSystem?: boolean;
}

export interface RoomSettingsPayload {
  maxPlayers: number;
  language: string;
  isPrivate: boolean;
  category: string;
  difficulty: 'easy' | 'hard';
  turnDurationSeconds: number;
}

async function callFn<TReq, TRes>(name: string, payload: TReq): Promise<TRes> {
  const callable = httpsCallable<TReq, TRes>(functions, name);
  const res = await callable(payload);
  return res.data;
}

export const createOnlineRoom = async (
  settings: RoomSettingsPayload
): Promise<{ roomId: string; secretCode: string }> => {
  return callFn<RoomSettingsPayload, { roomId: string; secretCode: string }>('createRoom', settings);
};

export const joinOnlineRoom = async (params: {
  roomId?: string;
  secretCode?: string;
}): Promise<{ success: boolean; roomId?: string; reason?: string; alreadyJoined?: boolean }> => {
  return callFn<
    { roomId?: string; secretCode?: string },
    { success: boolean; roomId?: string; reason?: string; alreadyJoined?: boolean }
  >('joinRoom', params);
};

export const quickJoinOnlineRoom = async (): Promise<{
  success: boolean;
  roomId: string | null;
}> => {
  return callFn<Record<string, never>, { success: boolean; roomId: string | null }>(
    'quickJoinRoom',
    {}
  );
};

export const leaveOnlineRoom = async (roomId: string, _uid?: string): Promise<void> => {
  if (!roomId) return;
  try {
    await callFn<{ roomId: string }, { success: boolean }>('leaveRoom', { roomId });
  } catch (error) {
    console.error('leaveOnlineRoom error:', error);
    throw error;
  }
};

export const updateOnlineRoomSettings = async (
  roomId: string,
  settings: RoomSettingsPayload
): Promise<void> => {
  await callFn<RoomSettingsPayload & { roomId: string }, { success: boolean }>(
    'updateRoomSettings',
    { roomId, ...settings }
  );
};

export const kickOnlinePlayer = async (roomId: string, targetUid: string): Promise<void> => {
  await callFn<{ roomId: string; targetUid: string }, { success: boolean }>('kickPlayer', {
    roomId,
    targetUid,
  });
};

export const promoteOnlineHost = async (roomId: string, targetUid: string): Promise<void> => {
  await callFn<{ roomId: string; targetUid: string }, { success: boolean }>('promoteHost', {
    roomId,
    targetUid,
  });
};

export const toggleOnlineReady = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('toggleReady', { roomId });
};

export const appendRoomChatMessage = async (
  roomId: string,
  messageOrText: OnlineChatMessage | string
): Promise<void> => {
  if (!roomId) return;
  const text =
    typeof messageOrText === 'string' ? messageOrText.trim() : (messageOrText?.text || '').trim();
  if (!text) return;
  await callFn<{ roomId: string; text: string }, { success: boolean }>('sendRoomChat', {
    roomId,
    text: text.slice(0, 200),
  });
};

export const beginOnlineMatch = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('beginMatch', { roomId });
};

export const startOnlineRound = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('startRound', { roomId });
};

export const markOnlineRevealReady = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('markRevealReady', { roomId });
};

export const submitOnlineClue = async (roomId: string, text: string): Promise<void> => {
  await callFn<{ roomId: string; text: string }, { success: boolean }>('submitClue', {
    roomId,
    text,
  });
};

export const advanceOnlineTurn = async (
  roomId: string,
  reason: 'skip' | 'timeout',
  expectedTurnIndex?: number
): Promise<void> => {
  await callFn<
    { roomId: string; reason: 'skip' | 'timeout'; expectedTurnIndex?: number },
    { success: boolean }
  >('advanceTurn', { roomId, reason, expectedTurnIndex });
};

export const startOnlineVoting = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('startVoting', { roomId });
};

export const submitOnlineVote = async (roomId: string, suspectUid: string): Promise<void> => {
  await callFn<{ roomId: string; suspectUid: string }, { success: boolean }>('submitVote', {
    roomId,
    suspectUid,
  });
};

export const resolveOnlineVotes = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('resolveVotes', { roomId });
};

export const proceedAfterOnlineVoteReveal = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('proceedAfterVoteReveal', { roomId });
};

export const submitOnlineMrWhiteGuess = async (
  roomId: string,
  guess: string,
  forceEliminateMissing = false
): Promise<{ isCorrect: boolean; secretWord: string }> => {
  return callFn<
    { roomId: string; guess: string; forceEliminateMissing?: boolean },
    { isCorrect: boolean; secretWord: string }
  >('submitMrWhiteGuess', { roomId, guess, forceEliminateMissing });
};

export const returnOnlineToLobby = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('returnToLobby', { roomId });
};

export const nextOnlineMatch = async (roomId: string): Promise<void> => {
  await callFn<{ roomId: string }, { success: boolean }>('nextMatch', { roomId });
};
