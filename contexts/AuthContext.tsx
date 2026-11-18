import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';

interface UserProfile {
  uid: string;
  displayName: string;
  photoURL: string;
  xp: number;
  level: number;
  stats: {
    wins: number;
    hosted: number;
    played: number;
    longestStreak: number;
  };
  connectedAccounts: {
    google: boolean;
    apple: boolean;
  };
}

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType>({ user: null, profile: null, loading: true });

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        // Fetch or create profile
        const userRef = doc(db, 'users', currentUser.uid);
        try {
          const docSnap = await getDoc(userRef);
          if (!docSnap.exists()) {
            const newProfile: UserProfile = {
              uid: currentUser.uid,
              displayName: currentUser.displayName || 'لاعب جديد',
              photoURL: currentUser.photoURL || '',
              xp: 0,
              level: 1,
              stats: { wins: 0, hosted: 0, played: 0, longestStreak: 0 },
              connectedAccounts: {
                google: currentUser.providerData.some(p => p.providerId === 'google.com'),
                apple: currentUser.providerData.some(p => p.providerId === 'apple.com')
              }
            };
            try {
              await setDoc(userRef, newProfile);
            } catch (e) {
              console.warn("Could not save new profile to server, using local copy", e);
            }
            setProfile(newProfile);
          } else {
            setProfile(docSnap.data() as UserProfile);
          }
        } catch (error: any) {
          if (error.message?.includes('offline') || error.message?.includes('network')) {
            console.warn("Client is offline, creating temporary local profile...");
            setProfile({
              uid: currentUser.uid,
              displayName: currentUser.displayName || 'لاعب جديد',
              photoURL: currentUser.photoURL || '',
              xp: 0,
              level: 1,
              stats: { wins: 0, hosted: 0, played: 0, longestStreak: 0 },
              connectedAccounts: { google: true, apple: false }
            });
          } else {
            handleFirestoreError(error, OperationType.GET, `users/${currentUser.uid}`);
          }
        }

        // Listen for profile changes
        const unsubProfile = onSnapshot(userRef, (doc) => {
          if (doc.exists()) {
            setProfile(doc.data() as UserProfile);
          }
        }, (error) => {
           console.warn("Profile snapshot error:", error);
           // We don't throw here for offline errors to avoid crashing during gameplay
           if (!error.message?.includes('offline')) {
             handleFirestoreError(error, OperationType.GET, `users/${currentUser.uid}`);
           }
        });

        setLoading(false);
        return () => unsubProfile();
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, []);

  return (
    <AuthContext.Provider value={{ user, profile, loading }}>
      {children}
    </AuthContext.Provider>
  );
};
