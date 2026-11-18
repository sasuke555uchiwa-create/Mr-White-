import React, { useState, useEffect } from 'react';
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { Trophy, Medal, Star } from 'lucide-react';
import { getUITranslation } from '../translations';
import { getSettings } from '../services/storageService';

export const LeaderboardSection: React.FC = () => {
  const [leaders, setLeaders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const lang = getSettings().language;
  const isRTL = ['ar', 'sa'].includes(lang);

  useEffect(() => {
    const fetchLeaders = async () => {
      try {
        const q = query(collection(db, 'users'), orderBy('xp', 'desc'), limit(10));
        const snapshot = await getDocs(q);
        const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setLeaders(data);
      } catch (error) {
        handleFirestoreError(error, OperationType.LIST, 'users');
      } finally {
        setLoading(false);
      }
    };
    fetchLeaders();
  }, []);

  if (loading) {
    return <div className="text-center py-4 text-text-muted">{getUITranslation(lang, 'loadingLeaderboard')}</div>;
  }

  return (
    <div className="mt-8 mb-8" dir={isRTL ? 'rtl' : 'ltr'}>
      <h3 className={`text-lg font-bold mb-4 flex items-center gap-2 ${isRTL ? 'text-right justify-start' : 'text-left justify-start'}`}>
        <Trophy className="w-5 h-5 text-yellow-500" /> {getUITranslation(lang, 'leaderboard')}
      </h3>
      
      <div className="card-modern overflow-hidden">
        {leaders.map((user, index) => (
          <div key={user.id} className="flex items-center gap-3 p-3 border-b border-white/5 last:border-0">
            <div className="w-8 text-center font-bold text-lg">
              {index === 0 ? <Medal className="w-6 h-6 text-yellow-400 mx-auto" /> : 
               index === 1 ? <Medal className="w-6 h-6 text-gray-300 mx-auto" /> : 
               index === 2 ? <Medal className="w-6 h-6 text-amber-600 mx-auto" /> : 
               <span className="text-text-muted">{index + 1}</span>}
            </div>
            <img src={user.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.uid}`} alt={user.displayName} className="w-10 h-10 rounded-full bg-bg-dark" />
            <div className={`flex-1 ${isRTL ? 'text-right' : 'text-left'}`}>
              <p className="font-bold text-sm text-white">{user.displayName}</p>
              <p className="text-xs text-text-muted">{getUITranslation(lang, 'level')} {user.level}</p>
            </div>
            <div className={`flex flex-col ${isRTL ? 'items-end' : 'items-start'}`}>
              <span className="text-sm font-bold text-primary flex items-center gap-1">
                {user.xp.toLocaleString()} <Star className="w-3 h-3" />
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
