// ============================================================
// AUDIO.JS — Audio Management System
// ============================================================

const AUDIO_FILES = {
  welcome: 'assets/welcome.mp3',
  bin: 'assets/bin.mp3',
  done: 'assets/done.mp3',
  optimizing: 'assets/optimizing.mp3',
  optimize_end: 'assets/optimize_end.mp3',
  achievement_1: 'assets/achievement_1.mp3',
  achievement_10: 'assets/achievement_10.mp3',
  achievement_25: 'assets/achievement_25.mp3',
  achievement_50: 'assets/achievement_50.mp3',
  achievement_75: 'assets/achievement_75.mp3',
  achievement_100: 'assets/achievement_100.mp3',
  achievement_125: 'assets/achievement_125.mp3',
  achievement_150: 'assets/achievement_150.mp3',
  achievement_175: 'assets/achievement_175.mp3',
  achievement_200: 'assets/achievement_200.mp3',
  achievement_225: 'assets/achievement_225.mp3',
  achievement_250: 'assets/achievement_250.mp3',
  achievement_275: 'assets/achievement_275.mp3',
  achievement_300: 'assets/achievement_300.mp3',
  achievement_325: 'assets/achievement_325.mp3',
  achievement_350: 'assets/achievement_350.mp3',
  achievement_375: 'assets/achievement_375.mp3',
  achievement_400: 'assets/achievement_400.mp3',
  achievement_425: 'assets/achievement_425.mp3',
  achievement_450: 'assets/achievement_450.mp3',
  achievement_475: 'assets/achievement_475.mp3',
  achievement_500: 'assets/achievement_500.mp3'
};

// Lazily-created <audio> elements, keyed exactly like AUDIO_FILES.
// They used to be constructed eagerly at parse time, which fired 26 media
// requests before the page had finished rendering — one of them for
// achievement_200.mp3, which is not in the repo, so every single page load
// logged a 404. Building them on first use costs nothing and means a missing
// asset degrades to silence instead of an error.
const audios = {};
const missingAudio = new Set();

function getAudio(key) {
  if (missingAudio.has(key)) return null;
  if (audios[key]) return audios[key];
  const path = AUDIO_FILES[key];
  if (!path) return null;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('error', () => {
    missingAudio.add(key);
    delete audios[key];
    console.warn(`Audio unavailable (skipping quietly): ${path}`);
  }, { once: true });
  a.src = path;
  if (key === 'optimizing') a.loop = true;
  audios[key] = a;
  return a;
}

const queue = [];
let isQueuePlaying = false;
let craftedCount = 0;
const achievements = [1, 10, 25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300, 325, 350, 375, 400, 425, 450, 475, 500];

// Tracks unlocked achievements
let unlockedAchievements = new Set(); 

// Load saved state from localStorage
function loadAudioState() {
  try {
    const saved = JSON.parse(localStorage.getItem('alchemyAudioState'));
    if (saved) {
      craftedCount = saved.craftedCount || 0;
      unlockedAchievements = new Set(saved.unlocked || []);
    }
  } catch (e) { 
    console.warn("Audio state corrupt", e); 
  }
}

// Save state to localStorage
function saveAudioState() {
  localStorage.setItem('alchemyAudioState', JSON.stringify({
    craftedCount: craftedCount,
    unlocked: Array.from(unlockedAchievements)
  }));
}

// Init state on load
loadAudioState();

// Play sound immediately, resetting to start if spammed (Interruptible)
function playInterruptible(key) {
  const a = getAudio(key);
  if (!a) return;
  a.currentTime = 0;
  a.play().catch(e => console.warn(`Autoplay prevented for ${key}:`, e));
}

// Add sound to the sequential queue
function playQueued(key) {
  queue.push(key);
  processQueue();
}

// Process the queue one by one to prevent overlaps
function processQueue() {
  if (isQueuePlaying || queue.length === 0) return;
  
  isQueuePlaying = true;
  const key = queue.shift();
  const a = getAudio(key);
  
  if (!a) {
    isQueuePlaying = false;
    processQueue();
    return;
  }

  a.currentTime = 0;
  
  // When finished, start the next one
  a.onended = () => {
    isQueuePlaying = false;
    a.onended = null;
    processQueue();
  };
  
  a.play().catch(e => {
    console.warn(`Autoplay prevented for queued ${key}:`, e);
    isQueuePlaying = false;
    processQueue();
  });
}

// Expose the controller to the global scope for UI interactions
window.AudioController = {
  playWelcome: () => playQueued('welcome'),
  
  playBin: () => playInterruptible('bin'),
  
  playDone: () => {
    playInterruptible('done');
    craftedCount++;
    
    // Check if milestone is reached AND not already unlocked
    if (achievements.includes(craftedCount) && !unlockedAchievements.has(craftedCount)) {
      unlockedAchievements.add(craftedCount);
      playQueued(`achievement_${craftedCount}`);
    }
    
    saveAudioState();
  },

  decrementCraftCount: () => {
    craftedCount = Math.max(0, craftedCount - 1);
    saveAudioState();
  },

  // Resets the RUNNING craft counter only. It used to clear
  // `unlockedAchievements` too, which meant the "Clear Recipes" button
  // silently wiped every milestone the player had ever reached — a lifetime
  // record destroyed by a button whose job is to empty a results list.
  resetState: () => {
    craftedCount = 0;
    saveAudioState();
  },
  
  startOptimizing: () => {
    const a = getAudio('optimizing');
    if (!a) return;
    a.currentTime = 0;
    a.play().catch(e => console.warn('Autoplay prevented for optimizing:', e));
  },
  
  stopOptimizing: () => {
    const a = audios['optimizing'];   // only stop what was actually started
    if (!a) return;
    a.pause();
    a.currentTime = 0;
  },
  
  playOptimizeEnd: () => {
    window.AudioController.stopOptimizing();
    
    const endAudio = getAudio('optimize_end');
    // endAudio is null when the asset is missing — v3 dereferenced it blind and
    // would have thrown on every optimise.
    const isPlayingRightNow = !!endAudio && !endAudio.paused
      && endAudio.currentTime > 0 && !endAudio.ended;
    const isAlreadyQueued = queue.includes('optimize_end');

    if (!isPlayingRightNow && !isAlreadyQueued) {
      playQueued('optimize_end');
    }
  }
};