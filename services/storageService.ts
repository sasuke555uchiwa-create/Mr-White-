const STORAGE_VERSION = 2;
const STORAGE_VERSION_KEY = 'chkoun_barra_schema_version';
const PLAYERS_KEY = 'chkoun_barra_recent_players';
const SCORES_KEY = 'chkoun_barra_scores';
const SETTINGS_KEY = 'chkoun_barra_settings';
const HIDDEN_WORDS_KEY = 'chkoun_barra_hidden_words';
const CUSTOM_WORDS_KEY = 'chkoun_barra_custom_words';
const CUSTOM_CATEGORIES_KEY = 'chkoun_barra_custom_categories';
const INVENTORY_KEY = 'chkoun_barra_inventory';

const ALLOWED_THEMES = ['dark', 'gray', 'light', 'system'] as const;
const ALLOWED_BUTTON_COLORS = ['default', 'blue', 'green', 'red', 'purple', 'orange'] as const;
const ALLOWED_LANGUAGES = ['ar', 'en', 'fr', 'es', 'de', 'tr', 'pt'] as const;

export interface AppSettings {
  soundVolume: number; // 0.0 to 1.0
  hapticEnabled: boolean;
  language: string;
  theme: 'dark' | 'gray' | 'light' | 'system';
  buttonColor?: 'default' | 'blue' | 'green' | 'red' | 'purple' | 'orange';
  avatar?: string;
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
};

const safeReadJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore quota/private-mode errors
    }
    return fallback;
  }
};

const safeWriteJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage write failed for key:', key, err);
  }
};

export const ensureStorageSchema = (): void => {
  try {
    const current = Number(localStorage.getItem(STORAGE_VERSION_KEY) || '0');
    if (current < STORAGE_VERSION) {
      // Strip legacy insecure client-side isAdmin field if present
      const rawSettings = safeReadJson<Record<string, unknown>>(SETTINGS_KEY, {});
      if ('isAdmin' in rawSettings) {
        delete rawSettings.isAdmin;
        safeWriteJson(SETTINGS_KEY, rawSettings);
      }
      localStorage.setItem(STORAGE_VERSION_KEY, String(STORAGE_VERSION));
    }
  } catch {
    // ignore
  }
};

ensureStorageSchema();

export const sanitizeSettings = (raw: unknown): AppSettings => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const vol = typeof obj.soundVolume === 'number' && Number.isFinite(obj.soundVolume)
    ? Math.min(1, Math.max(0, obj.soundVolume))
    : DEFAULT_SETTINGS.soundVolume;
  const haptic = typeof obj.hapticEnabled === 'boolean'
    ? obj.hapticEnabled
    : DEFAULT_SETTINGS.hapticEnabled;
  const language =
    typeof obj.language === 'string' && (ALLOWED_LANGUAGES as readonly string[]).includes(obj.language)
      ? obj.language
      : DEFAULT_SETTINGS.language;
  const theme =
    typeof obj.theme === 'string' && (ALLOWED_THEMES as readonly string[]).includes(obj.theme)
      ? (obj.theme as AppSettings['theme'])
      : DEFAULT_SETTINGS.theme;
  const buttonColor =
    typeof obj.buttonColor === 'string' &&
    (ALLOWED_BUTTON_COLORS as readonly string[]).includes(obj.buttonColor)
      ? (obj.buttonColor as AppSettings['buttonColor'])
      : DEFAULT_SETTINGS.buttonColor;
  const avatar =
    typeof obj.avatar === 'string' && obj.avatar.length <= 2048
      ? obj.avatar
      : DEFAULT_SETTINGS.avatar;

  return {
    soundVolume: vol,
    hapticEnabled: haptic,
    language,
    theme,
    buttonColor,
    avatar,
  };
};

export const getRecentPlayers = (): RecentPlayer[] => {
  const parsed = safeReadJson<unknown>(PLAYERS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((item): RecentPlayer | null => {
      if (typeof item === 'string' && item.trim()) {
        return { name: item.trim().slice(0, 40), avatar: '👤' };
      }
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.name === 'string' && rec.name.trim()) {
          return {
            name: rec.name.trim().slice(0, 40),
            avatar: typeof rec.avatar === 'string' ? rec.avatar : '👤',
            isSleeping: Boolean(rec.isSleeping),
          };
        }
      }
      return null;
    })
    .filter((p): p is RecentPlayer => p !== null);
};

export const saveRecentPlayers = (players: RecentPlayer[]) => {
  const existing = getRecentPlayers();
  const map = new Map<string, RecentPlayer>();

  existing.forEach((p) => map.set(p.name, p));
  players.forEach((p) => {
    if (p.name && p.name.trim()) {
      map.set(p.name.trim(), { ...p, name: p.name.trim().slice(0, 40) });
    }
  });

  safeWriteJson(PLAYERS_KEY, Array.from(map.values()));
};

export const overwriteRecentPlayers = (players: RecentPlayer[]) => {
  safeWriteJson(PLAYERS_KEY, players);
};

export const getScores = (): Record<string, number> => {
  const parsed = safeReadJson<unknown>(SCORES_KEY, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const clean: Record<string, number> = {};
  Object.entries(parsed as Record<string, unknown>).forEach(([name, score]) => {
    if (typeof score === 'number' && Number.isFinite(score) && score >= 0) {
      clean[name] = score;
    }
  });
  return clean;
};

export const updatePlayerScore = (name: string, points: number) => {
  if (!name || !Number.isFinite(points)) return;
  const scores = getScores();
  scores[name] = Math.max(0, (scores[name] || 0) + points);
  safeWriteJson(SCORES_KEY, scores);
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
  const stored = safeReadJson<unknown>(SETTINGS_KEY, null);
  return sanitizeSettings(stored);
};

export const saveSettings = (settings: AppSettings) => {
  safeWriteJson(SETTINGS_KEY, sanitizeSettings(settings));
};

// --- Words Management ---

export const getHiddenWords = (): string[] => {
  const parsed = safeReadJson<unknown>(HIDDEN_WORDS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((w): w is string => typeof w === 'string' && w.trim().length > 0);
};

export const hideWord = (word: string) => {
  const hidden = getHiddenWords();
  if (!hidden.includes(word)) {
    hidden.push(word);
    safeWriteJson(HIDDEN_WORDS_KEY, hidden);
  }
};

export const unhideWord = (word: string) => {
  const hidden = getHiddenWords().filter((w) => w !== word);
  safeWriteJson(HIDDEN_WORDS_KEY, hidden);
};

export const getCustomWordPairs = (): CustomWordPair[] => {
  const parsed = safeReadJson<unknown>(CUSTOM_WORDS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is CustomWordPair => {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return (
      typeof obj.id === 'string' &&
      typeof obj.word1 === 'string' &&
      typeof obj.word2 === 'string' &&
      typeof obj.language === 'string'
    );
  });
};

export const saveCustomWordPair = (pair: CustomWordPair) => {
  const customs = getCustomWordPairs();
  customs.push(pair);
  safeWriteJson(CUSTOM_WORDS_KEY, customs);
};

export const removeCustomWordPair = (id: string) => {
  const customs = getCustomWordPairs().filter((p) => p.id !== id);
  safeWriteJson(CUSTOM_WORDS_KEY, customs);
};

// --- Custom Categories Management ---

export const fetchCustomCategories = (): CustomCategory[] => {
  const parsed = safeReadJson<unknown>(CUSTOM_CATEGORIES_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is CustomCategory => {
    if (!item || typeof item !== 'object') return false;
    const obj = item as Record<string, unknown>;
    return typeof obj.id === 'string' && typeof obj.name === 'string';
  });
};

export const saveCustomCategory = (cat: CustomCategory) => {
  const cats = fetchCustomCategories();
  const index = cats.findIndex((c) => c.id === cat.id);
  if (index >= 0) {
    cats[index] = cat;
  } else {
    cats.push(cat);
  }
  safeWriteJson(CUSTOM_CATEGORIES_KEY, cats);
};

export const removeCustomCategory = (id: string) => {
  const cats = fetchCustomCategories().filter((c) => c.id !== id);
  safeWriteJson(CUSTOM_CATEGORIES_KEY, cats);
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
  const parsed = safeReadJson<unknown>(INVENTORY_KEY, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const normalized: Record<string, string[]> = {};
  Object.entries(parsed as Record<string, unknown>).forEach(([player, items]) => {
    if (Array.isArray(items)) {
      normalized[player] = Array.from(
        new Set(
          items
            .filter((id): id is string => typeof id === 'string' && id !== 'ad_block')
            .map((id) => LEGACY_PERK_ALIASES[id] || id)
        )
      );
    }
  });
  return normalized;
};

export const getPlayerInventory = (playerName: string): string[] => {
  const inv = getInventoryMap();
  return inv[playerName] || [];
};

export const hasPlayerPerk = (playerName: string, itemId: string): boolean => {
  return getPlayerInventory(playerName).includes(itemId);
};

export const addPlayerInventoryItem = (
  playerName: string,
  itemId: string
): Record<string, string[]> => {
  const inv = getInventoryMap();
  const current = inv[playerName] || [];
  if (!current.includes(itemId)) {
    inv[playerName] = [...current, itemId];
    safeWriteJson(INVENTORY_KEY, inv);
  }
  return inv;
};