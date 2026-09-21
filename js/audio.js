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

// ------------------------------------------------------------
// SAGE VOICE — mute toggle + transcripts + replay
// The sage's voice = welcome + all achievement_N lines. Sound effects
// (done / bin / optimizing / optimize_end) are NOT his voice and never mute.
// Transcripts below were machine-transcribed from the actual MP3s
// (faster-whisper base.en), then spot-checked by ear.
// ------------------------------------------------------------
const SAGE_MUTED_KEY = 'alchemySageMuted';
let sageMuted = false;

function loadSageMuted() {
  try { sageMuted = localStorage.getItem(SAGE_MUTED_KEY) === '1'; } catch (e) {}
}
function saveSageMuted() {
  try { localStorage.setItem(SAGE_MUTED_KEY, sageMuted ? '1' : '0'); } catch (e) {}
}
function isSageLine(key) {
  return key === 'welcome' || /^achievement_/.test(key);
}

const SAGE_LINES = [
  { key: 'welcome', count: null, label: 'Welcome (first visit)', text: 'The secrets of the alchemy art hold too much peril for the vulgar throng. Such concoctions disrupt the fabric of the worldly order. I bestow this tool upon you. Let profound wisdom guide your hand in its use.' },
  { key: 'achievement_1', count: 1, label: '1 pill', text: 'Have you just made your first pill? Congratulations young alchemist.' },
  { key: 'achievement_10', count: 10, label: '10 pills', text: "I strongly recommend that you do not exceed 10 pills. It's dangerous for the stomach." },
  { key: 'achievement_25', count: 25, label: '25 pills', text: "If you take all 25 pills at once, you'll get terrible diarrhea." },
  { key: 'achievement_50', count: 50, label: '50 pills', text: "I don't think I can stop your madness now. You'll probably cook another 50 pills." },
  { key: 'achievement_75', count: 75, label: '75 pills', text: '75 pills. Alchemy is a sacred meditation, not an assembly line. Are you even looking at the ingredients anymore?' },
  { key: 'achievement_100', count: 100, label: '100 pills', text: 'I swear, I created a monster. What are you trying to do with these 100 pills?' },
  { key: 'achievement_125', count: 125, label: '125 pills', text: '125 pills. I am officially revoking your title as a cultivator. You are a factory worker.' },
  { key: 'achievement_150', count: 150, label: '150 pills', text: '150 pills, I sent a pigeon to the demonic sect. Even they replied that your production rate is unethical.' },
  { key: 'achievement_175', count: 175, label: '175 pills', text: "If you consume all of these 175 pills, you won't ascend to the heavens. You will just explode and stain my floor." },
  { key: 'achievement_200', count: 200, label: '200 pills', text: '', missing: true },
  { key: 'achievement_225', count: 225, label: '225 pills', text: '225 pills. There is no profound doubt in this. You are just clicking and destroying the local flora.' },
  { key: 'achievement_250', count: 250, label: '250 pills', text: "The energy from those 250 pills is warping reality. I'm having hallucinations. Are you trying to start a drug trafficking operation?" },
  { key: 'achievement_275', count: 275, label: '275 pills', text: '275 pills. Cultivators are supposed to absorb the essence of nature gently. You are just aggressively hoarding it.' },
  { key: 'achievement_300', count: 300, label: '300 pills', text: '300 pills, even the cheapest brothels in the capital, don\u2019t push this many stimulants. What exactly is your end game here?' },
  { key: 'achievement_325', count: 325, label: '325 pills', text: 'If you swallow even a fraction of these 325 pills, your meridians won\u2019t just shatter. They will violently exit your body through your backside.' },
  { key: 'achievement_350', count: 350, label: '350 pills', text: '350 pills. If the Emperor\u2019s guards find this stash, I am telling them you held me hostage. I refuse to be beheaded because of your hoarding fetish.' },
  { key: 'achievement_375', count: 375, label: '375 pills', text: '375 pills. I\u2019ve seen men castrate themselves to achieve a pure cultivation state, and yet what you\u2019re doing here is somehow more pathetic.' },
  { key: 'achievement_400', count: 400, label: '400 pills', text: '400 pills. If you put half as much effort into finding a partner, as you do into clicking that cauldron, I wouldn\u2019t have to listen to the sound of your lonely grinding all night.' },
  { key: 'achievement_425', count: 425, label: '425 pills', text: '425 pills. The heavens haven\u2019t struck you with lightning yet because they\u2019re too busy laughing at how much time you\u2019re wasting.' },
  { key: 'achievement_450', count: 450, label: '450 pills', text: '450 pills. If the heavens ask, I never taught you. We never met. I am just a hallucination in your drug-addled mind.' },
  { key: 'achievement_475', count: 475, label: '475 pills', text: '475 pills. Just eat them all. Do it. Vomit your own organs. Rupture your core. And let me finally find a disciple who isn\u2019t a mindless degenerate.' },
  { key: 'achievement_500', count: 500, label: '500 pills', text: 'I think with those 500 pills you have enough to start a drug network. I wonder what would happen if you ate them all at once. But please don\u2019t do either of those things.' }
];

loadSageMuted();

// ---- Sage modal + mute button wiring (page may not exist in test sandbox) ----
function updateSageMuteBtn() {
  const btn = document.getElementById('sage-mute-btn');
  if (!btn) return;
  btn.textContent = sageMuted ? '\uD83D\uDD07 Sage muted' : '\uD83D\uDD0A Sage voice';
  btn.setAttribute('aria-pressed', sageMuted ? 'true' : 'false');
  btn.title = sageMuted ? 'Unmute the alchemy sage\u2019s voice lines' : 'Mute the alchemy sage\u2019s voice lines (sound effects stay on)';
}

function buildSageModal() {
  const wrap = document.getElementById('sage-lines');
  if (!wrap) return;
  wrap.textContent = '';
  const unlocked = new Set(unlockedAchievements);
  for (const line of SAGE_LINES) {
    const row = document.createElement('div');
    row.className = 'sage-line' + (unlocked.has(line.count) ? ' sage-line-unlocked' : '');

    const head = document.createElement('div');
    head.className = 'sage-line-head';
    const label = document.createElement('span');
    label.className = 'sage-line-label';
    label.textContent = (unlocked.has(line.count) ? '\u2713 ' : '') + line.label;
    head.appendChild(label);

    if (!line.missing) {
      const play = document.createElement('button');
      play.className = 'cx-btn sage-replay-btn';
      play.textContent = '\u25B6 Replay';
      play.title = 'Play this voice line now (works even when the sage is muted)';
      play.addEventListener('click', () => window.AudioController.replayLine(line.key));
      head.appendChild(play);
    } else {
      const miss = document.createElement('span');
      miss.className = 'sage-line-missing';
      miss.textContent = 'no recording in the original assets';
      head.appendChild(miss);
    }
    row.appendChild(head);

    const text = document.createElement('p');
    text.className = 'sage-line-text';
    text.textContent = line.missing
      ? 'The original game never shipped an MP3 for this milestone \u2014 the sage goes silent at exactly 200 pills.'
      : '\u201C' + line.text + '\u201D';
    row.appendChild(text);
    wrap.appendChild(row);
  }
}

function initSageUI() {
  const muteBtn = document.getElementById('sage-mute-btn');
  if (muteBtn) {
    updateSageMuteBtn();
    muteBtn.addEventListener('click', () => window.AudioController.toggleSageMuted());
  }
  const modal = document.getElementById('sage-modal');
  const openBtn = document.getElementById('sage-dialog-btn');
  const closeBtn = document.getElementById('sage-modal-close');
  if (openBtn && modal) {
    openBtn.addEventListener('click', () => { buildSageModal(); modal.hidden = false; });
  }
  if (closeBtn && modal) {
    closeBtn.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
  }
  if (modal) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
    });
  }
}
if (typeof document !== 'undefined' && document.addEventListener) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSageUI);
  else initSageUI();
}


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
  // Guarded: a quota-exceeded throw here (Safari private mode, full storage)
  // propagates into playDone → ui.js's togglePillDone BEFORE the inventory
  // deduction runs, so a pill would stay ticked with herbs never deducted.
  try {
    localStorage.setItem('alchemyAudioState', JSON.stringify({
      craftedCount: craftedCount,
      unlocked: Array.from(unlockedAchievements)
    }));
  } catch (e) {}
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

// Add sound to the sequential queue. `force` bypasses the sage mute —
// used by the voice-lines modal's Replay buttons so a muted player can
// still audition a line on demand.
function playQueued(key, force) {
  if (sageMuted && isSageLine(key) && !force) return;
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
  
  // When finished — OR when the element errors/stalls out mid-playback —
  // start the next one. 'ended' alone is not enough: a media error after
  // play() resolved fires 'error', never 'ended', and the play promise is
  // already resolved, so the catch below never runs → isQueuePlaying jams
  // forever and every later queued sound is silently dropped.
  const advance = () => {
    isQueuePlaying = false;
    a.onended = null;
    a.onerror = null;
    processQueue();
  };
  a.onended = advance;
  a.onerror = advance;
  
  a.play().catch(e => {
    console.warn(`Autoplay prevented for queued ${key}:`, e);
    isQueuePlaying = false;
    processQueue();
  });
}

// Expose the controller to the global scope for UI interactions
window.AudioController = {
  playWelcome: () => playQueued('welcome'),

  // ---- Sage voice controls ----
  isSageMuted: () => sageMuted,
  setSageMuted: (v) => {
    const wasMuted = sageMuted;
    sageMuted = !!v;
    saveSageMuted();
    // Muting must silence the sage NOW, not just gate future lines: pause
    // any in-flight sage line and drop already-queued sage lines. Without
    // this, clicking mute mid-line reads as "the button did not work".
    if (sageMuted && !wasMuted) {
      // Pause in-flight sage audio (welcome / achievement_*).
      for (const key of Object.keys(audios)) {
        if (!isSageLine(key)) continue;
        const a = audios[key];
        if (a && !a.paused) {
          // Detach the queue's onended first so pausing doesn't leave the
          // queue waiting on an 'ended' that never fires, then reset.
          a.onended = null;
          a.pause();
          a.currentTime = 0;
        }
      }
      // A paused line may have been the queue's current item; un-jam it.
      isQueuePlaying = false;
      // Purge already-queued sage lines (done/bin/optimize_end stay).
      for (let i = queue.length - 1; i >= 0; i--) {
        if (isSageLine(queue[i])) queue.splice(i, 1);
      }
      // If nothing sage is left playing/queued, normal SFX can proceed.
      processQueue();
    }
    updateSageMuteBtn();
  },
  toggleSageMuted: () => window.AudioController.setSageMuted(!sageMuted),

  // Replay one line out-of-queue, ignoring the mute (explicit user action).
  replayLine: (key) => {
    const a = getAudio(key);
    if (!a) return;
    a.currentTime = 0;
    a.play().catch(e => console.warn(`Autoplay prevented for replay ${key}:`, e));
  },

  getSageLines: () => SAGE_LINES.map(l => ({ ...l })),
  getUnlockedAchievements: () => new Set(unlockedAchievements),
  
  playBin: () => playInterruptible('bin'),
  
  // Same 'done' clip, but NOT a craft: OCR autofill and similar non-craft
  // confirmations must not push the lifetime craft counter toward milestones.
  playApplied: () => playInterruptible('done'),
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