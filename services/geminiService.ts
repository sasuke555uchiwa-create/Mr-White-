import { GameWordResponse } from "../types";
import { getSettings, getCustomWordPairs } from "./storageService";
import { WORD_PAIRS } from "../data/offlineData";

// This service now operates completely offline as requested.
// It replaces the Gemini API calls with a robust local database of word pairs.

export const getRandomWordPair = async (language?: string, category: string = 'standard'): Promise<{ civilianWord: string, undercoverWord: string, decoys: string[] }> => {
  const settings = getSettings();
  const lang = language || settings.language || 'ar';
  
  const langPairs = WORD_PAIRS[lang] || WORD_PAIRS['ar'];
  let pairs = [...(langPairs[category] || langPairs['standard'])];
  
  // Add custom words if applicable
  const customPairs = getCustomWordPairs().filter(p => p.language === lang && (category === 'standard' || p.category === category));
  customPairs.forEach(p => {
    pairs.push([p.word1, p.word2]);
  });
  
  // Pick a random pair
  const randomPair = pairs[Math.floor(Math.random() * pairs.length)];
  
  // Randomly swap to avoid word1 always being civilian
  const isSwapped = Math.random() > 0.5;
  const civilianWord = isSwapped ? randomPair[1] : randomPair[0];
  const undercoverWord = isSwapped ? randomPair[0] : randomPair[1];
  
  // Generate decoys (other words from the same language)
  const allWords = pairs.flat();
  const decoys = allWords
      .filter(w => w !== civilianWord && w !== undercoverWord)
      .sort(() => 0.5 - Math.random())
      .slice(0, 9);

  return {
      civilianWord,
      undercoverWord,
      decoys
  };
};

export const generateAvatar = async (userPrompt: string): Promise<string> => {
  // Return a placeholder avatar since we are offline
  // We can use a generated SVG string or a local asset pattern if we had one.
  // For now, a simple colored placeholder.
  const colors = ['#FF9F1C', '#FFBF69', '#CBF3F0', '#2EC4B6', '#FFFFFF'];
  const randomColor = colors[Math.floor(Math.random() * colors.length)];
  
  const svg = `
    <svg width="100" height="100" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="${randomColor}" />
      <text x="50" y="55" font-family="Arial" font-size="40" text-anchor="middle" fill="#333">👤</text>
    </svg>
  `;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
};
