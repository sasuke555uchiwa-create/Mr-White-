import { describe, expect, it } from 'vitest';
import { DESIGNATED_OWNER_EMAIL, executeCheckAdminStatus } from '../functions/src/adminPolicy';
import { DbLike, DocRefLike, TxLike } from '../functions/src/errors';
import {
  executeAdvanceTurn,
  executeBeginMatch,
  executeNextMatch,
  executeResolveVotes,
  executeReturnToLobby,
  executeStartRound,
  executeStartVoting,
  executeSubmitMrWhiteGuess,
  executeSubmitVote,
} from '../functions/src/gameHandlers';
import {
  executeCreateRoom,
  executeJoinRoom,
  executeKickPlayer,
  executeQuickJoinRoom,
} from '../functions/src/roomHandlers';
import { buildPublicProfileBackfill } from '../utils/profileBackfill';
import { SPECIAL_ROLES } from '../data/specialRoles';

/**
 * Lightweight transactional in-memory Firestore double matching DbLike / TxLike
 * so production backend handlers run verbatim under Vitest without emulator JRE.
 */
class InMemoryFirestore implements DbLike {
  private store = new Map<string, Record<string, any>>();
  private autoCounter = 0;

  setRaw(path: string, data: Record<string, any>) {
    this.store.set(path, structuredClone(data));
  }

  getRaw(path: string): Record<string, any> | undefined {
    const val = this.store.get(path);
    return val ? structuredClone(val) : undefined;
  }

  private applyDotPatch(target: Record<string, any>, patch: Record<string, any>) {
    for (const [k, v] of Object.entries(patch)) {
      if (!k.includes('.')) {
        target[k] = structuredClone(v);
      } else {
        const parts = k.split('.');
        let cursor: any = target;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') {
            cursor[parts[i]] = {};
          }
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = structuredClone(v);
      }
    }
  }

  private makeDocRef(docPath: string): DocRefLike {
    const parts = docPath.split('/');
    const id = parts[parts.length - 1];
    return {
      id,
      collection: (subPath: string) => this.makeCollectionRef(`${docPath}/${subPath}`),
      get: async () => {
        const data = this.getRaw(docPath);
        return {
          exists: data !== undefined,
          id,
          ref: this.makeDocRef(docPath),
          data: () => data,
        };
      },
    };
  }

  private makeCollectionRef(colPath: string) {
    const queryWith = (filters: Array<{ field: string; value: any }> = []) => ({
      where: (field: string, _op: string, value: any) =>
        queryWith([...filters, { field, value }]),
      limit: (_n: number) => ({
        get: async () => this.queryDocs(colPath, filters),
      }),
      get: async () => this.queryDocs(colPath, filters),
    });

    return {
      doc: (id?: string) => {
        const docId = id || `auto_${++this.autoCounter}`;
        return this.makeDocRef(`${colPath}/${docId}`);
      },
      get: async () => this.queryDocs(colPath, []),
      where: (field: string, _op: string, value: any) => queryWith([{ field, value }]),
      limit: (_n: number) => ({
        get: async () => this.queryDocs(colPath, []),
      }),
    };
  }

  private queryDocs(colPath: string, filters: Array<{ field: string; value: any }>) {
    const prefix = `${colPath}/`;
    const docs: any[] = [];
    for (const [path, data] of this.store.entries()) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      if (remainder.includes('/')) continue;
      if (filters.every((f) => data[f.field] === f.value)) {
        docs.push({
          exists: true,
          id: remainder,
          ref: this.makeDocRef(path),
          data: () => structuredClone(data),
        });
      }
    }
    return { docs };
  }

  private resolvePathFromRef(ref: DocRefLike): string {
    // DocRef id lookup helper via stored closure path: reconstruct using a symbol/property
    return (ref as any).__path;
  }

  collection(path: string) {
    const base = this.makeCollectionRef(path);
    return {
      ...base,
      doc: (id?: string) => {
        const docId = id || `auto_${++this.autoCounter}`;
        return this.attachPath(this.makeDocRef(`${path}/${docId}`), `${path}/${docId}`);
      },
    };
  }

  private attachPath(ref: DocRefLike, docPath: string): DocRefLike {
    const wrapped: any = {
      id: ref.id,
      __path: docPath,
      collection: (subPath: string) => {
        const subBase = this.makeCollectionRef(`${docPath}/${subPath}`);
        return {
          ...subBase,
          doc: (id?: string) => {
            const docId = id || `auto_${++this.autoCounter}`;
            return this.attachPath(
              this.makeDocRef(`${docPath}/${subPath}/${docId}`),
              `${docPath}/${subPath}/${docId}`
            );
          },
          get: async () => {
            const q = await subBase.get();
            return {
              docs: q.docs.map((d) => ({
                ...d,
                ref: this.attachPath(d.ref, `${docPath}/${subPath}/${d.id}`),
              })),
            };
          },
        };
      },
      get: async () => {
        const data = this.getRaw(docPath);
        return {
          exists: data !== undefined,
          id: ref.id,
          ref: wrapped,
          data: () => data,
        };
      },
    };
    return wrapped;
  }

  async runTransaction<T>(fn: (tx: TxLike) => Promise<T>): Promise<T> {
    const staging = new Map<string, Record<string, any>>(
      Array.from(this.store.entries()).map(([k, v]) => [k, structuredClone(v)])
    );
    const ops: Array<() => void> = [];

    const readFromStaging = (docPath: string) => {
      const val = staging.get(docPath);
      return val ? structuredClone(val) : undefined;
    };

    const tx: TxLike = {
      get: async (ref) => {
        const p = this.resolvePathFromRef(ref);
        const data = readFromStaging(p);
        return {
          exists: data !== undefined,
          id: ref.id,
          ref,
          data: () => data,
        };
      },
      getAll: async (...refs) =>
        Promise.all(
          refs.map(async (ref) => {
            const p = this.resolvePathFromRef(ref);
            const data = readFromStaging(p);
            return {
              exists: data !== undefined,
              id: ref.id,
              ref,
              data: () => data,
            };
          })
        ),
      set: (ref, data) => {
        const p = this.resolvePathFromRef(ref);
        const clone = structuredClone(data);
        staging.set(p, clone);
        ops.push(() => this.store.set(p, clone));
      },
      update: (ref, patch) => {
        const p = this.resolvePathFromRef(ref);
        const existing = staging.get(p) || {};
        this.applyDotPatch(existing, patch);
        staging.set(p, existing);
        ops.push(() => {
          const cur = this.store.get(p) || {};
          this.applyDotPatch(cur, patch);
          this.store.set(p, cur);
        });
      },
      delete: (ref) => {
        const p = this.resolvePathFromRef(ref);
        staging.delete(p);
        ops.push(() => this.store.delete(p));
      },
    };

    const res = await fn(tx);
    for (const op of ops) op();
    return res;
  }

  batch() {
    const deletions: string[] = [];
    return {
      delete: (ref: DocRefLike) => {
        deletions.push(this.resolvePathFromRef(ref));
      },
      commit: async () => {
        for (const p of deletions) {
          this.store.delete(p);
        }
      },
    };
  }
}

function makePlayer(uid: string, overrides: Partial<any> = {}) {
  return {
    uid,
    name: uid,
    avatar: '',
    isReady: true,
    isEliminated: false,
    score: 0,
    revealedRole: null,
    ...overrides,
  };
}

function createDeps(db: InMemoryFirestore, nowMs = 1_700_000_000_000) {
  return {
    db,
    serverTimestamp: () => 'SERVER_TS',
    now: () => nowMs,
  };
}

describe('P0 & P1 Security Audit Regression Suite', () => {
  it('1. submitMrWhiteGuess wrong guess & forceEliminateMissing do NOT return secretWord; revealed only after RESULT phase', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db);

    db.setRaw('rooms/r1', {
      id: 'r1',
      hostId: 'p1',
      status: 'playing',
      difficulty: 'easy',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3'), makePlayer('p4')],
      gameState: {
        phase: 'IMPOSTOR_GUESS',
        matchId: 'm1',
        round: 1,
        guesserUid: 'p4',
        mostVotedId: 'p4',
      },
    });
    db.setRaw('rooms/r1/privateState/current', {
      matchId: 'm1',
      round: 1,
      civilianWord: 'قهوة',
      undercoverWord: 'شاي',
      decoys: [],
      impostorIds: ['p4'],
      undercoverIds: ['p3'],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'undercover', p4: 'mrwhite' },
      votesByUid: {},
      settledMatches: [],
    });

    // Normal wrong guess while undercover remains -> match continues
    const wrongRes = await executeSubmitMrWhiteGuess(deps, 'p4', {
      roomId: 'r1',
      guess: 'سيارة',
    });
    expect(wrongRes).toEqual({ isCorrect: false });
    expect((wrongRes as any).secretWord).toBeUndefined();

    const afterWrongRoom = db.getRaw('rooms/r1')!;
    expect(afterWrongRoom.gameState.phase).toBe('PLAYING');
    expect(afterWrongRoom.gameState.revealedResult).toBeUndefined();

    // Now test host forceEliminateMissing when Mr. White disconnected
    db.setRaw('rooms/r2', {
      id: 'r2',
      hostId: 'p1',
      status: 'playing',
      difficulty: 'easy',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3')],
      gameState: {
        phase: 'IMPOSTOR_GUESS',
        matchId: 'm2',
        round: 1,
        guesserUid: 'p4_gone',
        mostVotedId: 'p4_gone',
      },
    });
    db.setRaw('rooms/r2/privateState/current', {
      matchId: 'm2',
      round: 1,
      civilianWord: 'تفاح',
      undercoverWord: 'كمثرى',
      decoys: [],
      impostorIds: ['p4_gone'],
      undercoverIds: ['p3'],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'undercover', p4_gone: 'mrwhite' },
      votesByUid: {},
      settledMatches: [],
    });

    const forceRes = await executeSubmitMrWhiteGuess(deps, 'p1', {
      roomId: 'r2',
      guess: '',
      forceEliminateMissing: true,
    });
    expect(forceRes).toEqual({ isCorrect: false });
    expect((forceRes as any).secretWord).toBeUndefined();
    expect(db.getRaw('rooms/r2')!.gameState.phase).toBe('PLAYING');

    // Correct guess returns ONLY { isCorrect: true }, and public RESULT state reveals secretWord
    db.setRaw('rooms/r3', {
      id: 'r3',
      hostId: 'p1',
      status: 'playing',
      difficulty: 'easy',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3')],
      gameState: {
        phase: 'IMPOSTOR_GUESS',
        matchId: 'm3',
        round: 1,
        guesserUid: 'p3',
        mostVotedId: 'p3',
      },
    });
    db.setRaw('rooms/r3/privateState/current', {
      matchId: 'm3',
      round: 1,
      civilianWord: 'أسد',
      undercoverWord: 'نمر',
      decoys: [],
      impostorIds: ['p3'],
      undercoverIds: [],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'mrwhite' },
      votesByUid: {},
      settledMatches: [],
    });

    const winRes = await executeSubmitMrWhiteGuess(deps, 'p3', {
      roomId: 'r3',
      guess: 'أسد',
    });
    expect(winRes).toEqual({ isCorrect: true });
    expect((winRes as any).secretWord).toBeUndefined();
    const afterWinRoom = db.getRaw('rooms/r3')!;
    expect(afterWinRoom.gameState.phase).toBe('RESULT');
    expect(afterWinRoom.gameState.revealedResult.secretWord).toBe('أسد');
  });

  it('2. Admin lifecycle grants active admin, revokes stale claim on inactive/deleted doc & owner deactivation', async () => {
    const db = new InMemoryFirestore();
    const claimsStore = new Map<string, Record<string, any>>();
    const adminAuth = {
      getUser: async (uid: string) => ({ customClaims: claimsStore.get(uid) || {} }),
      setCustomUserClaims: async (uid: string, claims: Record<string, any> | null) => {
        claimsStore.set(uid, claims || {});
      },
    };

    // Active admin without claim -> granted
    db.setRaw('admins/admin1', { active: true });
    claimsStore.set('admin1', { role: 'user' });
    const granted = await executeCheckAdminStatus(
      { db, adminAuth },
      { uid: 'admin1', token: { email: 'a@test.com' } }
    );
    expect(granted).toEqual({ isAdmin: true, shouldRefreshToken: true, claimUpdated: true });
    expect(claimsStore.get('admin1')?.admin).toBe(true);

    // Inactive admin with stale claim -> REVOKED and token refresh requested
    db.setRaw('admins/admin1', { active: false });
    const revokedInactive = await executeCheckAdminStatus(
      { db, adminAuth },
      { uid: 'admin1', token: { admin: true, email: 'a@test.com' } }
    );
    expect(revokedInactive).toEqual({
      isAdmin: false,
      shouldRefreshToken: true,
      claimUpdated: true,
    });
    expect(claimsStore.get('admin1')?.admin).toBeUndefined();

    // Deleted admin doc with stale claim -> REVOKED
    const db2 = new InMemoryFirestore();
    claimsStore.set('admin2', { admin: true });
    const revokedDeleted = await executeCheckAdminStatus(
      { db: db2, adminAuth },
      { uid: 'admin2', token: { admin: true, email: 'b@test.com' } }
    );
    expect(revokedDeleted).toEqual({
      isAdmin: false,
      shouldRefreshToken: true,
      claimUpdated: true,
    });
    expect(claimsStore.get('admin2')?.admin).toBeUndefined();

    // Designated owner works when verified and not deactivated, and is denied if admins/{uid}.active === false
    claimsStore.set('owner1', { admin: true });
    const ownerOk = await executeCheckAdminStatus(
      { db: db2, adminAuth },
      {
        uid: 'owner1',
        token: { admin: true, email: DESIGNATED_OWNER_EMAIL, email_verified: true },
      }
    );
    expect(ownerOk).toEqual({ isAdmin: true, shouldRefreshToken: false, claimUpdated: false });

    db2.setRaw('admins/owner1', { active: false });
    const ownerRevoked = await executeCheckAdminStatus(
      { db: db2, adminAuth },
      {
        uid: 'owner1',
        token: { admin: true, email: DESIGNATED_OWNER_EMAIL, email_verified: true },
      }
    );
    expect(ownerRevoked).toEqual({
      isAdmin: false,
      shouldRefreshToken: true,
      claimUpdated: true,
    });
  });

  it('3, 4, 5. Match transition enforcement for beginMatch, startRound, nextMatch, and returnToLobby', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db);

    db.setRaw('rooms/r1', {
      id: 'r1',
      hostId: 'p1',
      status: 'waiting',
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3')],
      playerIds: ['p1', 'p2', 'p3'],
      gameState: null,
    });

    // Cannot call startRound, nextMatch, or returnToLobby while waiting
    await expect(executeStartRound(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();
    await expect(executeNextMatch(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();
    await expect(executeReturnToLobby(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();

    // beginMatch succeeds from waiting
    await executeBeginMatch(deps, 'p1', { roomId: 'r1' });
    expect(db.getRaw('rooms/r1')!.gameState.phase).toBe('SETUP_PENDING');

    // Duplicate beginMatch rejected
    await expect(executeBeginMatch(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();

    // startRound succeeds in SETUP_PENDING
    await executeStartRound(deps, 'p1', { roomId: 'r1' });
    expect(db.getRaw('rooms/r1')!.gameState.phase).toBe('REVEAL');

    // Host cannot call startRound again during REVEAL/PLAYING to reroll secret words/roles
    await expect(executeStartRound(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();
    await expect(executeNextMatch(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();
    await expect(executeReturnToLobby(deps, 'p1', { roomId: 'r1' })).rejects.toThrow();

    // Force room to RESULT -> both nextMatch and returnToLobby are now allowed
    const r = db.getRaw('rooms/r1')!;
    r.gameState.phase = 'RESULT';
    db.setRaw('rooms/r1', r);

    await executeNextMatch(deps, 'p1', { roomId: 'r1' });
    expect(db.getRaw('rooms/r1')!.gameState.phase).toBe('SETUP_PENDING');

    // From SETUP_PENDING returnToLobby is allowed and resets privatePlayers
    await executeReturnToLobby(deps, 'p1', { roomId: 'r1' });
    expect(db.getRaw('rooms/r1')!.status).toBe('waiting');
    expect(db.getRaw('rooms/r1')!.gameState).toBeNull();
  });

  it('6. Private room join requires valid invite code even when roomId is supplied; preserves public & reconnection', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db);

    const priv = await executeCreateRoom(deps, 'host', { name: 'Host' }, { isPrivate: true });
    const pub = await executeCreateRoom(deps, 'host2', { name: 'Host2' }, { isPrivate: false });

    // Private room reject without secretCode even with roomId
    await expect(
      executeJoinRoom(deps, 'intruder', { name: 'Intruder' }, { roomId: priv.roomId })
    ).rejects.toThrow(/invitation code/i);

    // Private room reject with wrong secretCode
    await expect(
      executeJoinRoom(
        deps,
        'intruder',
        { name: 'Intruder' },
        { roomId: priv.roomId, secretCode: '000000' }
      )
    ).rejects.toThrow();

    // Private room join succeeds with valid secretCode
    const joinedPriv = await executeJoinRoom(
      deps,
      'friend',
      { name: 'Friend' },
      { roomId: priv.roomId, secretCode: priv.secretCode }
    );
    expect(joinedPriv).toEqual({ success: true, roomId: priv.roomId });

    // Existing member reconnection succeeds without needing code even after match starts
    const roomPriv = db.getRaw(`rooms/${priv.roomId}`)!;
    roomPriv.status = 'playing';
    db.setRaw(`rooms/${priv.roomId}`, roomPriv);
    const reconn = await executeJoinRoom(deps, 'friend', { name: 'Friend' }, { roomId: priv.roomId });
    expect(reconn).toEqual({ success: true, roomId: priv.roomId, alreadyJoined: true });

    // Public room join with roomId and quickJoin work without secretCode
    const qj = await executeQuickJoinRoom(deps, 'guest', { name: 'Guest' });
    expect(qj).toEqual({ success: true, roomId: pub.roomId });
  });

  it('7. kickPlayer during active match cleans votes, turnOrder/index, privatePlayers, and settles win condition', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db);

    // Scenario A: Kick during VOTING cleans pending vote and triggers remaining tally
    db.setRaw('rooms/rk1', {
      id: 'rk1',
      hostId: 'p1',
      status: 'playing',
      difficulty: 'easy',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3'), makePlayer('p4')],
      kickedPlayers: [],
      gameState: {
        phase: 'VOTING',
        matchId: 'mk1',
        round: 1,
        votedUids: ['p1', 'p2'],
      },
    });
    db.setRaw('rooms/rk1/privatePlayers/p3', { uid: 'p3', role: 'citizen' });
    db.setRaw('rooms/rk1/privateState/current', {
      matchId: 'mk1',
      round: 1,
      civilianWord: 'قمر',
      undercoverWord: 'شمس',
      decoys: [],
      impostorIds: ['p4'],
      undercoverIds: [],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'citizen', p4: 'mrwhite' },
      votesByUid: { p1: 'p4', p2: 'p4', p4: 'p3' },
      settledMatches: [],
    });

    await executeKickPlayer(deps, 'p1', { roomId: 'rk1', targetUid: 'p3' });
    const rk1 = db.getRaw('rooms/rk1')!;
    expect(rk1.playerIds).toEqual(['p1', 'p2', 'p4']);
    expect(rk1.kickedPlayers).toContain('p3');
    expect(db.getRaw('rooms/rk1/privatePlayers/p3')).toBeUndefined();
    // Wait: p4's vote for p3 was purged, p1 & p2 voted for p4 (2/3 alive -> stays VOTING with clean votedUids=['p1','p2'])
    expect(rk1.gameState.votedUids).toEqual(['p1', 'p2']);
    expect(db.getRaw('rooms/rk1/privateState/current')!.votesByUid).toEqual({ p1: 'p4', p2: 'p4' });

    // Scenario B: Kicking last infiltrator triggers win settlement to RESULT
    await executeKickPlayer(deps, 'p1', { roomId: 'rk1', targetUid: 'p4' });
    const settled = db.getRaw('rooms/rk1')!;
    expect(settled.gameState.phase).toBe('RESULT');
    expect(settled.gameState.winner).toBe('citizens');
    expect(settled.gameState.revealedResult.secretWord).toBe('قمر');

    // Scenario C: Kicking speaker in PLAYING adjusts turnOrder & currentTurnIndex accurately
    db.setRaw('rooms/rk2', {
      id: 'rk2',
      hostId: 'p1',
      status: 'playing',
      difficulty: 'easy',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3', 'p4'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3'), makePlayer('p4')],
      kickedPlayers: [],
      gameState: {
        phase: 'PLAYING',
        matchId: 'mk2',
        round: 1,
        turnOrder: ['p1', 'p2', 'p3', 'p4'],
        currentTurnIndex: 1,
        turnEndsAt: 1_700_000_045_000,
        turnsCompleted: false,
      },
    });
    db.setRaw('rooms/rk2/privateState/current', {
      matchId: 'mk2',
      round: 1,
      civilianWord: 'بحر',
      undercoverWord: 'نهر',
      decoys: [],
      impostorIds: ['p4'],
      undercoverIds: [],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'citizen', p4: 'mrwhite' },
      votesByUid: {},
      settledMatches: [],
    });

    await executeKickPlayer(deps, 'p1', { roomId: 'rk2', targetUid: 'p2' });
    const rk2 = db.getRaw('rooms/rk2')!;
    expect(rk2.gameState.turnOrder).toEqual(['p1', 'p3', 'p4']);
    expect(rk2.gameState.turnOrder[rk2.gameState.currentTurnIndex]).toBe('p3');
  });

  it('8. Non-member advanceTurn rejected even when active speaker absent or timer expired; duplicate calls are idempotent', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db, 1_700_000_100_000);

    db.setRaw('rooms/rt1', {
      id: 'rt1',
      hostId: 'p1',
      status: 'playing',
      turnDurationSeconds: 45,
      playerIds: ['p1', 'p2', 'p3'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3')],
      gameState: {
        phase: 'PLAYING',
        round: 1,
        turnOrder: ['missing_uid', 'p2', 'p3'],
        currentTurnIndex: 0,
        turnEndsAt: 1_700_000_010_000, // already expired
        turnsCompleted: false,
        clues: [],
      },
    });

    // Non-member rejected even with absent active speaker and expired timer
    await expect(
      executeAdvanceTurn(deps, 'outsider', { roomId: 'rt1', reason: 'timeout', expectedTurnIndex: 0 })
    ).rejects.toThrow(/Only room members/i);

    // Host advances turn index 0 -> 1
    await executeAdvanceTurn(deps, 'p1', {
      roomId: 'rt1',
      reason: 'skip',
      expectedTurnIndex: 0,
    });
    expect(db.getRaw('rooms/rt1')!.gameState.currentTurnIndex).toBe(1);

    // Duplicate concurrent advanceTurn with stale expectedTurnIndex=0 does NOT advance index 1 -> 2
    await executeAdvanceTurn(deps, 'p2', {
      roomId: 'rt1',
      reason: 'skip',
      expectedTurnIndex: 0,
    });
    expect(db.getRaw('rooms/rt1')!.gameState.currentTurnIndex).toBe(1);
  });

  it('9. Duplicate submitVote and duplicate startVoting/resolveVotes are strictly blocked', async () => {
    const db = new InMemoryFirestore();
    const deps = createDeps(db);

    db.setRaw('rooms/rv1', {
      id: 'rv1',
      hostId: 'p1',
      status: 'playing',
      playerIds: ['p1', 'p2', 'p3'],
      players: [makePlayer('p1'), makePlayer('p2'), makePlayer('p3')],
      gameState: {
        phase: 'PLAYING',
        round: 1,
        turnOrder: ['p1', 'p2', 'p3'],
        currentTurnIndex: 0,
      },
    });
    db.setRaw('rooms/rv1/privateState/current', {
      matchId: 'mv1',
      round: 1,
      civilianWord: 'كتاب',
      undercoverWord: 'دفتر',
      decoys: [],
      impostorIds: ['p3'],
      undercoverIds: [],
      rolesByUid: { p1: 'citizen', p2: 'citizen', p3: 'mrwhite' },
      votesByUid: {},
      settledMatches: [],
    });

    await executeStartVoting(deps, 'p1', { roomId: 'rv1' });
    await expect(executeStartVoting(deps, 'p1', { roomId: 'rv1' })).rejects.toThrow();

    await executeSubmitVote(deps, 'p1', { roomId: 'rv1', suspectUid: 'p3' });
    // Duplicate vote from same player blocked
    await expect(
      executeSubmitVote(deps, 'p1', { roomId: 'rv1', suspectUid: 'p2' })
    ).rejects.toThrow(/already voted/i);

    await executeResolveVotes(deps, 'p1', { roomId: 'rv1' });
    // Duplicate resolveVotes blocked after phase transitioned to REVEAL_VOTE_RESULT
    await expect(executeResolveVotes(deps, 'p1', { roomId: 'rv1' })).rejects.toThrow();
  });

  it('10 & 11. Backfills missing publicProfiles from existing users/{uid} without zeroing stats & preserves local Special Roles', () => {
    const existingUser = {
      displayName: 'Veteran',
      photoURL: 'https://example.com/a.png',
      xp: 480,
      level: 5,
      stats: {
        wins: 14,
        hosted: 6,
        played: 22,
        longestStreak: 4,
        currentStreak: 2,
        roleStats: {
          mrwhite: { played: 5, wins: 3 },
          citizen: { played: 12, wins: 9 },
        },
      },
    };

    const synced = buildPublicProfileBackfill('vet_1', existingUser);
    expect(synced.xp).toBe(480);
    expect(synced.level).toBe(5);
    expect(synced.stats).toEqual(existingUser.stats);

    // Local Pass & Play Special Roles remain preserved
    expect(SPECIAL_ROLES.length).toBeGreaterThanOrEqual(8);
  });
});
