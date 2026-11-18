import React, { useState, useEffect } from 'react';
import {
  GamePhase,
  Player,
  GameSettings,
  DescriptionEntry,
  PlayerRole,
  SpecialRoleId,
} from './types';
import { WelcomeScreen } from './components/WelcomeScreen';
import { PlayerSetup } from './components/PlayerSetup';
import { GameRound } from './components/GameRound';
import { GameSettingsScreen } from './components/GameSettingsScreen';
import { QuestionPhase } from './components/QuestionPhase';
import { DiscussionPhase } from './components/DiscussionPhase';
import { VotingScreen, VoteCompletionMeta } from './components/VotingScreen';
import { RevealVoteResult } from './components/RevealVoteResult';
import { ResultScreen } from './components/ResultScreen';
import { ScoreboardScreen } from './components/ScoreboardScreen';
import { SettingsScreen } from './components/SettingsScreen';
import { RulesScreen } from './components/RulesScreen';
import { ImpostorGuessScreen } from './components/ImpostorGuessScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { OnlineRoomsScreen } from './components/OnlineRoomsScreen';
import { OnlineLobbyScreen } from './components/OnlineLobbyScreen';
import { OnlineGameScreen } from './components/OnlineGameScreen';
import { LanguageDictionary } from './components/LanguageDictionary';
import { InventoryScreen } from './components/InventoryScreen';
import { AuthProvider } from './contexts/AuthContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Avatar } from './components/Avatar';
import { auth, db } from './firebase';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { getRandomWordPair } from './services/geminiService';
import { Header } from './components/Header';
import {
  getScores,
  saveRecentPlayers,
  updatePlayerScore,
  getSettings,
} from './services/storageService';
import { playSound } from './services/soundService';
import { getPlayerRoundPoints } from './services/gameScoring';
import { AnimatePresence, motion } from 'framer-motion';
import { getUITranslation } from './translations';
import { ToastHost } from './components/ToastHost';
import { showToast } from './utils/toast';
import { leaveOnlineRoom } from './utils/onlineRoomService';
import { getRoleAsset, getRoleTitle } from './data/specialRoles';

const ACTIVE_GAME_PHASES = [
  GamePhase.REVEAL,
  GamePhase.PLAYING,
  GamePhase.DISCUSSION,
  GamePhase.VOTING,
  GamePhase.REVEAL_VOTE_RESULT,
  GamePhase.IMPOSTOR_GUESS,
  GamePhase.ONLINE_LOBBY,
  GamePhase.ONLINE_GAME,
];

function AppContent() {
  const [phase, setPhase] = useState<GamePhase>(GamePhase.WELCOME);
  const [players, setPlayers] = useState<Player[]>([]);
  const [rolePool, setRolePool] = useState<string[]>([]);
  const [specialRolePool, setSpecialRolePool] = useState<(SpecialRoleId | null)[]>([]);
  const [secretWord, setSecretWord] = useState<string>('');
  const [undercoverWord, setUndercoverWord] = useState<string>('');
  const [relatedWords, setRelatedWords] = useState<string[]>([]);
  const [impostorIndex, setImpostorIndex] = useState<number>(-1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [voteData, setVoteData] = useState<Record<number, number>>({});
  const [mostVotedPlayerId, setMostVotedPlayerId] = useState<number | null>(null);
  const [blockedBySpecial, setBlockedBySpecial] = useState<'boomerang' | 'protector' | null>(null);
  const [bouncedFromName, setBouncedFromName] = useState<string | null>(null);
  const [foolBonusTriggered, setFoolBonusTriggered] = useState<boolean>(false);
  const [loversPartnerName, setLoversPartnerName] = useState<string | null>(null);

  // Special Role Interactive Modals
  const [pendingTieCandidates, setPendingTieCandidates] = useState<number[] | null>(null);
  const [pendingAvengerId, setPendingAvengerId] = useState<number | null>(null);
  const [pendingBoomerangId, setPendingBoomerangId] = useState<number | null>(null);
  const [pendingVoteMeta, setPendingVoteMeta] = useState<VoteCompletionMeta | null>(null);

  const [descriptionsLog, setDescriptionsLog] = useState<DescriptionEntry[]>([]);

  const [lastWinner, setLastWinner] = useState<'impostor' | 'citizens' | 'fool' | null>(null);
  const [winReason, setWinReason] = useState<
    'impostor_guessed' | 'citizens_wrong_vote' | 'impostor_caught' | 'fool_won' | null
  >(null);
  const [currentRound, setCurrentRound] = useState<number>(1);

  // Online State
  const [currentRoomId, setCurrentRoomId] = useState<string | null>(null);

  // Theme & Language State
  const [currentTheme, setCurrentTheme] = useState<'dark' | 'gray' | 'light' | 'system'>(
    getSettings().theme || 'dark'
  );
  const [currentButtonColor, setCurrentButtonColor] = useState(
    getSettings().buttonColor || 'default'
  );
  const [currentLanguage, setCurrentLanguage] = useState(getSettings().language || 'ar');
  const t = (key: string) => getUITranslation(currentLanguage, key);

  const bgClass = (() => {
    if (phase === GamePhase.VOTING || phase === GamePhase.REVEAL_VOTE_RESULT) {
      return 'bg-game-danger';
    }
    if (phase === GamePhase.PLAYING || phase === GamePhase.DISCUSSION) {
      return 'bg-game-accent';
    }
    return 'bg-game-premium';
  })();

  useEffect(() => {
    const applyTheme = () => {
      let activeTheme = currentTheme;
      if (currentTheme === 'system') {
        const isDarkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
        activeTheme = isDarkMode ? 'dark' : 'light';
      }
      document.documentElement.className = `theme-${activeTheme} color-${currentButtonColor}`;
    };

    applyTheme();

    if (currentTheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => applyTheme();
      mediaQuery.addEventListener('change', listener);
      return () => mediaQuery.removeEventListener('change', listener);
    }
  }, [currentTheme, currentButtonColor]);

  useEffect(() => {
    document.body.className = `${bgClass} text-text-main min-h-screen transition-colors duration-1000`;
    const isRTL = currentLanguage === 'ar';
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
    document.documentElement.lang = currentLanguage;
  }, [currentLanguage, phase, bgClass]);

  const handleThemeChange = (theme: 'dark' | 'gray' | 'light' | 'system') => {
    setCurrentTheme(theme);
  };

  const handleButtonColorChange = (
    color: 'default' | 'blue' | 'green' | 'red' | 'purple' | 'orange'
  ) => {
    setCurrentButtonColor(color);
  };

  const handleLanguageChange = (lang: string) => {
    setCurrentLanguage(lang);
  };

  const setPlayerRole = (
    playerId: number,
    role: string,
    specialRole: SpecialRoleId | null = null
  ) => {
    setPlayers((prev) => {
      const typedRole = role as PlayerRole;
      const isLover = specialRole === 'lovers' || typedRole === 'lovers';
      const existingLover = isLover
        ? prev.find(
            (p) =>
              p.id !== playerId &&
              (p.specialRole === 'lovers' || p.role === 'lovers')
          )
        : undefined;

      return prev.map((p) => {
        if (p.id === playerId) {
          const isImpostor = typedRole === 'mrwhite';
          if (isImpostor) setImpostorIndex(playerId);
          return {
            ...p,
            role: typedRole,
            specialRole: specialRole ?? null,
            isImpostor,
            loverPartnerId: existingLover ? existingLover.id : p.loverPartnerId,
          };
        }
        if (existingLover && p.id === existingLover.id) {
          return { ...p, loverPartnerId: playerId };
        }
        return p;
      });
    });
  };

  const [tempPlayers, setTempPlayers] = useState<{ name: string; avatar: string }[]>([]);
  const [showExitConfirmation, setShowExitConfirmation] = useState(false);

  // History Management
  useEffect(() => {
    if (!window.history.state) {
      window.history.replaceState({ phase: GamePhase.WELCOME }, '');
    }

    const handlePopState = (event: PopStateEvent) => {
      if (showExitConfirmation) {
        setShowExitConfirmation(false);
        window.history.pushState({ phase }, '');
        return;
      }

      if (ACTIVE_GAME_PHASES.includes(phase)) {
        window.history.pushState({ phase }, '');
        setShowExitConfirmation(true);
        playSound('pop');
        return;
      }

      if (event.state && event.state.phase) {
        setPhase(event.state.phase);
      } else {
        setPhase(GamePhase.WELCOME);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [phase, showExitConfirmation]);

  const navigate = (newPhase: GamePhase) => {
    setPhase(newPhase);
    window.history.pushState({ phase: newPhase }, '');
  };

  const startGameSetup = () => navigate(GamePhase.SETUP);
  const handleManagePlayers = () => navigate(GamePhase.PLAYERS_LIST);

  const handlePlayersConfirmed = async (
    playersData: { name: string; avatar: string; isSleeping?: boolean }[]
  ) => {
    const activePlayers = playersData.filter((p) => !p.isSleeping);
    setTempPlayers(activePlayers);
    saveRecentPlayers(playersData);
    navigate(GamePhase.GAME_SETTINGS);
  };

  const [gameSettings, setGameSettings] = useState<GameSettings>({
    mrWhiteCount: 1,
    undercoverCount: 0,
    category: 'standard',
    difficulty: 'easy',
    useSpecialRoles: false,
    selectedSpecialRoles: [],
    gameMode: 'expression',
    turnDurationSeconds: 45,
  });

  const handleGameSettingsConfirmed = async (settings: GameSettings) => {
    setGameSettings(settings);
    setIsLoading(true);
    setError(null);
    try {
      const { civilianWord, undercoverWord: ucWord, decoys } = await getRandomWordPair(
        undefined,
        settings.category
      );
      initializeGame(tempPlayers, civilianWord, ucWord, decoys, settings);
    } catch (err) {
      console.error(err);
      setError(t('errorLoadingWords'));
    } finally {
      setIsLoading(false);
    }
  };

  const initializeGame = (
    activePlayers: { name: string; avatar: string }[],
    civilianWord: string,
    ucWord: string,
    decoys: string[] = [],
    settings: GameSettings
  ) => {
    const globalScores = getScores();
    const newPlayers: Player[] = activePlayers.map((p, index) => ({
      id: index,
      name: p.name,
      role: 'citizen',
      specialRole: null,
      isImpostor: false,
      score: globalScores[p.name] || 0,
      avatar: p.avatar,
      isEliminated: false,
      specialAbilityUsed: false,
      foolBonusAwarded: false,
      loverPartnerId: undefined,
    }));

    // Build main faction pool (Civilians, Undercovers, Mr. Whites)
    const pool: string[] = [];
    for (let i = 0; i < settings.mrWhiteCount; i++) {
      pool.push('mrwhite');
    }
    for (let i = 0; i < settings.undercoverCount; i++) {
      pool.push('undercover');
    }
    while (pool.length < activePlayers.length) {
      pool.push('citizen');
    }
    pool.sort(() => 0.5 - Math.random());

    // Build layered special powers pool (Special Roles NEVER override main team and NEVER win solo)
    const spPool: (SpecialRoleId | null)[] = Array(activePlayers.length).fill(null);
    if (
      settings.useSpecialRoles &&
      settings.selectedSpecialRoles &&
      settings.selectedSpecialRoles.length > 0
    ) {
      const availableIndices = Array.from({ length: activePlayers.length }, (_, i) => i).sort(
        () => 0.5 - Math.random()
      );
      const shuffledSpecials = [...settings.selectedSpecialRoles].sort(() => 0.5 - Math.random());

      for (const roleId of shuffledSpecials) {
        if (roleId === 'lovers') {
          if (activePlayers.length >= 5 && availableIndices.length >= 2) {
            const idx1 = availableIndices.pop()!;
            const idx2 = availableIndices.pop()!;
            spPool[idx1] = 'lovers';
            spPool[idx2] = 'lovers';
          }
        } else if (roleId === 'mr_meme') {
          if (availableIndices.length > 0) {
            // Prefer giving Mr. Meme to someone who has a word (not Mr. White)
            const nonWhitePos = availableIndices.findIndex((idx) => pool[idx] !== 'mrwhite');
            const pickedIdx =
              nonWhitePos !== -1
                ? availableIndices.splice(nonWhitePos, 1)[0]
                : availableIndices.pop()!;
            spPool[pickedIdx] = 'mr_meme';
          }
        } else if (availableIndices.length > 0) {
          const idx = availableIndices.pop()!;
          spPool[idx] = roleId;
        }
      }
    }

    setPlayers(newPlayers);
    setRolePool(pool);
    setSpecialRolePool(spPool);
    setSecretWord(civilianWord);
    setUndercoverWord(ucWord);
    setRelatedWords(decoys);
    setImpostorIndex(-1);
    setLastWinner(null);
    setWinReason(null);
    setVoteData({});
    setMostVotedPlayerId(null);
    setBlockedBySpecial(null);
    setBouncedFromName(null);
    setFoolBonusTriggered(false);
    setLoversPartnerName(null);
    setPendingTieCandidates(null);
    setPendingAvengerId(null);
    setDescriptionsLog([]);
    setCurrentRound(1);
    navigate(GamePhase.REVEAL);
  };

  const evaluateWinOrContinue = (updatedPlayers: Player[]) => {
    const aliveCitizens = updatedPlayers.filter(
      (p) => !p.isEliminated && p.role !== 'mrwhite' && p.role !== 'undercover'
    ).length;
    const aliveBadGuys = updatedPlayers.filter(
      (p) => !p.isEliminated && (p.role === 'mrwhite' || p.role === 'undercover')
    ).length;

    // Civilians win immediately once all Infiltrators are out
    if (aliveBadGuys === 0) {
      setWinReason('impostor_caught');
      handleGameEnd('citizens', 'impostor_caught', undefined, updatedPlayers);
      navigate(GamePhase.RESULT);
    } else if (aliveBadGuys >= aliveCitizens || aliveCitizens <= 1) {
      // Infiltrators win if they match/outnumber Civilians or only 1 Civilian remains
      setWinReason('citizens_wrong_vote');
      handleGameEnd('impostor', 'citizens_wrong_vote', undefined, updatedPlayers);
      navigate(GamePhase.RESULT);
    } else {
      setCurrentRound((prev) => prev + 1);
      setVoteData({});
      setMostVotedPlayerId(null);
      setBlockedBySpecial(null);
      setBouncedFromName(null);
      setFoolBonusTriggered(false);
      setLoversPartnerName(null);
      navigate(GamePhase.PLAYING);
    }
  };

  const eliminatePlayerAndCheckWin = (eliminatedId: number) => {
    const eliminatedPlayer = players.find((p) => p.id === eliminatedId);
    const isFirstElimination = !players.some((p) => p.isEliminated);
    const hasFool =
      eliminatedPlayer?.specialRole === 'fool' || eliminatedPlayer?.role === 'fool';
    const earnedFoolBonus = isFirstElimination && hasFool;

    // Lovers chain elimination (applies even if specialRole is 'lovers')
    const hasLovers =
      eliminatedPlayer?.specialRole === 'lovers' || eliminatedPlayer?.role === 'lovers';
    const partnerId = hasLovers ? eliminatedPlayer?.loverPartnerId : undefined;
    const hasAvenger =
      eliminatedPlayer?.specialRole === 'avenger' || eliminatedPlayer?.role === 'avenger';

    const updatedPlayers = players.map((p) => {
      if (p.id === eliminatedId) {
        return {
          ...p,
          isEliminated: true,
          foolBonusAwarded: earnedFoolBonus ? true : p.foolBonusAwarded,
          specialAbilityUsed: hasAvenger ? true : p.specialAbilityUsed,
        };
      }
      if (partnerId !== undefined && p.id === partnerId) {
        return { ...p, isEliminated: true };
      }
      return p;
    });

    setPlayers(updatedPlayers);

    const remainingAlive = updatedPlayers.filter((p) => !p.isEliminated);
    const aliveCitizensAfter = remainingAlive.filter(
      (p) => p.role !== 'mrwhite' && p.role !== 'undercover'
    ).length;
    const aliveBadGuysAfter = remainingAlive.filter(
      (p) => p.role === 'mrwhite' || p.role === 'undercover'
    ).length;
    const isRoundAlreadyDecided =
      aliveBadGuysAfter === 0 ||
      aliveBadGuysAfter >= aliveCitizensAfter ||
      aliveCitizensAfter <= 1;

    // Avenger revenge trigger only if the match has not already ended and > 1 player remains
    if (
      hasAvenger &&
      !eliminatedPlayer?.specialAbilityUsed &&
      !isRoundAlreadyDecided &&
      remainingAlive.length > 1
    ) {
      setPendingAvengerId(eliminatedPlayer!.id);
      return;
    }

    evaluateWinOrContinue(updatedPlayers);
  };

  const handleAvengerTargetPick = (targetId: number) => {
    playSound('dramatic');
    const targetPlayer = players.find((p) => p.id === targetId);

    // If Mr. Avenger targets Mr. White, grant Mr. White their standard final word-guess chance
    if (targetPlayer?.role === 'mrwhite' && relatedWords && relatedWords.length > 0) {
      const updatedAvengerOnly = players.map((p) =>
        p.id === pendingAvengerId
          ? { ...p, isEliminated: true, specialAbilityUsed: true }
          : p
      );
      setPendingAvengerId(null);
      setPlayers(updatedAvengerOnly);
      setMostVotedPlayerId(targetId);
      navigate(GamePhase.IMPOSTOR_GUESS);
      return;
    }

    const targetHasLovers =
      targetPlayer?.specialRole === 'lovers' || targetPlayer?.role === 'lovers';
    const partnerId = targetHasLovers ? targetPlayer?.loverPartnerId : undefined;

    const updatedPlayers = players.map((p) => {
      if (
        p.id === targetId ||
        p.id === pendingAvengerId ||
        (partnerId !== undefined && p.id === partnerId)
      ) {
        return { ...p, isEliminated: true, specialAbilityUsed: true };
      }
      return p;
    });

    setPendingAvengerId(null);
    setPlayers(updatedPlayers);
    evaluateWinOrContinue(updatedPlayers);
  };

  const finalizeVoteVictim = (
    target: Player,
    shieldedTargetId?: number | null
  ) => {
    const unusedProtector = players.find(
      (p) =>
        !p.isEliminated &&
        (p.specialRole === 'protector' || p.role === 'protector') &&
        !p.specialAbilityUsed
    );

    const hasExplicitShield =
      shieldedTargetId !== null && shieldedTargetId !== undefined && Boolean(unusedProtector);

    // If Mr. Shield deployed the shield this round, consume the shield and protect that target
    if (hasExplicitShield && unusedProtector) {
      setPlayers((prev) =>
        prev.map((p) => (p.id === unusedProtector.id ? { ...p, specialAbilityUsed: true } : p))
      );
      if (target.id === shieldedTargetId) {
        setBlockedBySpecial('protector');
        setMostVotedPlayerId(target.id);
        navigate(GamePhase.REVEAL_VOTE_RESULT);
        return;
      }
    } else if (
      (target.specialRole === 'protector' || target.role === 'protector') &&
      !target.specialAbilityUsed
    ) {
      // Passive fallback: if Mr. Shield kept his shield unused and was targeted directly
      setPlayers((prev) =>
        prev.map((p) => (p.id === target.id ? { ...p, specialAbilityUsed: true } : p))
      );
      setBlockedBySpecial('protector');
      setMostVotedPlayerId(target.id);
      navigate(GamePhase.REVEAL_VOTE_RESULT);
      return;
    }

    // Preview non-Mr.White special exit notices on RevealVoteResult
    if (target.role !== 'mrwhite') {
      const isFirstElim = !players.some((p) => p.isEliminated);
      const hasFool = target.specialRole === 'fool' || target.role === 'fool';
      if (isFirstElim && hasFool) {
        setFoolBonusTriggered(true);
      }

      const hasLovers = target.specialRole === 'lovers' || target.role === 'lovers';
      if (hasLovers && target.loverPartnerId !== undefined) {
        const partner = players.find(
          (p) => !p.isEliminated && p.id === target.loverPartnerId
        );
        if (partner) setLoversPartnerName(partner.name);
      }
    }

    setMostVotedPlayerId(target.id);
    navigate(GamePhase.REVEAL_VOTE_RESULT);
  };

  const resolveVoteTarget = (
    targetId: number,
    votes: Record<number, number>,
    meta?: VoteCompletionMeta
  ) => {
    setBlockedBySpecial(null);
    setBouncedFromName(null);
    setFoolBonusTriggered(false);
    setLoversPartnerName(null);

    const votedPlayer = players.find((p) => p.id === targetId);
    if (!votedPlayer) return;

    // Explicit Mr. Shield protection overrides everything (protects chosen target cleanly)
    if (meta?.shieldedTargetId === votedPlayer.id) {
      finalizeVoteVictim(votedPlayer, meta.shieldedTargetId);
      return;
    }

    // Mr. Boomerang one-time counter-reflection: ALWAYS bounces onto an accuser/voter
    const hasBoomerang =
      votedPlayer.specialRole === 'boomerang' || votedPlayer.role === 'boomerang';
    if (hasBoomerang && !votedPlayer.specialAbilityUsed) {
      setPlayers((prev) =>
        prev.map((p) => (p.id === votedPlayer.id ? { ...p, specialAbilityUsed: true } : p))
      );

      if (!meta?.isGroupVote) {
        const nonSelfVoters = Object.entries(votes)
          .filter(([vId, tId]) => tId === votedPlayer.id && Number(vId) !== votedPlayer.id)
          .map(([vId]) => Number(vId));
        const aliveVoters = nonSelfVoters.filter(
          (id) => !players.find((p) => p.id === id)?.isEliminated
        );
        const bouncePool = aliveVoters.length > 0 ? aliveVoters : nonSelfVoters;

        if (bouncePool.length > 0) {
          const bouncedId = bouncePool[Math.floor(Math.random() * bouncePool.length)];
          const bouncedPlayer = players.find((p) => p.id === bouncedId);
          if (bouncedPlayer) {
            setBouncedFromName(votedPlayer.name);
            finalizeVoteVictim(bouncedPlayer, meta?.shieldedTargetId);
            return;
          }
        }
      }

      // In Group Vote (or no non-self voter tracked), let Mr. Boomerang pick an accuser to hit back
      const otherAlivePlayers = players.filter((p) => !p.isEliminated && p.id !== votedPlayer.id);
      if (otherAlivePlayers.length > 0) {
        setPendingVoteMeta(meta || null);
        setPendingBoomerangId(votedPlayer.id);
        return;
      }
    }

    finalizeVoteVictim(votedPlayer, meta?.shieldedTargetId);
  };

  const handleBoomerangTargetPick = (targetId: number) => {
    const boomerangPlayer =
      pendingBoomerangId !== null ? players.find((p) => p.id === pendingBoomerangId) : null;
    const victim = players.find((p) => p.id === targetId);
    const savedMeta = pendingVoteMeta;
    setPendingBoomerangId(null);
    setPendingVoteMeta(null);

    if (!victim) return;
    playSound('dramatic');
    if (boomerangPlayer) {
      setBouncedFromName(boomerangPlayer.name);
    }
    finalizeVoteVictim(victim, savedMeta?.shieldedTargetId);
  };

  const handleVotingComplete = (votes: Record<number, number>, meta?: VoteCompletionMeta) => {
    setVoteData(votes);
    setPendingVoteMeta(meta || null);

    const voteCounts: Record<number, number> = {};
    Object.values(votes).forEach((suspectId) => {
      voteCounts[suspectId] = (voteCounts[suspectId] || 0) + 1;
    });

    let maxVotes = 0;
    let candidates: number[] = [];

    Object.entries(voteCounts).forEach(([idStr, count]) => {
      const id = parseInt(idStr, 10);
      if (count > maxVotes) {
        maxVotes = count;
        candidates = [id];
      } else if (count === maxVotes) {
        candidates.push(id);
      }
    });

    if (candidates.length > 1) {
      const justicePlayer = players.find(
        (p) => p.specialRole === 'justice' || p.role === 'justice'
      );
      if (justicePlayer) {
        setPendingTieCandidates(candidates);
        return;
      }
      const randomTieLoser = candidates[Math.floor(Math.random() * candidates.length)];
      resolveVoteTarget(randomTieLoser, votes, meta);
      return;
    }

    resolveVoteTarget(candidates[0], votes, meta);
  };

  const handleRevealNext = () => {
    const votedPlayer = players.find((p) => p.id === mostVotedPlayerId);
    if (!votedPlayer) return;

    if (blockedBySpecial) {
      setCurrentRound((prev) => prev + 1);
      setVoteData({});
      setMostVotedPlayerId(null);
      setBlockedBySpecial(null);
      setBouncedFromName(null);
      setFoolBonusTriggered(false);
      setLoversPartnerName(null);
      navigate(GamePhase.PLAYING);
      return;
    }

    if (votedPlayer.role === 'mrwhite') {
      navigate(GamePhase.IMPOSTOR_GUESS);
    } else {
      eliminatePlayerAndCheckWin(votedPlayer.id);
    }
  };

  const handleImpostorGuess = (isCorrect: boolean) => {
    if (isCorrect) {
      setWinReason('impostor_guessed');
      handleGameEnd('impostor', 'impostor_guessed', undefined, undefined, mostVotedPlayerId);
      navigate(GamePhase.RESULT);
    } else {
      eliminatePlayerAndCheckWin(mostVotedPlayerId!);
    }
  };

  const handleGameEnd = (
    winner: 'impostor' | 'citizens' | 'fool',
    reason?: string,
    _explicitVotes?: Record<number, number>,
    playersOverride?: Player[],
    winningMrWhiteId?: number | null
  ) => {
    const resolvedWinner: 'impostor' | 'citizens' =
      winner === 'fool' ? 'citizens' : winner;
    const effectiveReason = reason ?? winReason;
    setLastWinner(resolvedWinner);
    const sourcePlayers = playersOverride || players;

    const updatedPlayers = sourcePlayers.map((p) => {
      const pointsToAdd = getPlayerRoundPoints(
        p,
        sourcePlayers,
        resolvedWinner,
        effectiveReason,
        winningMrWhiteId
      );

      if (pointsToAdd > 0) {
        updatePlayerScore(p.name, pointsToAdd);
        return { ...p, score: p.score + pointsToAdd };
      }
      return p;
    });
    setPlayers(updatedPlayers);
  };

  const handlePlayAgain = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { civilianWord, undercoverWord: ucWord, decoys } = await getRandomWordPair(
        undefined,
        gameSettings.category
      );
      initializeGame(tempPlayers, civilianWord, ucWord, decoys, gameSettings);
    } catch (err) {
      console.error(err);
      setError(t('errorLoadingWords'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoHome = () => {
    if (ACTIVE_GAME_PHASES.includes(phase)) {
      setShowExitConfirmation(true);
      playSound('pop');
    } else {
      setCurrentRoomId(null);
      navigate(GamePhase.WELCOME);
    }
  };

  const confirmExit = async () => {
    const roomToLeave = currentRoomId;
    const uid = auth.currentUser?.uid;
    setShowExitConfirmation(false);
    setCurrentRoomId(null);
    setPendingTieCandidates(null);
    setPendingAvengerId(null);
    setPendingBoomerangId(null);
    setPendingVoteMeta(null);
    navigate(GamePhase.WELCOME);

    if (roomToLeave && uid) {
      try {
        await leaveOnlineRoom(roomToLeave, uid);
      } catch (err) {
        console.error('Failed to leave online room on exit:', err);
      }
    }
  };

  // Online Handlers
  const handleCreateRoom = async (settings: {
    maxPlayers: number;
    language: string;
    isPrivate: boolean;
    category: string;
    difficulty: 'easy' | 'hard';
    turnDurationSeconds?: number;
  }) => {
    if (!auth.currentUser) {
      navigate(GamePhase.PROFILE);
      return;
    }
    try {
      const roomRef = await addDoc(collection(db, 'rooms'), {
        hostId: auth.currentUser.uid,
        hostName: auth.currentUser.displayName || t('newPlayer'),
        hostAvatar:
          auth.currentUser.photoURL ||
          `https://api.dicebear.com/7.x/avataaars/svg?seed=${auth.currentUser.uid}`,
        status: 'waiting',
        maxPlayers: settings.maxPlayers,
        language: settings.language,
        isPrivate: settings.isPrivate,
        category: settings.category || 'standard',
        difficulty: settings.difficulty || 'easy',
        turnDurationSeconds: settings.turnDurationSeconds || 45,
        secretCode: Math.floor(100000 + Math.random() * 900000).toString(),
        players: [],
        kickedPlayers: [],
        messages: [],
        createdAt: serverTimestamp(),
      });

      setCurrentRoomId(roomRef.id);
      navigate(GamePhase.ONLINE_LOBBY);
    } catch (err) {
      console.error('Error creating room:', err);
      showToast(t('errorOccurred'), 'error');
    }
  };

  const handleJoinRoom = (roomId: string) => {
    if (!auth.currentUser) {
      navigate(GamePhase.PROFILE);
      return;
    }
    setCurrentRoomId(roomId);
    navigate(GamePhase.ONLINE_LOBBY);
  };

  const handleStartOnlineGame = () => {
    navigate(GamePhase.ONLINE_GAME);
  };

  const handleLeaveOnlineToRooms = () => {
    setCurrentRoomId(null);
    navigate(GamePhase.ONLINE_ROOMS);
  };

  const pageVariants = {
    initial: { opacity: 0, x: 20 },
    animate: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: -20 },
  };

  const pageTransition: any = {
    type: 'tween',
    ease: 'anticipate',
    duration: 0.28,
  };

  const justicePlayer = players.find(
    (p) => p.specialRole === 'justice' || p.role === 'justice'
  );
  const avengerPlayer =
    pendingAvengerId !== null ? players.find((p) => p.id === pendingAvengerId) : null;
  const boomerangPlayer =
    pendingBoomerangId !== null ? players.find((p) => p.id === pendingBoomerangId) : null;

  return (
    <div
      className={`h-[100dvh] text-text-main flex flex-col w-full relative overflow-hidden ${bgClass} ${
        currentLanguage === 'ar' ? 'font-cairo' : 'font-sans'
      }`}
    >
      <div className="bg-mesh" />
      <div className="bg-vignette" />
      <div className="bg-scanlines" />
      <div className="blob-secondary" />
      <ToastHost />
      {phase !== GamePhase.WELCOME && <Header onHome={handleGoHome} showHome={true} />}

      {error && (
        <div className="mx-auto mt-2 px-4 py-2 rounded-xl bg-rose-500/20 border border-rose-400/50 text-rose-200 text-xs font-black z-30 flex items-center gap-3">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="underline">
            {t('ok')}
          </button>
        </div>
      )}

      {isLoading && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center">
          <div className="bg-bg-surface border border-border-strong rounded-3xl px-8 py-6 text-center shadow-2xl">
            <div className="w-10 h-10 border-4 border-sky-400 border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <p className="text-sm font-black text-text-main">{t('preparing')}</p>
          </div>
        </div>
      )}

      <main className="w-full flex-1 flex flex-col z-20 relative overflow-y-auto custom-scrollbar overflow-x-hidden">
        <AnimatePresence mode="wait">
          {phase === GamePhase.WELCOME && (
            <motion.div
              key="welcome"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <WelcomeScreen
                onStart={startGameSetup}
                onShowScoreboard={() => navigate(GamePhase.SCOREBOARD)}
                onManagePlayers={handleManagePlayers}
                onOpenSettings={() => navigate(GamePhase.SETTINGS)}
                onShowRules={() => navigate(GamePhase.RULES)}
                onShowProfile={() => navigate(GamePhase.PROFILE)}
                onShowOnline={() => navigate(GamePhase.ONLINE_ROOMS)}
                onShowDictionary={() => navigate(GamePhase.DICTIONARY)}
                onShowInventory={() => navigate(GamePhase.INVENTORY)}
                onLanguageChange={handleLanguageChange}
                currentTheme={currentTheme}
              />
            </motion.div>
          )}

          {phase === GamePhase.DICTIONARY && (
            <motion.div
              key="dictionary"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <LanguageDictionary onBack={handleGoHome} />
            </motion.div>
          )}

          {phase === GamePhase.INVENTORY && (
            <motion.div
              key="inventory"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <InventoryScreen onBack={handleGoHome} />
            </motion.div>
          )}

          {phase === GamePhase.PROFILE && (
            <motion.div
              key="profile"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <ProfileScreen onBack={handleGoHome} />
            </motion.div>
          )}

          {phase === GamePhase.ONLINE_ROOMS && (
            <motion.div
              key="online_rooms"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <OnlineRoomsScreen
                onBack={handleGoHome}
                onCreateRoom={handleCreateRoom}
                onJoinRoom={handleJoinRoom}
                currentLanguage={currentLanguage}
              />
            </motion.div>
          )}

          {phase === GamePhase.ONLINE_LOBBY && currentRoomId && (
            <motion.div
              key="online_lobby"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <OnlineLobbyScreen
                roomId={currentRoomId}
                onBack={handleLeaveOnlineToRooms}
                onStartGame={handleStartOnlineGame}
              />
            </motion.div>
          )}

          {phase === GamePhase.ONLINE_GAME && currentRoomId && (
            <motion.div
              key="online_game"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <OnlineGameScreen
                roomId={currentRoomId}
                onBack={handleLeaveOnlineToRooms}
                onReturnToLobby={() => navigate(GamePhase.ONLINE_LOBBY)}
              />
            </motion.div>
          )}

          {phase === GamePhase.SETUP && (
            <motion.div
              key="setup"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <PlayerSetup mode="setup" onNext={handlePlayersConfirmed} />
            </motion.div>
          )}

          {phase === GamePhase.GAME_SETTINGS && (
            <motion.div
              key="game_settings"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <GameSettingsScreen
                playersCount={tempPlayers.length}
                onStart={handleGameSettingsConfirmed}
                onBack={handleGoHome}
                onEditPlayers={() => navigate(GamePhase.SETUP)}
              />
            </motion.div>
          )}

          {phase === GamePhase.PLAYERS_LIST && (
            <motion.div
              key="players_list"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <PlayerSetup mode="manage" onBack={handleGoHome} />
            </motion.div>
          )}

          {phase === GamePhase.REVEAL && (
            <motion.div
              key="reveal"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <GameRound
                players={players}
                rolePool={rolePool}
                specialRolePool={specialRolePool}
                secretWord={secretWord}
                undercoverWord={undercoverWord}
                relatedWords={relatedWords}
                difficulty={gameSettings.difficulty}
                onAssignRole={setPlayerRole}
                onAllRevealed={() => navigate(GamePhase.PLAYING)}
              />
            </motion.div>
          )}

          {phase === GamePhase.PLAYING && (
            <motion.div
              key="playing"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <QuestionPhase
                players={players}
                onTimeUp={() => navigate(GamePhase.VOTING)}
                gameMode={gameSettings.gameMode}
                difficulty={gameSettings.difficulty}
                currentRound={currentRound}
                turnDurationSeconds={gameSettings.turnDurationSeconds}
                secretWord={secretWord}
                undercoverWord={undercoverWord}
                descriptionsLog={descriptionsLog}
                onAddDescription={(entry) => setDescriptionsLog((prev) => [...prev, entry])}
              />
            </motion.div>
          )}

          {phase === GamePhase.DISCUSSION && (
            <motion.div
              key="discussion"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <DiscussionPhase
                players={players}
                onTimeUp={() => navigate(GamePhase.VOTING)}
                onSkip={() => navigate(GamePhase.VOTING)}
              />
            </motion.div>
          )}

          {phase === GamePhase.VOTING && (
            <motion.div
              key="voting"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <VotingScreen
                players={players}
                onVoteComplete={handleVotingComplete}
                currentRound={currentRound}
                difficulty={gameSettings.difficulty}
              />
            </motion.div>
          )}

          {phase === GamePhase.REVEAL_VOTE_RESULT && mostVotedPlayerId !== null && (
            <motion.div
              key="reveal_vote_result"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <RevealVoteResult
                votedPlayerId={mostVotedPlayerId}
                impostorId={players[impostorIndex]?.id ?? -1}
                undercoverId={players.find((p) => p.role === 'undercover')?.id}
                players={players}
                onNext={handleRevealNext}
                voters={players.filter((p) => voteData[p.id] === mostVotedPlayerId)}
                isOnline={false}
                blockedBySpecial={blockedBySpecial}
                bouncedFromName={bouncedFromName}
                foolBonusTriggered={foolBonusTriggered}
                loversPartnerName={loversPartnerName}
              />
            </motion.div>
          )}

          {phase === GamePhase.IMPOSTOR_GUESS && (
            <motion.div
              key="impostor_guess"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <ImpostorGuessScreen
                impostor={
                  players.find((p) => p.id === mostVotedPlayerId) ||
                  players[impostorIndex] ||
                  players[0]
                }
                secretWord={secretWord}
                undercoverWord={undercoverWord}
                relatedWords={relatedWords}
                onGuess={handleImpostorGuess}
              />
            </motion.div>
          )}

          {phase === GamePhase.RESULT && (
            <motion.div
              key="result"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <ResultScreen
                players={players}
                impostorIndex={impostorIndex}
                secretWord={secretWord}
                undercoverWord={undercoverWord}
                voteData={voteData}
                onGameEnd={(w) => handleGameEnd(w)}
                onNext={() => navigate(GamePhase.SCOREBOARD)}
                roundWinner={lastWinner}
                winReason={winReason}
                winningMrWhiteId={winReason === 'impostor_guessed' ? mostVotedPlayerId : null}
              />
            </motion.div>
          )}

          {phase === GamePhase.SCOREBOARD && (
            <motion.div
              key="scoreboard"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <ScoreboardScreen
                onBack={handleGoHome}
                onNextRound={tempPlayers.length > 0 ? handlePlayAgain : undefined}
              />
            </motion.div>
          )}

          {phase === GamePhase.SETTINGS && (
            <motion.div
              key="settings"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <SettingsScreen
                onBack={handleGoHome}
                onThemeChange={handleThemeChange}
                onButtonColorChange={handleButtonColorChange}
                onLanguageChange={handleLanguageChange}
              />
            </motion.div>
          )}

          {phase === GamePhase.RULES && (
            <motion.div
              key="rules"
              initial="initial"
              animate="animate"
              exit="exit"
              variants={pageVariants}
              transition={pageTransition}
              className="w-full h-full"
            >
              <RulesScreen onBack={handleGoHome} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Mr. Justice Tiebreaker Modal */}
      <AnimatePresence>
        {pendingTieCandidates && justicePlayer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-5"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-sm bg-slate-900 border border-emerald-400/40 rounded-[2.25rem] p-6 text-center shadow-2xl"
            >
              <div className="w-20 h-20 rounded-full bg-white p-1.5 mx-auto mb-3 overflow-hidden shadow-lg">
                <img
                  src={getRoleAsset('justice')}
                  alt={getRoleTitle('justice', currentLanguage)}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              </div>
              <h3 className="text-xl font-black text-emerald-300 mb-1">
                {getRoleTitle('justice', currentLanguage)} ({justicePlayer.name})
              </h3>
              <p className="text-xs font-bold text-slate-300 mb-5">
                {currentLanguage === 'ar'
                  ? 'حدث تعادل في الأصوات! اختر من سيتم إقصاؤه من بين المتعادلين:'
                  : 'Tie vote! Choose which tied player gets eliminated:'}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {pendingTieCandidates.map((candId) => {
                  const cand = players.find((p) => p.id === candId);
                  if (!cand) return null;
                  return (
                    <button
                      key={cand.id}
                      onClick={() => {
                        playSound('vote');
                        const savedMeta = pendingVoteMeta;
                        setPendingTieCandidates(null);
                        resolveVoteTarget(cand.id, voteData, savedMeta || undefined);
                      }}
                      className="p-3 rounded-2xl bg-white/5 hover:bg-emerald-500/20 border border-white/15 hover:border-emerald-400 flex flex-col items-center gap-2 transition-all"
                    >
                      <Avatar avatar={cand.avatar} name={cand.name} size={56} />
                      <span className="text-sm font-black text-white truncate max-w-full">
                        {cand.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mr. Boomerang Reflection Picker Modal (Group Vote) */}
      <AnimatePresence>
        {boomerangPlayer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-5"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-sm bg-slate-900 border border-rose-400/50 rounded-[2.25rem] p-6 text-center shadow-2xl"
            >
              <div className="w-20 h-20 rounded-full bg-white p-1.5 mx-auto mb-3 overflow-hidden shadow-lg">
                <img
                  src={getRoleAsset('boomerang')}
                  alt={getRoleTitle('boomerang', currentLanguage)}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              </div>
              <h3 className="text-xl font-black text-rose-300 mb-1">
                {getRoleTitle('boomerang', currentLanguage)} ({boomerangPlayer.name})
              </h3>
              <p className="text-xs font-bold text-slate-300 mb-5">
                {currentLanguage === 'ar'
                  ? 'ارتد التصويت! اختر أحد المصوتين ضدك ليواجه الإقصاء بدلاً منك:'
                  : 'Counter-bounce activated! Pick an accuser to take the elimination instead:'}
              </p>
              <div className="grid grid-cols-3 gap-2.5 max-h-64 overflow-y-auto">
                {players
                  .filter((p) => !p.isEliminated && p.id !== boomerangPlayer.id)
                  .map((target) => (
                    <button
                      key={target.id}
                      onClick={() => handleBoomerangTargetPick(target.id)}
                      className="p-2.5 rounded-2xl bg-white/5 hover:bg-rose-500/20 border border-white/15 hover:border-rose-400 flex flex-col items-center gap-1.5 transition-all"
                    >
                      <Avatar avatar={target.avatar} name={target.name} size={46} />
                      <span className="text-xs font-black text-white truncate max-w-full">
                        {target.name}
                      </span>
                    </button>
                  ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mr. Avenger Revenge Picker Modal */}
      <AnimatePresence>
        {avengerPlayer && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-5"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="w-full max-w-sm bg-slate-900 border border-orange-400/50 rounded-[2.25rem] p-6 text-center shadow-2xl"
            >
              <div className="w-20 h-20 rounded-full bg-white p-1.5 mx-auto mb-3 overflow-hidden shadow-lg">
                <img
                  src={getRoleAsset('avenger')}
                  alt={getRoleTitle('avenger', currentLanguage)}
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-contain"
                />
              </div>
              <h3 className="text-xl font-black text-orange-300 mb-1">
                {getRoleTitle('avenger', currentLanguage)} ({avengerPlayer.name})
              </h3>
              <p className="text-xs font-bold text-slate-300 mb-5">
                {currentLanguage === 'ar'
                  ? 'انتقم قبل مغادرتك! اختر لاعباً ليخرج معك الآن:'
                  : 'Take your revenge! Pick one player to eliminate with you:'}
              </p>
              <div className="grid grid-cols-3 gap-2.5 max-h-64 overflow-y-auto">
                {players
                  .filter((p) => !p.isEliminated)
                  .map((target) => (
                    <button
                      key={target.id}
                      onClick={() => handleAvengerTargetPick(target.id)}
                      className="p-2.5 rounded-2xl bg-white/5 hover:bg-orange-500/20 border border-white/15 hover:border-orange-400 flex flex-col items-center gap-1.5 transition-all"
                    >
                      <Avatar avatar={target.avatar} name={target.name} size={46} />
                      <span className="text-xs font-black text-white truncate max-w-full">
                        {target.name}
                      </span>
                    </button>
                  ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Exit Confirmation Modal */}
      <AnimatePresence>
        {showExitConfirmation && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center bg-bg-dark/80 backdrop-blur-sm p-6"
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-bg-surface w-full max-w-sm rounded-2xl shadow-2xl p-6 text-center border border-border"
            >
              <h3 className="text-text-main font-bold text-lg mb-2 text-start">{t('alert')}</h3>
              <p className="text-text-muted text-base font-bold mb-8 text-start">
                {t('exitGameConfirmation')}
              </p>

              <div className="flex gap-4">
                <button
                  onClick={confirmExit}
                  className="flex-1 py-2.5 text-rose-400 font-bold hover:bg-rose-500/10 rounded-xl transition-colors"
                >
                  {t('leave')}
                </button>
                <button
                  onClick={() => setShowExitConfirmation(false)}
                  className="flex-1 py-2.5 text-text-main font-bold hover:bg-bg-card rounded-xl transition-colors"
                >
                  {t('stay')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}