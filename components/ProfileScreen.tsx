import React from 'react';
import { useAuth } from '../contexts/AuthContext';
import { signInWithGoogle, signInWithGoogleRedirect, handleRedirectResult, logOut } from '../firebase';
import { motion } from 'framer-motion';
import { ArrowRight, Edit2, Award, Flame, CheckCircle, Circle, Image as ImageIcon, RefreshCw, AlertCircle } from 'lucide-react';

import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';

import { FriendsSection } from './FriendsSection';
import { LeaderboardSection } from './LeaderboardSection';
import { Avatar } from './Avatar';
import { getUITranslation } from '../translations';
import { getSettings } from '../services/storageService';
import { showToast } from '../utils/toast';
import { compressAvatarImage } from '../utils/imageUtils';
import { getLevelProgress } from '../utils/levelUtils';

interface ProfileScreenProps {
  onBack: () => void;
}

export const ProfileScreen: React.FC<ProfileScreenProps> = ({ onBack }) => {
  const { user, profile, loading } = useAuth();
  const [isSigningIn, setIsSigningIn] = React.useState(false);
  const [authError, setAuthError] = React.useState<string | null>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [editName, setEditName] = React.useState('');
  const [editAvatar, setEditAvatar] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [showAvatarMenu, setShowAvatarMenu] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const lang = getSettings().language;
  const isRTL = ['ar', 'sa'].includes(lang);

  React.useEffect(() => {
    // Handle redirect result on mount
    handleRedirectResult()
      .then((result) => {
        if (result) {
          console.log("Redirect sign in success");
        }
      })
      .catch((error) => {
        console.error("Redirect sign in error:", error);
        setAuthError(`${getUITranslation(lang, 'signInError')} (${error.code})`);
      });
  }, []);

  React.useEffect(() => {
    if (profile) {
      setEditName(profile.displayName);
      setEditAvatar(profile.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${profile.uid}`);
    }
  }, [profile]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size > 1024 * 1024 * 5) {
      showToast(getUITranslation(lang, 'imageTooLarge'), 'error');
      return;
    }

    try {
      const compressed = await compressAvatarImage(file, 256, 0.85);
      setEditAvatar(compressed);
      setShowAvatarMenu(false);
    } catch {
      showToast(getUITranslation(lang, 'imageTooLarge'), 'error');
    }
  };

  const handleSaveProfile = async () => {
    if (!user || !profile || !editName.trim()) return;
    
    setIsSaving(true);
    try {
      const userRef = doc(db, 'users', user.uid);
      await updateDoc(userRef, {
        displayName: editName.trim(),
        photoURL: editAvatar
      });
      setIsEditing(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  const handleSignIn = () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    setAuthError(null);
    
    // Call signInWithGoogle immediately without awaiting first to preserve user interaction context
    signInWithGoogle()
      .catch((error: any) => {
        console.error("Sign in error:", error);
        if (error.code === 'auth/popup-blocked') {
          setAuthError(getUITranslation(lang, 'popupBlocked'));
        } else if (error.code === 'auth/cancelled-popup-request' || error.code === 'auth/popup-closed-by-user') {
          setAuthError(getUITranslation(lang, 'signInCancelled'));
        } else {
          setAuthError(`${getUITranslation(lang, 'signInError')} (${error.code || 'unknown'})`);
        }
      })
      .finally(() => {
        setIsSigningIn(false);
      });
  };

  const handleSignInRedirect = () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    setAuthError(null);
    signInWithGoogleRedirect();
  };

  if (!user || !profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 text-center" dir={isRTL ? 'rtl' : 'ltr'}>
        <h2 className="text-2xl font-bold mb-4">{getUITranslation(lang, 'signInRequired')}</h2>
        <p className="text-text-muted mb-8">{getUITranslation(lang, 'signInToSaveProgress')}</p>
        
        {authError && (
          <div className="mb-6 p-4 bg-danger/20 border border-danger/50 rounded-xl text-danger text-sm flex items-center gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span className="font-bold">{authError}</span>
          </div>
        )}

        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={handleSignIn}
            disabled={isSigningIn}
            className={`w-full py-4 bg-bg-surface text-text-main rounded-2xl font-bold shadow-lg flex items-center justify-center gap-3 transition-colors border border-border ${isSigningIn ? 'opacity-70 cursor-not-allowed' : 'hover:bg-bg-card'}`}
          >
            {isSigningIn ? (
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-black"></div>
            ) : (
              <>
                <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="Google" className="w-6 h-6" />
                {getUITranslation(lang, 'signInWithGoogle')}
              </>
            )}
          </button>

          {/* Fallback for mobile/blocked popups */}
          {!isSigningIn && (
            <button
              onClick={handleSignInRedirect}
              className="w-full py-3 bg-white/5 text-text-muted rounded-2xl font-bold border border-white/10 hover:bg-white/10 transition-colors text-sm"
            >
              {isRTL ? 'مشكلة في النافذة؟ جرب طريقة أخرى' : 'Problem with popup? Try another way'}
            </button>
          )}
        </div>
        <button
          onClick={onBack}
          className="mt-6 text-text-muted hover:text-white transition-colors"
        >
          {getUITranslation(lang, 'backToHome')}
        </button>
      </div>
    );
  }

  const levelInfo = getLevelProgress(profile.xp, profile.level);

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="flex flex-col bg-gradient-to-b from-blue-900/20 to-bg-dark p-4 max-w-2xl mx-auto w-full"
      dir={isRTL ? 'rtl' : 'ltr'}
    >
      {/* Header */}
      <div className={`flex justify-between items-center mb-8 ${isRTL ? 'flex-row-reverse' : 'flex-row'}`}>
        <button onClick={onBack} className="p-3 card-modern">
          <ArrowRight className={`w-6 h-6 ${isRTL ? '' : 'rotate-180'}`} />
        </button>
      </div>

      {/* Avatar & Name */}
      <div className="flex flex-col items-center mb-8">
        <div className="relative">
          <Avatar 
            avatar={isEditing ? editAvatar : (profile.photoURL || '')} 
            name={isEditing ? editName : profile.displayName} 
            size={112} 
          />
          {isEditing ? (
            <div className="relative">
              <button 
                onClick={() => setShowAvatarMenu(!showAvatarMenu)}
                className="absolute bottom-0 right-0 p-2 bg-primary rounded-full border-2 border-bg-dark text-white hover:bg-primary-dark transition-colors z-10"
              >
                <Edit2 className="w-4 h-4" />
              </button>
              
              {showAvatarMenu && (
                <div className={`absolute top-full mt-2 ${isRTL ? 'left-[-40px]' : 'right-[-40px]'} w-48 card-modern shadow-xl overflow-hidden z-20`}>
                  <button
                    onClick={() => {
                      setShowAvatarMenu(false);
                      setEditAvatar('');
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors ${isRTL ? 'text-right' : 'text-left'}`}
                  >
                    <RefreshCw className="w-4 h-4 text-primary" />
                    <span className="font-bold text-sm">{getUITranslation(lang, 'useLetter')}</span>
                  </button>
                  <button
                    onClick={() => {
                      setShowAvatarMenu(false);
                      fileInputRef.current?.click();
                    }}
                    className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-white/5 transition-colors ${isRTL ? 'text-right' : 'text-left'} border-t border-white/5`}
                  >
                    <ImageIcon className="w-4 h-4 text-blue-400" />
                    <span className="font-bold text-sm">{getUITranslation(lang, 'uploadImage')}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button 
              onClick={() => setIsEditing(true)}
              className="absolute bottom-0 right-0 p-2 bg-bg-surface rounded-full border-2 border-bg-dark text-white hover:bg-primary transition-colors"
            >
              <Edit2 className="w-4 h-4" />
            </button>
          )}
        </div>
        
        {/* Hidden file input outside the conditional menu */}
        <input 
          type="file" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
          accept="image/png, image/jpeg, image/jpg, image/gif, image/webp" 
          className="hidden" 
        />
        
        {isEditing ? (
          <div className="mt-4 flex flex-col items-center gap-3 w-full max-w-xs">
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="w-full bg-bg-surface border border-white/10 rounded-xl p-3 text-white text-center font-bold"
              placeholder={getUITranslation(lang, 'yourName')}
              maxLength={20}
            />
            <div className="flex gap-2 w-full">
              <button
                onClick={() => {
                  setIsEditing(false);
                  setEditName(profile.displayName);
                  setEditAvatar(profile.photoURL || `https://api.dicebear.com/7.x/avataaars/svg?seed=${profile.uid}`);
                }}
                className="btn-modern btn-modern-outline flex-1 py-2 rounded-xl"
                disabled={isSaving}
              >
                {getUITranslation(lang, 'cancel')}
              </button>
              <button
                onClick={handleSaveProfile}
                disabled={isSaving || !editName.trim()}
                className="btn-modern flex-1 py-2 rounded-xl"
              >
                {isSaving ? getUITranslation(lang, 'saving') : getUITranslation(lang, 'save')}
              </button>
            </div>
          </div>
        ) : (
          <h2 className="text-2xl font-bold mt-4 flex items-center gap-2">
            {profile.displayName}
            <Edit2 
              className="w-4 h-4 text-text-muted cursor-pointer hover:text-white" 
              onClick={() => setIsEditing(true)}
            />
          </h2>
        )}
      </div>

      {/* Level & XP */}
      <div className="bg-bg-surface rounded-full p-1 flex items-center mb-6 shadow-lg border border-border">
        <div className="flex-1 px-4">
          <div className="flex justify-between text-xs font-bold text-text-muted mb-1 tabular-nums">
            <span>XP {profile.xp.toLocaleString()} / {levelInfo.nextLevelTotalXp.toLocaleString()}</span>
            <span>{levelInfo.currentLevelXp} / {levelInfo.levelSpanXp}</span>
          </div>
          <div className="h-2 bg-bg-dark rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${levelInfo.progressPercent}%` }}></div>
          </div>
        </div>
        <div className="bg-blue-500 text-white font-bold px-4 py-2 rounded-full shadow-md tabular-nums">
          {levelInfo.level} LV
        </div>
      </div>

      {/* Agent Rank & Streak Card */}
      <div className="card-modern p-4 flex items-center justify-between mb-8 border border-amber-400/25 bg-gradient-to-r from-amber-500/10 via-sky-500/5 to-transparent">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 bg-amber-500/20 rounded-2xl flex items-center justify-center text-amber-400 border border-amber-400/30 shrink-0">
            <Award className="w-6 h-6" />
          </div>
          <div className={isRTL ? 'text-right' : 'text-left'}>
            <h3 className="font-black text-amber-300 drop-shadow-sm text-sm sm:text-base">
              {levelInfo.level >= 10
                ? isRTL ? 'عميل سري أسطوري' : 'Master Infiltrator'
                : levelInfo.level >= 5
                ? isRTL ? 'محقق مخضرم' : 'Veteran Detective'
                : isRTL ? 'عميل مبتدئ' : 'Rookie Agent'}
            </h3>
            <p className="text-xs text-text-muted font-bold">
              {isRTL
                ? `المستوى ${levelInfo.level} · ${profile.stats.wins} انتصار مسجل`
                : `Level ${levelInfo.level} · ${profile.stats.wins} total wins`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-amber-500/15 border border-amber-400/30 text-amber-300 font-black text-xs shrink-0 tabular-nums">
          <Flame className="w-4 h-4 text-orange-400" />
          <span>{profile.stats.longestStreak || 0}</span>
        </div>
      </div>

      {/* Stats */}
      <h3 className={`text-lg font-black mb-4 drop-shadow-sm ${isRTL ? 'text-right' : 'text-left'}`}>{getUITranslation(lang, 'onlineStats')}</h3>
      <div className="grid grid-cols-2 gap-3 mb-8">
        <div className="card-modern p-4 text-center text-white bg-gradient-to-br from-blue-500/20 to-blue-600/10">
          <div className="text-3xl font-black mb-1 drop-shadow-md text-blue-400">
            {profile.stats.played > 0 ? Math.round((profile.stats.wins / profile.stats.played) * 100) : 0}%
          </div>
          <div className="text-sm font-bold text-text-muted">{getUITranslation(lang, 'winRate')}</div>
        </div>
        <div className="card-modern p-4 text-center text-white bg-gradient-to-br from-teal-500/20 to-teal-600/10">
          <div className="text-3xl font-black mb-1 drop-shadow-md text-teal-400">{profile.stats.hosted}</div>
          <div className="text-sm font-bold text-text-muted">{getUITranslation(lang, 'hostedGames')}</div>
        </div>
        <div className="card-modern p-4 text-center text-white bg-gradient-to-br from-green-500/20 to-green-600/10">
          <div className="text-3xl font-black mb-1 drop-shadow-md text-green-400">{profile.stats.played}</div>
          <div className="text-sm font-bold text-text-muted">{getUITranslation(lang, 'gamesPlayed')}</div>
        </div>
        <div className="card-modern p-4 text-center text-white bg-gradient-to-br from-purple-500/20 to-purple-600/10">
          <div className="text-3xl font-black mb-1 drop-shadow-md text-purple-400">{profile.stats.longestStreak}</div>
          <div className="text-sm font-bold text-text-muted">{getUITranslation(lang, 'longestWinStreak')}</div>
        </div>
      </div>

      {/* Friends Section */}
      <FriendsSection />

      {/* Leaderboard Section */}
      <LeaderboardSection />

      {/* Connected Accounts */}
      <h3 className={`text-lg font-black mb-4 drop-shadow-sm ${isRTL ? 'text-right' : 'text-left'}`}>{getUITranslation(lang, 'connectedAccounts')}</h3>
      <div className="card-modern overflow-hidden mb-8">
        <div className="flex items-center gap-3 p-4 border-b border-white/5">
          {profile.connectedAccounts.apple ? (
            <CheckCircle className="w-6 h-6 text-blue-400 drop-shadow-sm" />
          ) : (
            <Circle className="w-6 h-6 text-text-muted" />
          )}
          <span className="font-bold text-text-main">Apple</span>
        </div>
        <div className="flex items-center gap-3 p-4">
          {profile.connectedAccounts.google ? (
            <CheckCircle className="w-6 h-6 text-blue-400 drop-shadow-sm" />
          ) : (
            <Circle className="w-6 h-6 text-text-muted" />
          )}
          <div className={isRTL ? 'text-right' : 'text-left'}>
            <span className="font-bold block text-text-main">Google</span>
            {profile.connectedAccounts.google && user?.email && (
              <span className="text-sm text-text-muted font-bold">{user.email}</span>
            )}
          </div>
        </div>
      </div>

      <button 
        onClick={logOut}
        className="btn-modern btn-modern-danger w-full py-5 rounded-[2rem] font-black mb-8"
      >
        {getUITranslation(lang, 'logOut')}
      </button>
    </motion.div>
  );
};
