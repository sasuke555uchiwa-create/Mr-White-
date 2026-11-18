import React, { useState, useEffect } from 'react';
import { collection, query, where, onSnapshot, doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { acceptFriendRequest, rejectFriendRequest } from '../utils/friendService';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { UserCheck, UserX, Users, UserPlus } from 'lucide-react';
import { getUITranslation } from '../translations';
import { getSettings } from '../services/storageService';

export const FriendsSection: React.FC = () => {
  const { user } = useAuth();
  const [requests, setRequests] = useState<any[]>([]);
  const [friends, setFriends] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const lang = getSettings().language;
  const isRTL = ['ar', 'sa'].includes(lang);

  useEffect(() => {
    if (!user) return;

    // Listen for incoming friend requests
    const qReq = query(collection(db, 'friendRequests'), where('toId', '==', user.uid), where('status', '==', 'pending'));
    const unsubReq = onSnapshot(qReq, async (snapshot) => {
      const reqs = [];
      for (const docSnap of snapshot.docs) {
        const data = docSnap.data();
        try {
          const userDoc = await getDoc(doc(db, 'users', data.fromId));
          if (userDoc.exists()) {
            reqs.push({ id: docSnap.id, ...data, user: userDoc.data() });
          }
        } catch (e) {
          console.error(e);
        }
      }
      setRequests(reqs);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'friendRequests'));

    // Listen for friendships
    const qFriends1 = query(collection(db, 'friendships'), where('user1', '==', user.uid));
    const qFriends2 = query(collection(db, 'friendships'), where('user2', '==', user.uid));
    
    const fetchFriends = async (snap1: any, snap2: any) => {
      const friendList = [];
      const friendIds = new Set<string>();
      
      snap1.docs.forEach((d: any) => friendIds.add(d.data().user2));
      snap2.docs.forEach((d: any) => friendIds.add(d.data().user1));
      
      for (const fid of friendIds) {
        try {
          const userDoc = await getDoc(doc(db, 'users', fid));
          if (userDoc.exists()) {
            friendList.push({ id: fid, ...userDoc.data() });
          }
        } catch (e) {
          console.error(e);
        }
      }
      setFriends(friendList);
      setLoading(false);
    };

    let snap1: any = null;
    let snap2: any = null;

    const unsubF1 = onSnapshot(qFriends1, (s) => {
      snap1 = s;
      if (snap2) fetchFriends(snap1, snap2);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'friendships'));

    const unsubF2 = onSnapshot(qFriends2, (s) => {
      snap2 = s;
      if (snap1) fetchFriends(snap1, snap2);
    }, (error) => handleFirestoreError(error, OperationType.LIST, 'friendships'));

    return () => {
      unsubReq();
      unsubF1();
      unsubF2();
    };
  }, [user]);

  if (!user) return null;

  return (
    <div className="mt-8 mb-8" dir={isRTL ? 'rtl' : 'ltr'}>
      <h3 className={`text-lg font-black mb-4 flex items-center gap-2 drop-shadow-sm ${isRTL ? 'text-right justify-start' : 'text-left justify-start'}`}>
        <Users className="w-5 h-5 text-primary" /> {getUITranslation(lang, 'friends')}
      </h3>
      
      {requests.length > 0 && (
        <div className="mb-6">
          <h4 className={`text-sm font-bold text-text-muted mb-3 ${isRTL ? 'text-right' : 'text-left'}`}>{getUITranslation(lang, 'friendRequests')} ({requests.length})</h4>
          <div className="space-y-3">
            {requests.map(req => (
              <div key={req.id} className="card-modern p-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <img src={req.user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${req.user.uid}`} alt={req.user.displayName} className="w-12 h-12 rounded-full bg-bg-dark border border-white/20 shadow-inner" />
                  <div className={isRTL ? 'text-right' : 'text-left'}>
                    <p className="font-black text-sm text-white drop-shadow-sm">{req.user.displayName}</p>
                    <p className="text-xs font-bold text-text-muted">{getUITranslation(lang, 'level')} {req.user.level}</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => acceptFriendRequest(req.id, req.fromId, req.toId)} className="p-2.5 bg-green-500/20 text-green-400 rounded-full hover:bg-green-500 hover:text-white transition-colors border border-green-500/30">
                    <UserCheck className="w-4 h-4" />
                  </button>
                  <button onClick={() => rejectFriendRequest(req.id)} className="p-2.5 bg-danger/20 text-danger rounded-full hover:bg-danger hover:text-white transition-colors border border-danger/30">
                    <UserX className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className={`text-sm font-bold text-text-muted mb-3 ${isRTL ? 'text-right' : 'text-left'}`}>{getUITranslation(lang, 'friendsList')} ({friends.length})</h4>
        {loading ? (
          <div className="text-center py-4 font-bold text-text-muted">{getUITranslation(lang, 'loading')}</div>
        ) : friends.length === 0 ? (
          <div className="text-center py-8 card-modern border-dashed opacity-70">
            <UserPlus className="w-10 h-10 text-text-muted mx-auto mb-3 opacity-50" />
            <p className="text-text-main font-bold text-sm">{getUITranslation(lang, 'noFriendsYet')}</p>
            <p className="text-xs font-bold text-text-muted mt-1">{getUITranslation(lang, 'addFriendsFromRooms')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {friends.map(friend => (
              <div key={friend.id} className="card-modern p-4 flex flex-col items-center text-center">
                <img src={friend.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${friend.uid}`} alt={friend.displayName} className="w-14 h-14 rounded-full bg-bg-dark mb-3 border border-white/20 shadow-inner" />
                <p className="font-black text-sm text-white truncate w-full drop-shadow-sm">{friend.displayName}</p>
                <p className="text-xs font-bold text-text-muted">{getUITranslation(lang, 'level')} {friend.level}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
