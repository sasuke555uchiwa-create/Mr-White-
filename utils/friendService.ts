import { collection, addDoc, query, where, getDocs, serverTimestamp, doc, updateDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType } from './firestoreErrorHandler';

export const sendFriendRequest = async (fromId: string, toId: string) => {
  try {
    // Check if request already exists
    const q1 = query(collection(db, 'friendRequests'), where('fromId', '==', fromId));
    const q2 = query(collection(db, 'friendRequests'), where('toId', '==', fromId));
    
    const [snap1, snap2] = await Promise.all([getDocs(q1), getDocs(q2)]);
    
    const reqExists = snap1.docs.some(d => d.data().toId === toId) || snap2.docs.some(d => d.data().fromId === toId);
    if (reqExists) {
      return { success: false, message: 'friendRequestExists' };
    }

    // Check if already friends
    const fq1 = query(collection(db, 'friendships'), where('user1', '==', fromId));
    const fq2 = query(collection(db, 'friendships'), where('user2', '==', fromId));
    
    const [fsnap1, fsnap2] = await Promise.all([getDocs(fq1), getDocs(fq2)]);
    
    const friendExists = fsnap1.docs.some(d => d.data().user2 === toId) || fsnap2.docs.some(d => d.data().user1 === toId);
    if (friendExists) {
      return { success: false, message: 'alreadyFriends' };
    }

    await addDoc(collection(db, 'friendRequests'), {
      fromId,
      toId,
      status: 'pending',
      createdAt: serverTimestamp()
    });
    
    return { success: true, message: 'friendRequestSent' };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'friendRequests');
    return { success: false, message: 'errorSendingRequest' };
  }
};

export const acceptFriendRequest = async (requestId: string, fromId: string, toId: string) => {
  try {
    const reqRef = doc(db, 'friendRequests', requestId);
    await updateDoc(reqRef, { status: 'accepted' });
    
    await addDoc(collection(db, 'friendships'), {
      user1: fromId,
      user2: toId,
      createdAt: serverTimestamp()
    });
    
    return { success: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `friendRequests/${requestId}`);
    return { success: false };
  }
};

export const rejectFriendRequest = async (requestId: string) => {
  try {
    const reqRef = doc(db, 'friendRequests', requestId);
    await deleteDoc(reqRef);
    return { success: true };
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `friendRequests/${requestId}`);
    return { success: false };
  }
};
