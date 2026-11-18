import React, { useState, useEffect, useRef, useMemo } from 'react';
import { doc, onSnapshot, updateDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../contexts/AuthContext';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { leaveOnlineRoom } from '../utils/onlineRoomService';
import { RevealVoteResult } from './RevealVoteResult';
import { ImpostorGuessScreen } from './ImpostorGuessScreen';
import { ResultScreen } from './ResultScreen';
import { ChatBox } from './ChatBox';
import { Avatar } from './Avatar';
import { PlayerStatsModal } from './PlayerStatsModal';
import { getRandomWordPair } from '../services/geminiService';
import { getPlayerRoundPoints } from '../services/gameScoring';
import { getRoleAsset } from '../data/specialRoles';
import { playSound } from '../services/soundService';
import { Player } from '../types';
import {
  MessageCircle,
  XCircle,
  Play,
  Eye,
  EyeOff,
  LogOut,
  Clock,
  Send,
  SkipForward,
  Check,
  ShieldAlert,
  Crown,
  Vote,
} from 'lucide-react';
import { getUITranslation } from '../translations';
import { getSettings } from '../services/storageService';
import { showToast } from '../utils/toast';
import { calculateLevelFromXp } from '../utils/levelUtils';

interface OnlineClue {
  id: string;
  uid: string;
  name: string;
  avatar: string;
  text: string;
  round: number;
  skipped?: boolean;
}

interface OnlineGameScreenProps {
  roomId: string;
  onBack: () => void;
  onReturnToLobby?: () => void;
}

export const OnlineGameScreen: React.FC<OnlineGameScreenProps> = ({
  roomId,
  onBack,
  onReturnToLobby,
}) => {
  const { user, profile } = useAuth();
  const [room, setRoom] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [hasUpdatedProfile, setHasUpdatedProfile] = useState(false);
  const [selectedPlayerForStats, setSelectedPlayerForStats] = useState<any>(null);
  const [showWordPeek, setShowWordPeek] = useState(false);
  const [peekRevealed, setPeekRevealed] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [clueInput, setClueInput] = useState('');
  const [submittingClue, setSubmittingClue] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const isLeavingRef = useRef(false);
  const prevHostIdRef = useRef<string | null>(null);
  const lastAutoAdvancedTurnRef = useRef<string | null>(null);
  const cluesEndRef = useRef<HTMLDivElement>(null);

  const settings = getSettings();
  const isRTL = ['ar', 'sa'].includes(settings.language);
  const t = (key: string, params?: Record<string, any>) => {
    let text = getUITranslation(settings.language, key);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        text = text.replace(`{${k}}`, String(v));
      });
    }
    return text;
  };

  useEffect(() => {
    if (!roomId || !user) return;
    const roomRef = doc(db, 'rooms', roomId);
    const unsubscribe = onSnapshot(
      roomRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (
            prevHostIdRef.current &&
            prevHostIdRef.current !== data.hostId &&
            data.hostId === user.uid
          ) {
            showToast(t('hostPromoted'), 'info');
          }
          prevHostIdRef.current = data.hostId;
          setRoom(data);

          if (data.status === 'waiting' && onReturnToLobby && !isLeavingRef.current) {
            onReturnToLobby();
          }
        } else {
          if (!isLeavingRef.current) {
            showToast(t('roomClosed'), 'warning');
            onBack();
          }
        }
      },
      (err) => {
        handleFirestoreError(err, OperationType.GET, `rooms/${roomId}`);
      }
    );
    return () => unsubscribe();
  }, [roomId, user, onBack, onReturnToLobby]);

  // Handle Offline with Host Migration
  useEffect(() => {
    const handleOffline = async () => {
      if (isLeavingRef.current) return;
      showToast(t('lostConnectionGame'), 'error');

      if (room && user) {
        isLeavingRef.current = true;
        try {
          await leaveOnlineRoom(roomId, user.uid);
        } catch (e) {
          console.error('Offline leave error', e);
        }
      }
      onBack();
    };

    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, [room, user, roomId, onBack]);

  const isHost = room?.hostId === user?.uid;
  const gameState = room?.gameState || {};
  const phase: string = gameState.phase || 'SETUP_PENDING';
  const difficulty: 'easy' | 'hard' = gameState.difficulty || room?.difficulty || 'easy';
  const currentRound: number = gameState.round || 1;
  const turnDurationSeconds: number = room?.turnDurationSeconds || 45;

  const players: Player[] = useMemo(
    () =>
      (room?.players || []).map((p: any, index: number) => ({
        id: index,
        uid: p.uid,
        name: p.name,
        role: p.role || (p.uid === gameState.impostorId ? 'mrwhite' : 'citizen'),
        isImpostor:
          p.role === 'mrwhite' || p.role === 'undercover' || p.uid === gameState.impostorId,
        isEliminated: Boolean(p.isEliminated),
        score: p.score || 0,
        avatar: p.avatar,
      })),
    [room?.players, gameState.impostorId]
  );

  const alivePlayers = useMemo(() => players.filter((p) => !p.isEliminated), [players]);
  const turnOrder: string[] = Array.isArray(gameState.turnOrder) ? gameState.turnOrder : [];
  const currentTurnIndex: number = gameState.currentTurnIndex || 0;
  const turnsCompleted: boolean = Boolean(gameState.turnsCompleted);
  const clues: OnlineClue[] = Array.isArray(gameState.clues) ? gameState.clues : [];
  const activeSpeakerUid: string | null = !turnsCompleted
    ? turnOrder[currentTurnIndex] || null
    : null;

  // Live clock tick for synced turn timer
  useEffect(() => {
    if (phase !== 'PLAYING' || turnsCompleted || !gameState.turnEndsAt) return;
    setNowMs(Date.now());
    const interval = setInterval(() => {
      setNowMs(Date.now());
    }, 500);
    return () => clearInterval(interval);
  }, [phase, turnsCompleted, gameState.turnEndsAt]);

  useEffect(() => {
    if (phase === 'PLAYING' && cluesEndRef.current) {
      cluesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [clues.length, phase]);

  const timeLeftSeconds =
    phase === 'PLAYING' && !turnsCompleted && gameState.turnEndsAt
      ? Math.max(0, Math.ceil((gameState.turnEndsAt - nowMs) / 1000))
      : 0;

  const buildTurnOrder = (playersList: any[], roundNum: number): string[] => {
    const alive = playersList.filter((p) => !p.isEliminated);
    const shuffled = [...alive].sort(() => 0.5 - Math.random());
    if (roundNum === 1 && shuffled.length > 1 && shuffled[0].role === 'mrwhite') {
      const nonWhiteIdx = shuffled.findIndex((p) => p.role !== 'mrwhite');
      if (nonWhiteIdx > 0) {
        const tmp = shuffled[0];
        shuffled[0] = shuffled[nonWhiteIdx];
        shuffled[nonWhiteIdx] = tmp;
      }
    }
    return shuffled.map((p) => p.uid);
  };

  const updateGameState = async (updates: any) => {
    if (!room) return;
    try {
      const roomRef = doc(db, 'rooms', roomId);
      await updateDoc(roomRef, {
        gameState: { ...gameState, ...updates },
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const advanceTurn = async (extraClue?: OnlineClue) => {
    if (!room || phase !== 'PLAYING') return;
    const aliveSet = new Set(alivePlayers.map((p) => p.uid));
    let nextIdx = currentTurnIndex + 1;
    while (nextIdx < turnOrder.length && !aliveSet.has(turnOrder[nextIdx])) {
      nextIdx += 1;
    }

    const updatedClues = extraClue ? [...clues, extraClue].slice(-80) : clues;

    if (nextIdx >= turnOrder.length) {
      await updateGameState({
        clues: updatedClues,
        turnsCompleted: true,
        turnEndsAt: null,
      });
    } else {
      await updateGameState({
        clues: updatedClues,
        currentTurnIndex: nextIdx,
        turnEndsAt: Date.now() + turnDurationSeconds * 1000,
        turnsCompleted: false,
      });
    }
  };

  // Auto-advance if turn timer hits 0 OR active speaker left/was eliminated
  useEffect(() => {
    if (!room || !user || phase !== 'PLAYING' || turnsCompleted || turnOrder.length === 0) return;

    const aliveSet = new Set(alivePlayers.map((p) => p.uid));
    const currentSpeakerAlive = activeSpeakerUid ? aliveSet.has(activeSpeakerUid) : false;
    const turnKey = `${currentRound}-${currentTurnIndex}`;

    if (!currentSpeakerAlive && isHost) {
      if (lastAutoAdvancedTurnRef.current !== turnKey) {
        lastAutoAdvancedTurnRef.current = turnKey;
        advanceTurn();
      }
      return;
    }

    if (
      gameState.turnEndsAt &&
      timeLeftSeconds <= 0 &&
      (isHost || activeSpeakerUid === user.uid)
    ) {
      if (lastAutoAdvancedTurnRef.current !== turnKey) {
        lastAutoAdvancedTurnRef.current = turnKey;
        const speaker = players.find((p) => p.uid === activeSpeakerUid);
        advanceTurn(
          speaker
            ? {
                id: `${Date.now()}-skip`,
                uid: speaker.uid || '',
                name: speaker.name,
                avatar: speaker.avatar,
                text: isRTL ? '(انتهى الوقت)' : '(Timed out)',
                round: currentRound,
                skipped: true,
              }
            : undefined
        );
      }
    }
  }, [
    phase,
    turnsCompleted,
    timeLeftSeconds,
    activeSpeakerUid,
    alivePlayers,
    isHost,
    user,
    currentRound,
    currentTurnIndex,
    gameState.turnEndsAt,
    turnOrder.length,
  ]);

  const computePlayerOnlineXp = (
    targetPlayer: any,
    allPlayers: any[],
    winner: 'impostor' | 'citizens',
    reason: string,
    winningMrWhiteUid?: string | null
  ) => {
    const mapped: Player[] = allPlayers.map((p: any, idx: number) => ({
      id: idx,
      uid: p.uid,
      name: p.name,
      role: p.role || (p.uid === gameState.impostorId ? 'mrwhite' : 'citizen'),
      isImpostor:
        p.role === 'mrwhite' || p.role === 'undercover' || p.uid === gameState.impostorId,
      isEliminated: Boolean(p.isEliminated),
      score: p.score || 0,
      avatar: p.avatar,
    }));

    const selfMapped = mapped.find((p) => p.uid === targetPlayer.uid);
    if (!selfMapped) return { xpDelta: 0, isWinner: false };

    const winningMrWhiteId = winningMrWhiteUid
      ? (mapped.find((p) => p.uid === winningMrWhiteUid)?.id ?? null)
      : gameState.winningMrWhiteUid
      ? (mapped.find((p) => p.uid === gameState.winningMrWhiteUid)?.id ?? null)
      : null;

    const roundPoints = getPlayerRoundPoints(
      selfMapped,
      mapped,
      winner,
      reason,
      winningMrWhiteId
    );

    let xpDelta = roundPoints * 10;
    const isBadGuy = selfMapped.role === 'mrwhite' || selfMapped.role === 'undercover';
    if (!isBadGuy) {
      const myVote = gameState.votes?.[targetPlayer.uid];
      const badGuyUids = new Set(
        mapped
          .filter((p) => p.role === 'mrwhite' || p.role === 'undercover')
          .map((p) => p.uid)
          .filter(Boolean)
      );
      if (myVote && badGuyUids.has(myVote)) {
        xpDelta += 20;
      }
    }

    return { xpDelta, isWinner: roundPoints > 0 };
  };

  const calculateAndApplyScores = async (
    winner: 'impostor' | 'citizens',
    reason: string,
    sourcePlayers?: any[],
    winningMrWhiteUid?: string | null
  ) => {
    if (!room) return;
    const basePlayers = sourcePlayers || room.players;
    const updatedPlayers = basePlayers.map((p: any) => {
      const { xpDelta } = computePlayerOnlineXp(p, basePlayers, winner, reason, winningMrWhiteUid);
      return {
        ...p,
        score: (p.score || 0) + xpDelta,
      };
    });

    try {
      const roomRef = doc(db, 'rooms', roomId);
      await updateDoc(roomRef, {
        players: updatedPlayers,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const eliminatePlayerAndCheckWinOnline = async (eliminatedUid: string) => {
    if (!room) return;
    const updatedPlayers = room.players.map((p: any) =>
      p.uid === eliminatedUid ? { ...p, isEliminated: true } : p
    );

    const aliveCitizens = updatedPlayers.filter(
      (p: any) => !p.isEliminated && p.role !== 'mrwhite' && p.role !== 'undercover'
    ).length;
    const aliveBadGuys = updatedPlayers.filter(
      (p: any) => !p.isEliminated && (p.role === 'mrwhite' || p.role === 'undercover')
    ).length;

    try {
      await updateDoc(doc(db, 'rooms', roomId), { players: updatedPlayers });

      if (aliveBadGuys === 0) {
        await calculateAndApplyScores('citizens', 'impostor_caught', updatedPlayers);
        await updateGameState({
          phase: 'RESULT',
          winReason: 'impostor_caught',
          winner: 'citizens',
        });
      } else if (aliveBadGuys >= aliveCitizens || aliveCitizens <= 1) {
        await calculateAndApplyScores('impostor', 'citizens_wrong_vote', updatedPlayers);
        await updateGameState({
          phase: 'RESULT',
          winReason: 'citizens_wrong_vote',
          winner: 'impostor',
        });
      } else {
        const nextRound = currentRound + 1;
        const nextTurnOrder = buildTurnOrder(updatedPlayers, nextRound);
        await updateGameState({
          phase: 'PLAYING',
          round: nextRound,
          turnOrder: nextTurnOrder,
          currentTurnIndex: 0,
          turnEndsAt: Date.now() + turnDurationSeconds * 1000,
          turnsCompleted: false,
          votes: {},
          mostVotedId: null,
          tieBroken: false,
        });
      }
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const resolveVotesAndAdvance = async (votesMap: Record<string, string>) => {
    if (!room) return;
    const aliveSet = new Set(alivePlayers.map((p) => p.uid));
    const counts: Record<string, number> = {};
    Object.entries(votesMap).forEach(([voterUid, suspectUid]) => {
      if (aliveSet.has(voterUid) && aliveSet.has(suspectUid)) {
        counts[suspectUid] = (counts[suspectUid] || 0) + 1;
      }
    });

    let maxVotes = 0;
    let candidates: string[] = [];
    Object.entries(counts).forEach(([uid, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        candidates = [uid];
      } else if (count === maxVotes) {
        candidates.push(uid);
      }
    });

    if (candidates.length === 0) return;

    const tieBroken = candidates.length > 1;
    const mostVotedId = tieBroken
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : candidates[0];

    await updateGameState({
      phase: 'REVEAL_VOTE_RESULT',
      mostVotedId,
      tieBroken,
    });
  };

  // Host transitions REVEAL -> PLAYING when all players mark ready
  useEffect(() => {
    if (
      isHost &&
      phase === 'REVEAL' &&
      gameState.readyPlayers?.length >= players.length &&
      players.length > 0
    ) {
      const nextTurnOrder = buildTurnOrder(room?.players || [], 1);
      updateGameState({
        phase: 'PLAYING',
        round: 1,
        turnOrder: nextTurnOrder,
        currentTurnIndex: 0,
        turnEndsAt: Date.now() + turnDurationSeconds * 1000,
        turnsCompleted: false,
        clues: [],
        readyPlayers: [],
        tieBroken: false,
      });
    }
  }, [gameState.readyPlayers, phase, isHost, players.length]);

  // Host transitions VOTING -> REVEAL_VOTE_RESULT when all alive players voted
  useEffect(() => {
    if (isHost && phase === 'VOTING' && gameState.votes) {
      const aliveUids = new Set(alivePlayers.map((p) => p.uid));
      const validVotesCount = Object.keys(gameState.votes).filter((uid) =>
        aliveUids.has(uid)
      ).length;
      if (validVotesCount === alivePlayers.length && alivePlayers.length > 0) {
        resolveVotesAndAdvance(gameState.votes);
      }
    }
  }, [gameState.votes, phase, isHost, alivePlayers.length]);

  // Update personal Firebase profile stats on RESULT
  useEffect(() => {
    if (phase === 'RESULT' && !hasUpdatedProfile && user && profile && room?.players) {
      const updateProfileStats = async () => {
        setHasUpdatedProfile(true);
        const selfRaw = room.players.find((p: any) => p.uid === user.uid);
        if (!selfRaw) return;

        const winner = gameState.winner as 'impostor' | 'citizens';
        const reason = gameState.winReason as string;
        const { xpDelta, isWinner } = computePlayerOnlineXp(
          selfRaw,
          room.players,
          winner,
          reason,
          gameState.winningMrWhiteUid
        );

        const userRef = doc(db, 'users', user.uid);
        const newXp = (profile.xp || 0) + xpDelta;
        const newLevel = calculateLevelFromXp(newXp);

        const newStats = {
          ...profile.stats,
          played: (profile.stats?.played || 0) + 1,
          wins: (profile.stats?.wins || 0) + (isWinner ? 1 : 0),
        };

        try {
          await updateDoc(userRef, {
            xp: newXp,
            level: newLevel,
            stats: newStats,
          });
        } catch (err) {
          console.error('Failed to update profile stats', err);
        }
      };

      updateProfileStats();
    } else if (phase !== 'RESULT') {
      setHasUpdatedProfile(false);
    }
  }, [
    phase,
    gameState.winner,
    gameState.winReason,
    gameState.winningMrWhiteUid,
    gameState.impostorId,
    gameState.votes,
    room?.players,
    user,
    profile,
    hasUpdatedProfile,
  ]);

  if (!room || !user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center bg-bg-dark">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary"></div>
      </div>
    );
  }

  const handleLeaveConfirmed = async () => {
    if (isLeavingRef.current) return;
    isLeavingRef.current = true;
    setShowLeaveConfirm(false);
    try {
      await leaveOnlineRoom(roomId, user.uid);
    } catch (err) {
      console.error('Leave room failed', err);
    } finally {
      onBack();
    }
  };

  const handleStartRound = async () => {
    if (!isHost) return;
    setIsLoading(true);
    setError(null);

    try {
      const category = room.category || 'standard';
      const roomDifficulty: 'easy' | 'hard' = room.difficulty || 'easy';
      const { civilianWord, undercoverWord, decoys } = await getRandomWordPair(
        room.language,
        category
      );

      const playersList = [...room.players];
      const numPlayers = playersList.length;
      const numUndercover = numPlayers >= 8 ? 2 : numPlayers >= 5 ? 1 : 0;

      const shuffledPlayers = [...playersList].sort(() => 0.5 - Math.random());
      const updatedPlayers = playersList.map((p: any) => ({
        ...p,
        role: 'citizen',
        isEliminated: false,
      }));

      // Assign Mr White
      const mrWhitePlayer = shuffledPlayers[0];
      const mrWhiteIndex = updatedPlayers.findIndex((p) => p.uid === mrWhitePlayer.uid);
      updatedPlayers[mrWhiteIndex].role = 'mrwhite';

      // Assign Undercover(s)
      const undercoverIds: string[] = [];
      for (let i = 1; i <= numUndercover && i < shuffledPlayers.length; i++) {
        const ucPlayer = shuffledPlayers[i];
        const ucIndex = updatedPlayers.findIndex((p) => p.uid === ucPlayer.uid);
        if (ucIndex !== -1) {
          updatedPlayers[ucIndex].role = 'undercover';
          undercoverIds.push(ucPlayer.uid);
        }
      }

      const roomRef = doc(db, 'rooms', roomId);
      await updateDoc(roomRef, {
        players: updatedPlayers,
      });

      await updateGameState({
        phase: 'REVEAL',
        round: 1,
        category,
        difficulty: roomDifficulty,
        secretWord: civilianWord,
        undercoverWord,
        relatedWords: decoys,
        impostorId: mrWhitePlayer.uid,
        undercoverId: undercoverIds[0] || null,
        undercoverIds,
        winningMrWhiteUid: null,
        readyPlayers: [],
        clues: [],
        turnOrder: [],
        currentTurnIndex: 0,
        turnsCompleted: false,
        votes: {},
        mostVotedId: null,
        tieBroken: false,
      });
    } catch (err) {
      console.error(err);
      setError(t('errorLoadingWords'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleRevealComplete = async () => {
    try {
      playSound('click');
      const roomRef = doc(db, 'rooms', roomId);
      await updateDoc(roomRef, {
        'gameState.readyPlayers': arrayUnion(user.uid),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const handleSubmitClue = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = clueInput.trim();
    if (!trimmed || submittingClue || activeSpeakerUid !== user.uid) return;
    const me = players.find((p) => p.uid === user.uid);
    if (!me || me.isEliminated) return;

    setSubmittingClue(true);
    try {
      playSound('pop');
      setClueInput('');
      await advanceTurn({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        uid: user.uid,
        name: me.name,
        avatar: me.avatar,
        text: trimmed.slice(0, 80),
        round: currentRound,
      });
    } finally {
      setSubmittingClue(false);
    }
  };

  const handleManualSkipTurn = async () => {
    if (!activeSpeakerUid || (!isHost && activeSpeakerUid !== user.uid)) return;
    const speaker = players.find((p) => p.uid === activeSpeakerUid);
    playSound('click');
    await advanceTurn(
      speaker
        ? {
            id: `${Date.now()}-skip`,
            uid: speaker.uid || '',
            name: speaker.name,
            avatar: speaker.avatar,
            text: isRTL ? '(تم التخطي)' : '(Skipped)',
            round: currentRound,
            skipped: true,
          }
        : undefined
    );
  };

  const handleTimeUp = () => {
    if (isHost) {
      playSound('vote');
      updateGameState({ phase: 'VOTING', votes: {}, readyPlayers: [], tieBroken: false });
    }
  };

  const handleVote = async (suspectUid: string) => {
    try {
      playSound('vote');
      const roomRef = doc(db, 'rooms', roomId);
      await updateDoc(roomRef, {
        [`gameState.votes.${user.uid}`]: suspectUid,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const handleBackToLobbyFromResult = async () => {
    if (!isHost || !room) return;
    try {
      const resetPlayers = (room.players || []).map((p: any) => ({
        ...p,
        isReady: false,
        isEliminated: false,
        role: 'citizen',
      }));
      await updateDoc(doc(db, 'rooms', roomId), {
        status: 'waiting',
        players: resetPlayers,
        gameState: {},
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `rooms/${roomId}`);
    }
  };

  const currentPlayer = players.find((p) => p.uid === user.uid);
  const aliveMrWhites = alivePlayers.filter((p) => p.role === 'mrwhite').length;
  const aliveUndercovers = alivePlayers.filter((p) => p.role === 'undercover').length;
  const totalAliveInfiltrators = aliveMrWhites + aliveUndercovers;
  const showMatchHud = ['PLAYING', 'VOTING', 'REVEAL_VOTE_RESULT'].includes(phase);

  const renderWordCardInner = (playerObj?: Player) => {
    const isBlindHardCard =
      difficulty === 'hard' &&
      (playerObj?.role === 'citizen' || playerObj?.role === 'undercover');

    if (playerObj?.role === 'mrwhite') {
      return (
        <div className="text-danger flex flex-col items-center">
          <img
            src={getRoleAsset('mrwhite')}
            alt="Mr. White"
            referrerPolicy="no-referrer"
            className="w-20 h-20 object-contain mb-3"
          />
          <span className="text-3xl sm:text-4xl font-black block mb-2">{t('mrWhiteRole')}</span>
          <p className="text-sm font-bold text-text-muted">{t('tryToGuessWord')}</p>
        </div>
      );
    }

    if (isBlindHardCard) {
      return (
        <div className="text-sky-400 flex flex-col items-center">
          <div className="flex items-center justify-center gap-2 text-base font-black mb-3">
            <EyeOff size={20} />
            <span>{isRTL ? 'دورك مخفي (وضع صعب)' : 'Role Hidden (Hard Mode)'}</span>
          </div>
          <p className="text-sm font-bold mb-2 text-text-muted">{t('secretWordIs')}</p>
          <div className="bg-bg-dark py-3 px-6 rounded-xl border border-sky-400/30 inline-block">
            <span className="text-3xl font-black text-text-main">
              {playerObj?.role === 'undercover'
                ? gameState.undercoverWord
                : gameState.secretWord}
            </span>
          </div>
        </div>
      );
    }

    if (playerObj?.role === 'undercover') {
      return (
        <div className="text-orange-400 flex flex-col items-center">
          <img
            src={getRoleAsset('undercover')}
            alt="Undercover"
            referrerPolicy="no-referrer"
            className="w-20 h-20 object-contain mb-3"
          />
          <span className="text-3xl sm:text-4xl font-black block mb-3">{t('undercoverRole')}</span>
          <p className="text-sm font-bold mb-2 text-text-muted">{t('secretWordIs')}</p>
          <div className="bg-bg-dark py-3 px-6 rounded-xl border border-orange-500/30 inline-block">
            <span className="text-3xl font-black text-white">{gameState.undercoverWord}</span>
          </div>
        </div>
      );
    }

    return (
      <div className="text-primary flex flex-col items-center">
        <img
          src={getRoleAsset('citizen')}
          alt="Citizen"
          referrerPolicy="no-referrer"
          className="w-20 h-20 object-contain mb-3"
        />
        <span className="text-3xl sm:text-4xl font-black block mb-3">{t('citizenRole')}</span>
        <p className="text-sm font-bold mb-2 text-text-muted">{t('secretWordIs')}</p>
        <div className="bg-bg-dark py-3 px-6 rounded-xl border border-primary/30 inline-block">
          <span className="text-3xl font-black text-white">{gameState.secretWord}</span>
        </div>
      </div>
    );
  };

  const renderPhase = () => {
    if (phase === 'SETUP_PENDING' || phase === 'CATEGORY_SELECT') {
      const scaledUndercover = players.length >= 8 ? 2 : players.length >= 5 ? 1 : 0;
      const scaledCitizens = Math.max(1, players.length - 1 - scaledUndercover);

      if (isHost) {
        return (
          <div className="flex flex-col items-center justify-center flex-1 text-center p-6 max-w-md mx-auto w-full">
            <div className="w-20 h-20 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center mb-4">
              <Play className="w-9 h-9 text-primary" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-black mb-3 text-primary">
              {t('readyToStartRound')}
            </h2>

            <div className="card-modern p-4 w-full mb-6 text-xs font-bold text-text-muted space-y-2">
              <div className="flex items-center justify-between">
                <span>{t('playersLabel')}</span>
                <span className="text-text-main font-black tabular-nums">{players.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t('difficulty')}</span>
                <span className={difficulty === 'hard' ? 'text-rose-400 font-black' : 'text-sky-400 font-black'}>
                  {difficulty === 'hard' ? t('difficultyHard') : t('difficultyEasy')}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>{t('roleDistribution')}</span>
                <span className="text-text-main font-black tabular-nums">
                  {scaledCitizens} {t('citizen')} · {scaledUndercover} {t('undercover')} · 1 {t('mrWhite')}
                </span>
              </div>
            </div>

            <button
              onClick={handleStartRound}
              disabled={isLoading || players.length < 3}
              className="btn-modern w-full min-h-[54px] py-4 rounded-2xl font-black text-lg flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {isLoading ? (
                <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-white"></div>
              ) : (
                <>
                  <Play size={22} />
                  <span>{t('startRound')}</span>
                </>
              )}
            </button>
            {error && <p className="text-danger mt-4 text-sm font-bold">{error}</p>}
          </div>
        );
      }

      return (
        <div className="flex flex-col items-center justify-center flex-1 text-center p-6">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-primary mb-4"></div>
          <h2 className="text-2xl font-black text-primary">{t('waitingForHost')}</h2>
          <p className="text-text-muted mt-2 font-bold">{t('hostPreparingRound')}</p>
        </div>
      );
    }

    if (phase === 'REVEAL') {
      const readyCount = gameState.readyPlayers?.length || 0;
      const isReady = gameState.readyPlayers?.includes(user.uid);

      return (
        <div className="flex flex-col items-center justify-center flex-1 text-center p-5 max-w-md mx-auto w-full">
          <h2 className="text-2xl sm:text-3xl font-black mb-5 text-primary">{t('yourTurn')}</h2>
          <div className="card-modern p-7 w-full">
            <h3 className="text-lg font-bold text-text-muted mb-4">{t('youAreLabel')}</h3>
            {renderWordCardInner(currentPlayer)}
          </div>

          {!isReady ? (
            <button
              onClick={handleRevealComplete}
              className="btn-modern mt-6 w-full min-h-[54px] py-4 rounded-2xl font-black text-lg"
            >
              {t('iUnderstandReady')}
            </button>
          ) : (
            <div className="mt-6 flex flex-col items-center gap-1">
              <p className="text-emerald-400 font-black text-sm">{t('waitingForOtherPlayers')}</p>
              <span className="text-xs font-black text-text-muted tabular-nums">
                {readyCount} / {players.length}
              </span>
            </div>
          )}
        </div>
      );
    }

    if (phase === 'PLAYING') {
      const activeSpeaker = players.find((p) => p.uid === activeSpeakerUid);
      const isMyTurn = activeSpeakerUid === user.uid && !currentPlayer?.isEliminated && !turnsCompleted;
      const roundClues = clues.filter((c) => c.round === currentRound);
      const spokenThisRoundUids = new Set(roundClues.map((c) => c.uid));

      return (
        <div className="flex flex-col flex-1 w-full max-w-3xl mx-auto px-4 pb-24 pt-2 gap-4">
          {currentPlayer?.isEliminated && (
            <div className="px-4 py-2.5 rounded-2xl bg-rose-500/15 border border-rose-400/35 text-rose-200 text-xs font-black flex items-center gap-2">
              <ShieldAlert size={16} className="shrink-0" />
              <span>{t('spectatorModeNote')}</span>
            </div>
          )}

          {/* Active Turn Spotlight */}
          {!turnsCompleted && activeSpeaker ? (
            <div
              className={`card-modern p-4 border ${
                isMyTurn
                  ? 'border-emerald-400/60 bg-emerald-500/10'
                  : 'border-primary/40 bg-primary/5'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <Avatar avatar={activeSpeaker.avatar} name={activeSpeaker.name} size={48} />
                  <div className="min-w-0 text-start">
                    <p className="text-[11px] font-black text-text-muted uppercase tracking-wider">
                      {t('currentSpeaker')}
                    </p>
                    <p className="text-lg font-black text-text-main truncate">
                      {activeSpeaker.name}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <div
                    className={`px-3 py-1.5 rounded-xl font-black text-sm tabular-nums flex items-center gap-1.5 border ${
                      timeLeftSeconds <= 10
                        ? 'bg-rose-500/20 text-rose-300 border-rose-400/50'
                        : 'bg-bg-dark text-amber-300 border-white/10'
                    }`}
                  >
                    <Clock size={14} />
                    <span>
                      {timeLeftSeconds}
                      {t('secondsShort')}
                    </span>
                  </div>
                  {(isHost || isMyTurn) && (
                    <button
                      onClick={handleManualSkipTurn}
                      className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl bg-white/5 hover:bg-white/15 text-text-muted hover:text-white border border-white/10 flex items-center justify-center gap-1 text-xs font-black"
                      title={t('skipTurn')}
                      aria-label={t('skipTurn')}
                    >
                      <SkipForward size={15} />
                    </button>
                  )}
                </div>
              </div>

              {isMyTurn && (
                <form onSubmit={handleSubmitClue} className="mt-3 pt-3 border-t border-white/10">
                  <p className="text-xs font-black text-emerald-300 mb-2 text-start">
                    {t('yourTurnWriteClue')}
                  </p>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={clueInput}
                      maxLength={80}
                      onChange={(e) => setClueInput(e.target.value)}
                      placeholder={t('cluePlaceholder')}
                      className="flex-1 bg-bg-dark border border-emerald-400/40 rounded-xl px-4 py-3 text-sm font-bold text-white outline-none focus:border-emerald-400"
                      autoFocus
                    />
                    <button
                      type="submit"
                      disabled={!clueInput.trim() || submittingClue}
                      className="min-h-[44px] px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm flex items-center gap-1.5 disabled:opacity-40 shrink-0"
                    >
                      <Send size={16} />
                      <span>{t('sendClue')}</span>
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : (
            <div className="card-modern p-4 border border-amber-400/40 bg-amber-500/10 text-center">
              <p className="text-sm font-black text-amber-200">{t('allTurnsFinished')}</p>
            </div>
          )}

          {/* Clues Feed & Players Grid (Responsive 2 cols on lg) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            {/* Clues History Feed */}
            <div className="card-modern p-4 flex flex-col max-h-64 overflow-y-auto custom-scrollbar">
              <h3 className="text-xs font-black text-text-muted uppercase tracking-wider mb-3 text-start">
                {t('cluesFeedTitle')}
              </h3>
              {clues.length === 0 ? (
                <p className="text-xs font-bold text-text-muted/70 py-4 text-center">
                  {t('noCluesYet')}
                </p>
              ) : (
                <div className="space-y-2">
                  {clues.map((clue) => (
                    <div
                      key={clue.id}
                      className="flex items-center justify-between gap-2.5 px-3 py-2 rounded-xl bg-bg-dark/70 border border-white/5"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <Avatar avatar={clue.avatar} name={clue.name} size={28} />
                        <div className="min-w-0 text-start">
                          <span className="text-[11px] font-black text-text-muted block truncate">
                            {clue.name}
                          </span>
                          <span
                            className={`text-sm font-bold break-words ${
                              clue.skipped ? 'text-text-muted italic' : 'text-text-main'
                            }`}
                          >
                            {clue.text}
                          </span>
                        </div>
                      </div>
                      <span className="text-[10px] font-black text-primary/80 px-2 py-0.5 rounded-md bg-primary/10 shrink-0 tabular-nums">
                        R{clue.round}
                      </span>
                    </div>
                  ))}
                  <div ref={cluesEndRef} />
                </div>
              )}
            </div>

            {/* Players Board */}
            <div className="grid grid-cols-2 gap-2.5">
              {players.map((p) => {
                const isSpeaking = p.uid === activeSpeakerUid && !turnsCompleted;
                const hasSpoken = p.uid ? spokenThisRoundUids.has(p.uid) : false;
                return (
                  <button
                    key={p.uid || p.id}
                    onClick={() => setSelectedPlayerForStats(p)}
                    className={`card-modern p-3 flex flex-col items-center transition-all relative ${
                      p.isEliminated
                        ? 'opacity-45 border-danger/40'
                        : isSpeaking
                        ? 'border-amber-400 bg-amber-500/10 ring-2 ring-amber-400/30'
                        : 'hover:bg-primary/10 hover:border-primary'
                    }`}
                  >
                    {p.uid === room.hostId && (
                      <Crown size={13} className="absolute top-2 right-2 text-amber-400" />
                    )}
                    {!p.isEliminated && hasSpoken && (
                      <span className="absolute top-2 left-2 w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                        <Check size={12} />
                      </span>
                    )}
                    <div className="relative">
                      <Avatar avatar={p.avatar} name={p.name} size={50} className="mb-1.5" />
                      {p.isEliminated && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/55 rounded-full">
                          <XCircle size={22} className="text-danger" />
                        </div>
                      )}
                    </div>
                    <span
                      className={`font-black text-xs sm:text-sm truncate max-w-full ${
                        p.isEliminated ? 'line-through text-danger' : ''
                      }`}
                    >
                      {p.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Footer Vote Trigger */}
          <div className="mt-auto pt-2">
            {isHost ? (
              <button
                onClick={handleTimeUp}
                className={`btn-modern w-full min-h-[52px] py-3.5 rounded-[2rem] font-black text-base flex items-center justify-center gap-2 ${
                  turnsCompleted ? '' : 'btn-modern-danger'
                }`}
              >
                <Vote size={20} />
                <span>{t('endAndVote')}</span>
              </button>
            ) : (
              <div className="card-modern p-3.5 bg-primary/5 border-primary/20 text-center">
                <p className="text-primary font-black text-xs sm:text-sm">
                  {t('waitingForHostToStartVote')}
                </p>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (phase === 'VOTING') {
      const votesMap: Record<string, string> = gameState.votes || {};
      const myVote = votesMap[user.uid];
      const hasVoted = !!myVote;
      const isEliminated = currentPlayer?.isEliminated;
      const aliveUids = new Set(alivePlayers.map((p) => p.uid));
      const validVoteCount = Object.keys(votesMap).filter((uid) => aliveUids.has(uid)).length;

      return (
        <div className="flex flex-col items-center flex-1 text-center p-4 pb-24 w-full max-w-2xl mx-auto gap-4">
          <div>
            <h2 className="text-2xl font-black text-danger">{t('votingTime')}</h2>
            <p className="text-xs font-black text-text-muted mt-1 tabular-nums">
              {t('votedCount', { count: validVoteCount, total: alivePlayers.length })}
            </p>
          </div>

          {/* Live Voter Status Pills (non-spoiling) */}
          <div className="flex flex-wrap justify-center gap-1.5">
            {alivePlayers.map((p) => {
              const voted = Boolean(p.uid && votesMap[p.uid]);
              return (
                <div
                  key={p.uid}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-black border flex items-center gap-1.5 ${
                    voted
                      ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                      : 'bg-white/5 border-white/10 text-text-muted'
                  }`}
                >
                  <span>{p.name}</span>
                  <span>{voted ? `✓ ${t('votedStatus')}` : t('decidingStatus')}</span>
                </div>
              );
            })}
          </div>

          {isEliminated ? (
            <div className="card-modern p-6 w-full max-w-md my-auto">
              <h3 className="text-xl font-black text-danger mb-2">{t('youAreEliminated')}</h3>
              <p className="text-sm text-text-muted font-bold">{t('spectatorModeNote')}</p>
            </div>
          ) : !hasVoted ? (
            <>
              <p className="text-sm font-bold text-text-muted">{t('whoIsImpostor')}</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 w-full">
                {alivePlayers
                  .filter((p) => p.uid !== user.uid)
                  .map((p) => (
                    <button
                      key={p.uid}
                      onClick={() => p.uid && handleVote(p.uid)}
                      className="card-modern min-h-[116px] p-3 flex flex-col items-center justify-center hover:bg-danger/15 hover:border-danger active:scale-95 transition-all"
                    >
                      <Avatar avatar={p.avatar} name={p.name} size={56} className="mb-1.5" />
                      <span className="font-black text-sm truncate max-w-full">{p.name}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center my-auto card-modern p-6 w-full max-w-sm">
              <div className="w-16 h-16 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mb-4">
                <Check className="w-8 h-8" strokeWidth={3} />
              </div>
              <h3 className="text-xl font-black mb-1">{t('yourVoteRecorded')}</h3>
              <p className="text-text-muted text-sm font-bold">{t('waitingForOtherPlayers')}</p>
            </div>
          )}

          {isHost && validVoteCount > 0 && validVoteCount < alivePlayers.length && (
            <button
              onClick={() => resolveVotesAndAdvance(votesMap)}
              className="mt-auto px-5 py-3 rounded-2xl bg-amber-500/20 hover:bg-amber-500/30 border border-amber-400/50 text-amber-200 font-black text-xs transition-colors"
            >
              {t('forceEndVote')}
            </button>
          )}
        </div>
      );
    }

    if (phase === 'REVEAL_VOTE_RESULT') {
      const votedPlayer = players.find((p) => p.uid === gameState.mostVotedId);
      return (
        <div className="relative h-full w-full">
          <RevealVoteResult
            votedPlayerId={votedPlayer?.id ?? -1}
            impostorId={players.find((p) => p.uid === gameState.impostorId)?.id ?? -1}
            undercoverId={players.find((p) => p.uid === gameState.undercoverId)?.id ?? null}
            players={players}
            onNext={() => {
              if (!isHost || !gameState.mostVotedId) return;
              if (votedPlayer?.role === 'mrwhite') {
                if (gameState.relatedWords && gameState.relatedWords.length > 0) {
                  updateGameState({ phase: 'IMPOSTOR_GUESS' });
                } else {
                  eliminatePlayerAndCheckWinOnline(gameState.mostVotedId);
                }
              } else {
                eliminatePlayerAndCheckWinOnline(gameState.mostVotedId);
              }
            }}
            voters={players.filter((p) => p.uid && gameState.votes?.[p.uid] === gameState.mostVotedId)}
            isOnline={true}
            isHost={isHost}
            tieBroken={Boolean(gameState.tieBroken)}
          />
        </div>
      );
    }

    if (phase === 'IMPOSTOR_GUESS') {
      const guesserUid = gameState.mostVotedId || gameState.impostorId;
      const isImpostor = guesserUid === user.uid;
      const impostorPlayer = players.find((p) => p.uid === guesserUid);

      if (!impostorPlayer) {
        return (
          <div className="flex flex-col items-center justify-center flex-1 text-center p-6">
            <h2 className="text-xl font-black text-amber-300 mb-4">{t('mrWhiteIsGuessing')}</h2>
            {isHost && (
              <button
                onClick={() => eliminatePlayerAndCheckWinOnline(guesserUid)}
                className="btn-modern px-6 py-3 rounded-2xl font-black"
              >
                {t('ok')}
              </button>
            )}
          </div>
        );
      }

      if (isImpostor) {
        return (
          <ImpostorGuessScreen
            impostor={impostorPlayer}
            secretWord={gameState.secretWord}
            undercoverWord={gameState.undercoverWord}
            relatedWords={gameState.relatedWords}
            onGuess={async (isCorrect) => {
              if (isCorrect) {
                const winReason = 'impostor_guessed';
                const winner = 'impostor';
                await calculateAndApplyScores(winner, winReason, room.players, user.uid);
                await updateGameState({
                  phase: 'RESULT',
                  winReason,
                  winner,
                  winningMrWhiteUid: user.uid,
                });
              } else {
                await eliminatePlayerAndCheckWinOnline(guesserUid);
              }
            }}
          />
        );
      }

      return (
        <div className="flex flex-col items-center justify-center flex-1 text-center p-6">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-danger mb-4"></div>
          <h2 className="text-2xl font-black text-danger">{t('mrWhiteIsGuessing')}</h2>
          <p className="text-text-muted mt-2 font-bold">
            {t('waitingForMrWhiteToChoose', { name: impostorPlayer.name })}
          </p>
        </div>
      );
    }

    if (phase === 'RESULT') {
      const mappedVotes: Record<number, number> = {};
      Object.entries(gameState.votes || {}).forEach(([voterUid, votedUid]) => {
        const voterId = players.find((p) => p.uid === voterUid)?.id;
        const votedId = players.find((p) => p.uid === votedUid)?.id;
        if (voterId !== undefined && votedId !== undefined) {
          mappedVotes[voterId] = votedId;
        }
      });

      const winningMrWhiteId =
        gameState.winReason === 'impostor_guessed'
          ? (players.find((p) => p.uid === (gameState.winningMrWhiteUid || gameState.impostorId))
              ?.id ?? null)
          : null;

      return (
        <div className="relative h-full w-full">
          <ResultScreen
            players={players}
            impostorIndex={players.find((p) => p.uid === gameState.impostorId)?.id ?? -1}
            secretWord={gameState.secretWord}
            undercoverWord={gameState.undercoverWord}
            voteData={mappedVotes}
            onGameEnd={() => {}}
            onNext={() => {
              if (isHost) {
                updateGameState({
                  phase: 'SETUP_PENDING',
                  round: 1,
                  votes: {},
                  readyPlayers: [],
                  clues: [],
                  turnOrder: [],
                  currentTurnIndex: 0,
                  turnsCompleted: false,
                  mostVotedId: null,
                  tieBroken: false,
                  winReason: null,
                  winner: null,
                  winningMrWhiteUid: null,
                });
              }
            }}
            roundWinner={gameState.winner}
            winReason={gameState.winReason}
            winningMrWhiteId={winningMrWhiteId}
            isOnline={true}
            isHost={isHost}
            onBackToLobby={handleBackToLobbyFromResult}
            onLeaveRoom={() => setShowLeaveConfirm(true)}
          />
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center flex-1 text-center p-6">
        <h2 className="text-2xl font-bold text-primary mb-4">
          {t('phaseLabel')} {phase}
        </h2>
        <button
          onClick={() => setShowLeaveConfirm(true)}
          className="btn-modern btn-modern-outline mt-6 px-6 py-3 rounded-xl"
        >
          {t('leaveRoom')}
        </button>
      </div>
    );
  };

  return (
    <div className="relative min-h-full w-full flex flex-col">
      {/* Compact Persistent Match HUD */}
      {showMatchHud && (
        <div className="w-full max-w-3xl mx-auto px-4 pt-3 pb-1 flex items-center justify-between gap-2 z-20">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-3 py-1.5 rounded-xl bg-white/10 border border-white/15 text-xs font-black text-text-main tabular-nums">
              {t('roundNumberLabel', { round: currentRound })}
            </span>
            <span className="px-3 py-1.5 rounded-xl bg-bg-surface/80 border border-white/10 text-xs font-bold text-text-muted tabular-nums">
              {t('aliveCountLabel', { count: alivePlayers.length })}
            </span>
            <span className="px-3 py-1.5 rounded-xl bg-rose-500/15 border border-rose-400/30 text-xs font-black text-rose-200 tabular-nums flex items-center gap-1.5">
              {difficulty === 'hard' ? (
                <>
                  <img
                    src="/assets/roles/infiltrators_badge.png"
                    alt="Infiltrators"
                    referrerPolicy="no-referrer"
                    className="w-4 h-4 object-contain"
                  />
                  <span>
                    {t('remainingIntruders')}: {totalAliveInfiltrators}
                  </span>
                </>
              ) : (
                <span>
                  {t('remainingIntruders')}: {totalAliveInfiltrators}
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {currentPlayer && !currentPlayer.isEliminated && (
              <button
                onClick={() => {
                  setPeekRevealed(false);
                  setShowWordPeek(true);
                }}
                className="min-h-[40px] px-3 rounded-xl bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs font-black flex items-center gap-1.5"
              >
                <Eye size={15} />
                <span>{t('myWordPeek')}</span>
              </button>
            )}
            <button
              onClick={() => setShowLeaveConfirm(true)}
              className="min-h-[40px] min-w-[40px] px-2.5 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 text-rose-300 flex items-center justify-center"
              aria-label={t('leaveRoom')}
              title={t('leaveRoom')}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Top quick exit button during SETUP_PENDING / REVEAL */}
      {!showMatchHud && phase !== 'RESULT' && (
        <div className="w-full max-w-3xl mx-auto px-4 pt-3 flex justify-end z-20">
          <button
            onClick={() => setShowLeaveConfirm(true)}
            className="min-h-[40px] px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-400/30 text-rose-300 text-xs font-black flex items-center gap-1.5"
          >
            <LogOut size={15} />
            <span>{t('leaveRoom')}</span>
          </button>
        </div>
      )}

      <div className="flex-1 flex flex-col">{renderPhase()}</div>

      {/* Floating Chat Button */}
      <button
        onClick={() => setShowChat(true)}
        className="fixed bottom-5 left-5 min-h-[54px] min-w-[54px] flex items-center justify-center bg-primary text-white rounded-full shadow-lg hover:bg-primary-dark transition-all z-40"
        aria-label={t('chat')}
      >
        <MessageCircle className="w-6 h-6" />
        {room.messages?.length > 0 && (
          <span className="absolute top-1 right-1 w-3 h-3 bg-danger rounded-full border-2 border-bg-dark"></span>
        )}
      </button>

      {/* Secret Word Peek Modal */}
      {showWordPeek && currentPlayer && (
        <div
          onClick={() => setShowWordPeek(false)}
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-5"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="card-modern p-6 w-full max-w-sm text-center"
          >
            {!peekRevealed ? (
              <div className="py-6 flex flex-col items-center gap-4">
                <EyeOff size={40} className="text-primary" />
                <p className="text-sm font-bold text-text-muted">{t('tapToRevealWord')}</p>
                <button
                  onClick={() => setPeekRevealed(true)}
                  className="btn-modern w-full min-h-[48px] rounded-2xl font-black"
                >
                  {t('myWordPeek')}
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                {renderWordCardInner(currentPlayer)}
                <button
                  onClick={() => setShowWordPeek(false)}
                  className="btn-modern btn-modern-outline w-full min-h-[48px] rounded-2xl font-black"
                >
                  {t('hideWord')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Leave Room Confirmation Modal */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-5">
          <div className="card-modern p-6 w-full max-w-sm text-center">
            <h3 className="text-lg font-black mb-2">{t('leaveRoom')}</h3>
            <p className="text-sm font-bold text-text-muted mb-6">{t('leaveRoomConfirm')}</p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLeaveConfirm(false)}
                className="btn-modern btn-modern-outline flex-1 min-h-[48px] rounded-2xl font-black"
              >
                {t('stay')}
              </button>
              <button
                onClick={handleLeaveConfirmed}
                className="flex-1 min-h-[48px] rounded-2xl bg-rose-500 hover:bg-rose-400 text-white font-black transition-colors"
              >
                {t('leave')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Modal */}
      <ChatBox
        roomId={roomId}
        messages={room.messages || []}
        currentUser={user}
        currentProfile={profile}
        showChat={showChat}
        setShowChat={setShowChat}
      />

      {selectedPlayerForStats && (
        <PlayerStatsModal
          isOpen={!!selectedPlayerForStats}
          onClose={() => setSelectedPlayerForStats(null)}
          uid={selectedPlayerForStats.uid}
          name={selectedPlayerForStats.name}
          avatar={selectedPlayerForStats.avatar}
          isVotingPhase={
            phase === 'VOTING' &&
            !currentPlayer?.isEliminated &&
            !selectedPlayerForStats.isEliminated &&
            selectedPlayerForStats.uid !== user.uid &&
            !gameState.votes?.[user.uid]
          }
          onVote={() => handleVote(selectedPlayerForStats.uid)}
        />
      )}
    </div>
  );
};
