/**
 * Firestore Security Rules Test Suite (Dirty Dozen Attack Payloads + Positive Access Checks)
 *
 * Run locally with Firebase Firestore Emulator (requires Java JRE):
 *   firebase emulators:exec --only firestore "npx vitest run firestore.rules.test.ts"
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  serverTimestamp,
} from 'firebase/firestore';
import { describe, it, beforeAll, afterAll, beforeEach } from 'vitest';

const PROJECT_ID = 'mercurial-yew-f6tp2';

describe('Firestore Security Rules', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules,
        host: '127.0.0.1',
        port: 8080,
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'users', 'alice'), {
        uid: 'alice',
        displayName: 'Alice',
        photoURL: '',
        xp: 100,
        level: 2,
        stats: { wins: 1, hosted: 1, played: 2, longestStreak: 1 },
        connectedAccounts: { google: true, apple: false },
      });
      await setDoc(doc(db, 'publicProfiles', 'alice'), {
        uid: 'alice',
        displayName: 'Alice',
        photoURL: '',
        xp: 100,
        level: 2,
        stats: { wins: 1, hosted: 1, played: 2, longestStreak: 1 },
        updatedAt: new Date(),
      });
      await setDoc(doc(db, 'users', 'bob'), {
        uid: 'bob',
        displayName: 'Bob',
        photoURL: '',
        xp: 50,
        level: 1,
        stats: { wins: 0, hosted: 0, played: 1, longestStreak: 0 },
        connectedAccounts: { google: true, apple: false },
      });
      await setDoc(doc(db, 'rooms', 'room_private'), {
        hostId: 'alice',
        isPrivate: true,
        status: 'waiting',
        playerIds: ['alice'],
        players: [{ uid: 'alice', name: 'Alice' }],
      });
      await setDoc(doc(db, 'rooms', 'room_public'), {
        hostId: 'alice',
        isPrivate: false,
        status: 'waiting',
        playerIds: ['alice'],
        players: [{ uid: 'alice', name: 'Alice' }],
      });
      await setDoc(doc(db, 'rooms', 'room_private', 'privatePlayers', 'alice'), {
        uid: 'alice',
        role: 'mrwhite',
        word: '',
      });
      await setDoc(doc(db, 'rooms', 'room_private', 'privateMeta', 'invite'), {
        secretCode: '123456',
      });
      await setDoc(doc(db, 'rooms', 'room_private', 'privateState', 'current'), {
        civilianWord: 'قهوة',
        undercoverWord: 'شاي',
      });
    });
  });

  const aliceDb = () =>
    testEnv.authenticatedContext('alice', { email: 'alice@example.com', email_verified: true }).firestore();
  const bobDb = () =>
    testEnv.authenticatedContext('bob', { email: 'bob@example.com', email_verified: true }).firestore();

  // --- Dirty Dozen Attack Payloads ---
  it('1. DENIES fake profile XP injection on users/{uid}', async () => {
    await assertFails(
      updateDoc(doc(aliceDb(), 'users', 'alice'), {
        xp: 99999,
        level: 99,
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('2. DENIES admin escalation shadow field isAdmin on user profile create/update', async () => {
    const charlieDb = testEnv
      .authenticatedContext('charlie', { email: 'charlie@example.com', email_verified: true })
      .firestore();
    await assertFails(
      setDoc(doc(charlieDb, 'users', 'charlie'), {
        uid: 'charlie',
        displayName: 'Hacker',
        photoURL: '',
        xp: 0,
        level: 1,
        stats: { wins: 0, hosted: 0, played: 0, longestStreak: 0 },
        connectedAccounts: { google: true, apple: false },
        isAdmin: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('3. DENIES cross-user PII read on users/{victimUid}', async () => {
    await assertFails(getDoc(doc(bobDb(), 'users', 'alice')));
  });

  it('4. DENIES listing users directory', async () => {
    await assertFails(getDocs(collection(bobDb(), 'users')));
  });

  it('5. DENIES leaderboard XP/stats tampering on publicProfiles/{uid}', async () => {
    await assertFails(
      updateDoc(doc(aliceDb(), 'publicProfiles', 'alice'), {
        xp: 50000,
        stats: { wins: 500, hosted: 0, played: 0, longestStreak: 0 },
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('6. DENIES listing private rooms or unfiltered rooms queries', async () => {
    await assertFails(getDocs(collection(bobDb(), 'rooms')));
    await assertFails(getDocs(query(collection(bobDb(), 'rooms'), where('isPrivate', '==', true))));
  });

  it('7. DENIES non-member reading private room', async () => {
    await assertFails(getDoc(doc(bobDb(), 'rooms', 'room_private')));
  });

  it('8. DENIES direct client room mutations', async () => {
    await assertFails(
      updateDoc(doc(aliceDb(), 'rooms', 'room_private'), {
        status: 'finished',
      })
    );
  });

  it('9. DENIES cross-player privatePlayers secret word snooping', async () => {
    await assertFails(getDoc(doc(bobDb(), 'rooms', 'room_private', 'privatePlayers', 'alice')));
  });

  it('10. DENIES non-member privateMeta/invite snooping', async () => {
    await assertFails(getDoc(doc(bobDb(), 'rooms', 'room_private', 'privateMeta', 'invite')));
  });

  it('11. DENIES client access to server-only privateState', async () => {
    await assertFails(getDoc(doc(aliceDb(), 'rooms', 'room_private', 'privateState', 'current')));
  });

  it('12. DENIES direct client friendRequests forgery', async () => {
    await assertFails(
      setDoc(doc(bobDb(), 'friendRequests', 'alice_bob'), {
        fromId: 'alice',
        toId: 'bob',
        status: 'accepted',
      })
    );
  });

  // --- Positive Functional Verification ---
  it('ALLOWS verified owner to create and safely update own profile with serverTimestamp', async () => {
    const charlieDb = testEnv
      .authenticatedContext('charlie', { email: 'charlie@example.com', email_verified: true })
      .firestore();
    await assertSucceeds(
      setDoc(doc(charlieDb, 'users', 'charlie'), {
        uid: 'charlie',
        displayName: 'Charlie',
        photoURL: '',
        xp: 0,
        level: 1,
        stats: { wins: 0, hosted: 0, played: 0, longestStreak: 0 },
        connectedAccounts: { google: true, apple: false },
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    );
    await assertSucceeds(
      updateDoc(doc(aliceDb(), 'users', 'alice'), {
        displayName: 'Alice Updated',
        updatedAt: serverTimestamp(),
      })
    );
  });

  it('ALLOWS room member to read own privatePlayers doc and signed-in users to list public waiting rooms', async () => {
    await assertSucceeds(getDoc(doc(aliceDb(), 'rooms', 'room_private', 'privatePlayers', 'alice')));
    await assertSucceeds(getDoc(doc(aliceDb(), 'rooms', 'room_private', 'privateMeta', 'invite')));
    await assertSucceeds(
      getDocs(
        query(
          collection(bobDb(), 'rooms'),
          where('isPrivate', '==', false),
          where('status', '==', 'waiting')
        )
      )
    );
  });
});
