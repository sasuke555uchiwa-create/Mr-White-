import { doc, runTransaction, deleteDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';

export interface OnlineChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: string;
  isSystem?: boolean;
}

const MAX_CHAT_MESSAGES = 60;

/**
 * Safely removes a user from an online room inside a transaction.
 * If the leaving user is the host and other players remain, migrates host to the next player.
 * If no players remain and the host leaves, deletes the room document cleanly.
 */
export const leaveOnlineRoom = async (roomId: string, uid: string): Promise<void> => {
  if (!roomId || !uid) return;
  const roomRef = doc(db, 'rooms', roomId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;

      const data = snap.data();
      const players: any[] = Array.isArray(data.players) ? data.players : [];
      const remainingPlayers = players.filter((p) => p.uid !== uid);
      const isHost = data.hostId === uid;

      if (isHost) {
        if (remainingPlayers.length > 0) {
          const nextHost = remainingPlayers[0];
          tx.update(roomRef, {
            hostId: nextHost.uid,
            hostName: nextHost.name,
            hostAvatar: nextHost.avatar,
            players: remainingPlayers,
          });
        } else {
          tx.delete(roomRef);
        }
      } else if (remainingPlayers.length !== players.length) {
        tx.update(roomRef, {
          players: remainingPlayers,
        });
      }
    });
  } catch (error) {
    // Fallback if transaction conflicts on deletion or offline
    try {
      const snap = await getDoc(roomRef);
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.hostId === uid && (!data.players || data.players.length <= 1)) {
        await deleteDoc(roomRef);
      }
    } catch {
      // Ignore fallback error; caller handles navigation cleanly
    }
    throw error;
  }
};

/**
 * Appends a chat message while capping stored history to MAX_CHAT_MESSAGES to prevent document bloat.
 */
export const appendRoomChatMessage = async (
  roomId: string,
  message: OnlineChatMessage
): Promise<void> => {
  if (!roomId) return;
  const roomRef = doc(db, 'rooms', roomId);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) return;
    const existing: OnlineChatMessage[] = Array.isArray(snap.data().messages)
      ? snap.data().messages
      : [];
    const next = [...existing, message].slice(-MAX_CHAT_MESSAGES);
    tx.update(roomRef, { messages: next });
  });
};
