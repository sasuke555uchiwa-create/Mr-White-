// Force recompile: 2
const PLAYERS_KEY = 'chkoun_barra_recent_players';
const SCORES_KEY = 'chkoun_barra_scores';
const SETTINGS_KEY = 'chkoun_barra_settings';
const HIDDEN_WORDS_KEY = 'chkoun_barra_hidden_words';
const CUSTOM_WORDS_KEY = 'chkoun_barra_custom_words';
const CUSTOM_CATEGORIES_KEY = 'chkoun_barra_custom_categories';
const INVENTORY_KEY = 'chkoun_barra_inventory';

export interface AppSettings {
  soundVolume: number; // 0.0 to 1.0
  hapticEnabled: boolean;
  language: string; 
  theme: 'dark' | 'gray' | 'light' | 'system';
  buttonColor?: 'default' | 'blue' | 'green' | 'red' | 'purple' | 'orange';
  avatar?: string;
  isAdmin?: boolean;
}

export interface CustomWordPair {
  id: string;
  word1: string;
  word2: string;
  language: string;
  category: string;
}

export interface RecentPlayer {
  name: string;
  avatar: string;
  isSleeping?: boolean;
}

export interface CustomCategory {
  id: string;
  name: string;
  icon: string;
  color: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  soundVolume: 1.0,
  hapticEnabled: true,
  language: 'ar',
  theme: 'dark',
  buttonColor: 'default',
  avatar: '👤',
  isAdmin: false
};

export const getRecentPlayers = (): RecentPlayer[] => {
  try {
    const stored = localStorage.getItem(PLAYERS_KEY);
    if (!stored) return [];
    
    const parsed = JSON.parse(stored);
    
    // Migration: Check if it's the old string array format
    if (Array.isArray(parsed) && parsed.length > 0) {
        if (typeof parsed[0] === 'string') {
            // Convert old string array to object array with default avatar
            return parsed.map((name: string) => ({ name, avatar: '👤' }));
        }
        return parsed as RecentPlayer[];
    }
    return [];
  } catch {
    return [];
  }
};

export const saveRecentPlayers = (players: RecentPlayer[]) => {
  // Get existing to preserve avatars if not provided (though we usually provide latest)
  const existing = getRecentPlayers();
  const map = new Map<string, RecentPlayer>();
  
  // Load existing
  existing.forEach(p => map.set(p.name, p));
  
  // Overwrite/Add new
  players.forEach(p => map.set(p.name, p));
  
  const unique = Array.from(map.values());
  localStorage.setItem(PLAYERS_KEY, JSON.stringify(unique));
};

export const overwriteRecentPlayers = (players: RecentPlayer[]) => {
  localStorage.setItem(PLAYERS_KEY, JSON.stringify(players));
};

export const getScores = (): Record<string, number> => {
  try {
    const stored = localStorage.getItem(SCORES_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
};

export const updatePlayerScore = (name: string, points: number) => {
  const scores = getScores();
  scores[name] = (scores[name] || 0) + points;
  localStorage.setItem(SCORES_KEY, JSON.stringify(scores));
};

export const resetScores = () => {
  localStorage.removeItem(SCORES_KEY);
};

export const clearAllData = () => {
  localStorage.removeItem(SCORES_KEY);
  localStorage.removeItem(PLAYERS_KEY);
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(HIDDEN_WORDS_KEY);
  localStorage.removeItem(CUSTOM_WORDS_KEY);
  localStorage.removeItem(CUSTOM_CATEGORIES_KEY);
  localStorage.removeItem(INVENTORY_KEY);
};

export const getSettings = (): AppSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const saveSettings = (settings: AppSettings) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

// --- Words Management ---

export const getHiddenWords = (): string[] => {
  try {
    const stored = localStorage.getItem(HIDDEN_WORDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const hideWord = (word: string) => {
  const hidden = getHiddenWords();
  if (!hidden.includes(word)) {
    hidden.push(word);
    localStorage.setItem(HIDDEN_WORDS_KEY, JSON.stringify(hidden));
  }
};

export const unhideWord = (word: string) => { // Optional, in case we want to restore
    let hidden = getHiddenWords();
    hidden = hidden.filter(w => w !== word);
    localStorage.setItem(HIDDEN_WORDS_KEY, JSON.stringify(hidden));
};

export const getCustomWordPairs = (): CustomWordPair[] => {
  try {
    const stored = localStorage.getItem(CUSTOM_WORDS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const saveCustomWordPair = (pair: CustomWordPair) => {
  const customs = getCustomWordPairs();
  customs.push(pair);
  localStorage.setItem(CUSTOM_WORDS_KEY, JSON.stringify(customs));
};

export const removeCustomWordPair = (id: string) => {
  let customs = getCustomWordPairs();
  customs = customs.filter(p => p.id !== id);
  localStorage.setItem(CUSTOM_WORDS_KEY, JSON.stringify(customs));
};

// --- Custom Categories Management ---

export const fetchCustomCategories = (): CustomCategory[] => { // Force reload
  try {
    const stored = localStorage.getItem(CUSTOM_CATEGORIES_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
};

export const saveCustomCategory = (cat: CustomCategory) => {
  const cats = fetchCustomCategories();
  const index = cats.findIndex(c => c.id === cat.id);
  
  if (index >= 0) {
      // Update existing
      cats[index] = cat;
  } else {
      // Add new
      cats.push(cat);
  }
  
  localStorage.setItem(CUSTOM_CATEGORIES_KEY, JSON.stringify(cats));
};

export const removeCustomCategory = (id: string) => {
  let cats = fetchCustomCategories();
  cats = cats.filter(c => c.id !== id);
  localStorage.setItem(CUSTOM_CATEGORIES_KEY, JSON.stringify(cats));
};

// --- Shop / Inventory Management ---

const LEGACY_PERK_ALIASES: Record<string, string> = {
  chechia: 'detective_badge',
  mint_tea: 'extra_time',
  mustache: 'spy_glasses',
  harissa: 'golden_dossier',
  gold_cup: 'master_crown',
};

export const getInventoryMap = (): Record<string, string[]> => {
  try {
    const stored = localStorage.getItem(INVENTORY_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Record<string, string[]>;
    const normalized: Record<string, string[]> = {};
    Object.entries(parsed).forEach(([player, items]) => {
      if (Array.isArray(items)) {
        normalized[player] = Array.from(
          new Set(
            items
              .filter((id) => id !== 'ad_block')
              .map((id) => LEGACY_PERK_ALIASES[id] || id)
          )
        );
      }
    });
    return normalized;
  } catch {
    return {};
  }
};

export const getPlayerInventory = (playerName: string): string[] => {
  const inv = getInventoryMap();
  return inv[playerName] || [];
};

export const hasPlayerPerk = (playerName: string, itemId: string): boolean => {
  return getPlayerInventory(playerName).includes(itemId);
};

export const addPlayerInventoryItem = (playerName: string, itemId: string): Record<string, string[]> => {
  const inv = getInventoryMap();
  const current = inv[playerName] || [];
  if (!current.includes(itemId)) {
    inv[playerName] = [...current, itemId];
    localStorage.setItem(INVENTORY_KEY, JSON.stringify(inv));
  }
  return inv;
};