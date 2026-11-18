import { Player } from '../types';

export type WinningFaction = 'citizens' | 'undercover_solo' | 'mrwhite_solo' | 'both';

export const resolveWinningFaction = (
  players: Player[],
  roundWinner: 'impostor' | 'citizens' | 'fool' | null,
  winReason?: 'impostor_guessed' | 'citizens_wrong_vote' | 'impostor_caught' | 'fool_won' | string | null
): WinningFaction => {
  if (!roundWinner || roundWinner === 'citizens' || roundWinner === 'fool') {
    return 'citizens';
  }

  // When Mr. White guesses the secret word upon elimination, Mr. White wins solo
  if (winReason === 'impostor_guessed') {
    return 'mrwhite_solo';
  }

  const aliveMrWhite = players.some((p) => !p.isEliminated && p.role === 'mrwhite');
  const aliveUndercover = players.some((p) => !p.isEliminated && p.role === 'undercover');

  if (aliveMrWhite && aliveUndercover) {
    return 'both';
  }
  if (aliveMrWhite) {
    return 'mrwhite_solo';
  }
  if (aliveUndercover) {
    return 'undercover_solo';
  }

  // Fallback if evaluated manually with no alive flags distinguishing roles
  const hasMrWhite = players.some((p) => p.role === 'mrwhite');
  const hasUndercover = players.some((p) => p.role === 'undercover');
  if (hasMrWhite && hasUndercover) return 'both';
  if (hasMrWhite) return 'mrwhite_solo';
  return 'undercover_solo';
};

export const getPlayerRoundPoints = (
  player: Player,
  players: Player[],
  roundWinner: 'impostor' | 'citizens' | 'fool' | null,
  winReason?: 'impostor_guessed' | 'citizens_wrong_vote' | 'impostor_caught' | 'fool_won' | string | null,
  winningMrWhiteId?: number | null
): number => {
  if (!roundWinner) {
    return player.foolBonusAwarded ? 4 : 0;
  }

  let points = 0;
  const faction = resolveWinningFaction(players, roundWinner, winReason);

  if (faction === 'citizens') {
    if (player.role !== 'mrwhite' && player.role !== 'undercover') {
      points += 2;
    }
  } else if (winReason === 'impostor_guessed') {
    // Only the Mr. White who guessed the word earns +6; Undercovers earn 0
    const isGuesser =
      winningMrWhiteId !== null && winningMrWhiteId !== undefined
        ? player.id === winningMrWhiteId
        : !player.isEliminated && player.role === 'mrwhite';
    if (isGuesser) {
      points += 6;
    }
  } else if (faction === 'both') {
    // Surviving Mr. White wins without guessing (+12 double points); surviving Undercover gets +10
    if (!player.isEliminated && player.role === 'mrwhite') {
      points += 12;
    } else if (!player.isEliminated && player.role === 'undercover') {
      points += 10;
    }
  } else if (faction === 'mrwhite_solo') {
    // Surviving Mr. White wins solo without guessing (+12 double points); eliminated Undercover gets 0
    if (!player.isEliminated && player.role === 'mrwhite') {
      points += 12;
    }
  } else if (faction === 'undercover_solo') {
    // Surviving Undercover wins solo after Mr. White was eliminated (+10); eliminated Mr. White gets 0
    if (!player.isEliminated && player.role === 'undercover') {
      points += 10;
    }
  }

  if (player.foolBonusAwarded) {
    points += 4;
  }

  return points;
};
