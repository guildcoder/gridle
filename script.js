// Gridle — script.js
// Mobile-first daily Tron-style challenge with deterministic daily seed,
// local caching of streaks, emoji share, and countdown until next UTC day.

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

const playBtn = document.getElementById('playBtn');
const messageEl = document.getElementById('message');
const levelDisplay = document.getElementById('levelDisplay');
const streakCountEl = document.getElementById('streakCount');
const timerEl = document.getElementById('timer');
const countdownView = document.getElementById('countdownView');
const countdownClock = document.getElementById('countdownClock');
const shareCountdownBtn = document.getElementById('shareCountdown');

const arrows = document.querySelectorAll('#controls .arrow');

let gameLoopHandle = null;
let lastTick = 0;
let running = false;
let startTime = 0;
let elapsedMs = 0;

let CELL = 14; // base pixel size; will adapt
let COLS = 20;
let ROWS = 36;

let trails;
let player;
let bots = [];
let seedState;
let fps = 18;
let dayKeyString; // today's seed key (UTC date)
let challengeConfig;

// Storage keys
const STORAGE_PREFIX = 'gridle:';
const STREAK_KEY = STORAGE_PREFIX + 'streak';
const LAST_WIN_KEY = STORAGE_PREFIX + 'lastWinDate';
const DAY_CACHE_KEY = STORAGE_PREFIX + 'dayChallenge'; // stores today's challenge (seed/config)

// ---------- Utility: deterministic RNG (mulberry32) ----------
function mulberry32(a) {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
}

function hashStringToInt(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------- Date / daily seed ----------
function getUTCDateString(date = new Date()) {
  // Use UTC YYYY-MM-DD to ensure same challenge worldwide per UTC day.
  return date.getUTCFullYear() + '-' + String(date.getUTCMonth() + 1).padStart(2, '0') + '-' + String(date.getUTCDate()).padStart(2, '0');
}

function getNextUTCMidnightMs() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.getTime();
}

// ---------- Challenge generator ----------
function makeDailyChallenge(dateStr) {
  // If stored in localStorage for offline repeatability, use that.
  const cached = localStorage.getItem(DAY_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.date === dateStr) return parsed;
    } catch(e){}
  }

  const seedInt = hashStringToInt('GRIDLE|' + dateStr);
  const rnd = mulberry32(seedInt);

  // choose grid size (cols x rows) biased for vertical: pick cols 12-20, rows 24-48
  const cols = Math.floor(12 + Math.floor(rnd()*9)); // 12..20
  const rows = Math.floor(24 + Math.floor(rnd()*25)); // 24..48

  // number of bots depends on cols*rows and random small
  const area = cols * rows;
  const bots = Math.max(1, Math.min(8, Math.floor(rnd() * 6) + Math.floor(area / 240)));
  // initial speed (fps)
  const baseFps = Math.floor(14 + rnd()*8); // 14 .. 21

  const config = {
    date: dateStr,
    seedInt,
    cols,
    rows,
    bots,
    baseFps
  };

  localStorage.setItem(DAY_CACHE_KEY, JSON.stringify(config));
  return config;
}

// ---------- Game Entities ----------
class Bike {
  constructor(x, y, color, dir, isPlayer=false) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.dir = dir; // 'UP' 'DOWN' 'LEFT' 'RIGHT'
    this.isPlayer = isPlayer;
    this.alive = true;
    this.trailColor = color;
  }

  move() {
    if (!this.alive) return;

    switch (this.dir) {
      case 'UP': this.y--; break;
      case 'DOWN': this.y++; break;
      case 'LEFT': this.x--; break;
      case 'RIGHT': this.x++; break;
    }

    // collision
    if (this.x < 0 || this.x >= COLS || this.y < 0 || this.y >= ROWS) {
      this.alive = false; return;
    }
    if (trails[this.y][this.x]) { // collision with any trail
      this.alive = false; return;
    }
    trails[this.y][this.x] = this.trailColor;
  }

  draw(cellSize) {
    if (!this.alive) return;
    const px = this.x * cellSize;
    const py = this.y * cellSize;
    ctx.fillStyle = this.color;
    ctx.shadowBlur = 12;
    ctx.shadowColor = this.color;
    ctx.fillRect(px, py, cellSize, cellSize);
    ctx.shadowBlur = 0;
  }
}

// ---------- AI helpers ----------
function turnLeft(dir) {
  return dir === 'UP' ? 'LEFT' : dir === 'LEFT' ? 'DOWN' : dir === 'DOWN' ? 'RIGHT' : 'UP';
}
function turnRight(dir) {
  return dir === 'UP' ? 'RIGHT' : dir === 'RIGHT' ? 'DOWN' : dir === 'DOWN' ? 'LEFT' : 'UP';
}

function botDecide(bot, rnd) {
  // very simple lookahead: if cell in front is occupied or out-of-bounds, try left/right; else small chance to random turn
  if (!bot.alive) return;
  let nx = bot.x, ny = bot.y;
  switch (bot.dir) {
    case 'UP': ny--; break;
    case 'DOWN': ny++; break;
    case 'LEFT': nx--; break;
    case 'RIGHT': nx++; break;
  }
  const blocked = nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS || trails[ny][nx];

  if (blocked) {
    // try left, right, straight in that order
    const options = [turnLeft(bot.dir), turnRight(bot.dir)];
    for (let d of options) {
      let tx = bot.x, ty = bot.y;
      if (d === 'UP') ty--; if (d === 'DOWN') ty++; if (d === 'LEFT') tx--; if (d === 'RIGHT') tx++;
      if (tx >= 0 && tx < COLS && ty >= 0 && ty < ROWS && !trails[ty][tx]) {
        bot.dir = d; break;
      }
    }
  } else {
    // small random turn chance
    if (rnd() < 0.03) {
      bot.dir = rnd() < 0.5 ? turnLeft(bot.dir) : turnRight(bot.dir);
    }
  }
}

// ---------- Rendering helpers ----------
function clearScreen() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0,0,canvas.width,canvas.height);
}

function drawGrid(cellSize) {
  ctx.strokeStyle = '#0b1014';
  ctx.lineWidth = 1;
  for (let x=0;x<=COLS;x++){
    const px = x*cellSize;
    ctx.beginPath(); ctx.moveTo(px,0); ctx.lineTo(px,canvas.height); ctx.stroke();
  }
  for (let y=0;y<=ROWS;y++){
    const py = y*cellSize;
    ctx.beginPath(); ctx.moveTo(0,py); ctx.lineTo(canvas.width,py); ctx.stroke();
  }
}

function drawTrails(cellSize) {
  for (let r=0;r<ROWS;r++){
    for (let c=0;c<COLS;c++){
      const col = trails[r][c];
      if (col) {
        ctx.fillStyle = col;
        ctx.shadowBlur = 10;
        ctx.shadowColor = col;
        ctx.fillRect(c*cellSize, r*cellSize, cellSize, cellSize);
        ctx.shadowBlur = 0;
      }
    }
  }
}

// ---------- Colors ----------
const COLOR_LIST = ['#f44336','#ffd600','#00e676','#00e5ff','#d500f9','#ff6d00','#29b6f6'];

function pickColor(rnd) {
  return COLOR_LIST[Math.floor(rnd()*COLOR_LIST.length)];
}

// ---------- Setup / init ----------
function adaptCanvasToDevice(cols, rows) {
  // canvas width equals container width; height based on rows/cols to keep cell square
  const containerWidth = Math.min(window.innerWidth - 28, 480);
  // compute cell size so that grid fits vertically (with some headroom for controls)
  const maxCanvasHeight = Math.max(window.innerHeight - 260, 360);
  const cellSizeH = Math.floor((maxCanvasHeight) / rows);
  const cellSizeW = Math.floor(containerWidth / cols);
  const cellSize = Math.max(8, Math.min(cellSizeH, cellSizeW)); // min cell size for visibility
  canvas.width = cols * cellSize;
  canvas.height = rows * cellSize;
  canvas.style.width = (canvas.width) + 'px';
  canvas.style.height = (canvas.height) + 'px';
  return cellSize;
}

function resetEntities(config) {
  // create trails grid
  trails = Array.from({length: ROWS}, ()=>Array(COLS).fill(null));
  bots = [];

  // seeded RNG for placements and colors
  const rnd = mulberry32(config.seedInt);

  // Player spawns near top center-ish
  const px = Math.floor(COLS * 0.3);
  const py = Math.floor(ROWS * 0.18);
  player = new Bike(px, py, '#00f3ff', 'RIGHT', true);
  trails[player.y][player.x] = player.trailColor;

  // Spawn bots at varied spots far from player
  const spawnPositions = [];
  for (let i=0;i<config.bots;i++){
    // attempt to find a spot far from player
    let attempts = 0;
    while (attempts++ < 200) {
      const bx = Math.floor(rnd()*(COLS-4)) + 2;
      const by = Math.floor(rnd()*(ROWS-8)) + Math.floor(ROWS*0.45);
      const dist = Math.hypot(bx - player.x, by - player.y);
      if (dist > Math.max(COLS, ROWS)/3 && !trails[by][bx]) {
        // avoid crowding previous bot
        let ok = true;
        for (const p of spawnPositions) if (Math.hypot(bx-p.x, by-p.y) < 6) ok = false;
        if (!ok) continue;
        spawnPositions.push({x:bx,y:by});
        break;
      }
    }
  }

  // set directional bias: heading left or up depending on position
  for (let i=0;i<spawnPositions.length;i++){
    const p = spawnPositions[i];
    const dir = (p.x > COLS/2) ? 'LEFT' : 'UP';
    const color = pickColor(rnd);
    const b = new Bike(p.x,p.y,color,dir,false);
    trails[b.y][b.x] = b.trailColor;
    bots.push(b);
  }
}

// ---------- Game loop ----------
function startGameForDate(dateStr) {
  // load or compute challenge config
  challengeConfig = makeDailyChallenge(dateStr);
  // set grid sizes
  COLS = challengeConfig.cols;
  ROWS = challengeConfig.rows;
  fps = challengeConfig.baseFps;

  // adapt canvas
  CELL = adaptCanvasToDevice(COLS, ROWS);

  // seed used for bot AI determinism per step
  seedState = mulberry32(challengeConfig.seedInt);

  resetEntities(challengeConfig);

  levelDisplay.innerText = `Grid ${COLS}×${ROWS} • Opponents ${challengeConfig.bots}`;

  running = true;
  startTime = performance.now();
  elapsedMs = 0;
  lastTick = performance.now();
  messageEl.classList.add('hidden');
  playBtn.disabled = true;

  // ensure countdown view hidden
  countdownView.classList.add('hidden');
  document.getElementById('gameArea').classList.remove('hidden');

  // begin loop
  if (gameLoopHandle) cancelAnimationFrame(gameLoopHandle);
  gameLoopHandle = requestAnimationFrame(gameLoop);
}

function endGame(won) {
  running = false;
  playBtn.disabled = false;
  if (won) {
    messageEl.innerText = `You Win! ✓`;
    messageEl.classList.remove('hidden');
    handleVictory();
  } else {
    messageEl.innerText = `Game Over`;
    messageEl.classList.remove('hidden');
  }
  // after a short delay show countdown and share button
  setTimeout(()=>showCountdownView(), 800);
}

function gameLoop(now) {
  gameLoopHandle = requestAnimationFrame(gameLoop);

  if (!running) return;
  const dt = now - lastTick;
  if (dt < (1000 / fps)) return;
  lastTick = now;

  // update elapsed time
  elapsedMs = now - startTime;
  timerEl.innerText = formatTime(elapsedMs);

  // clear and draw
  clearScreen();
  drawGrid(CELL);
  drawTrails(CELL);

  // player and bots act
  // player movement already set by controls; move
  player.move();

  // deterministic rnd for this tick
  const rnd = seedState;

  // bots decide
  for (let b of bots) {
    botDecide(b, rnd);
  }

  // move bots
  for (let b of bots) b.move();

  // draw
  player.draw(CELL);
  for (let b of bots) b.draw(CELL);

  // check win/lose conditions
  if (!player.alive) {
    endGame(false);
    return;
  }
  if (bots.length > 0 && bots.every(b => !b.alive)) {
    endGame(true);
    return;
  }
}

// ---------- Controls ----------
function setPlayerDir(dir) {
  if (!player || !player.alive) return;
  // prevent 180-degree turn
  if (dir === 'UP' && player.dir === 'DOWN') return;
  if (dir === 'DOWN' && player.dir === 'UP') return;
  if (dir === 'LEFT' && player.dir === 'RIGHT') return;
  if (dir === 'RIGHT' && player.dir === 'LEFT') return;
  player.dir = dir;
}

arrows.forEach(btn=>{
  btn.addEventListener('touchstart', (e)=>{
    e.preventDefault();
    const dir = btn.dataset.dir;
    setPlayerDir(dir);
  }, {passive:false});
  btn.addEventListener('mousedown', (e)=>{
    const dir = btn.dataset.dir;
    setPlayerDir(dir);
  });
});

// swipe support
let touchStart = null;
canvas.addEventListener('touchstart', (e)=>{
  touchStart = e.touches[0];
}, {passive:true});
canvas.addEventListener('touchend', (e)=>{
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.clientX;
  const dy = t.clientY - touchStart.clientY;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > 20) setPlayerDir('RIGHT'); else if (dx < -20) setPlayerDir('LEFT');
  } else {
    if (dy > 20) setPlayerDir('DOWN'); else if (dy < -20) setPlayerDir('UP');
  }
  touchStart = null;
}, {passive:true});

// keyboard arrows
window.addEventListener('keydown', (e)=>{
  if (!player || !player.alive) return;
  switch(e.key){
    case 'ArrowUp': setPlayerDir('UP'); break;
    case 'ArrowDown': setPlayerDir('DOWN'); break;
    case 'ArrowLeft': setPlayerDir('LEFT'); break;
    case 'ArrowRight': setPlayerDir('RIGHT'); break;
  }
});

// ---------- Formatting ----------
function formatTime(ms) {
  const s = Math.floor(ms/1000);
  const mm = Math.floor(s/60).toString().padStart(2,'0');
  const ss = (s%60).toString().padStart(2,'0');
  const ms3 = Math.floor(ms%1000).toString().padStart(3,'0');
  return `${mm}:${ss}.${ms3}`;
}

// ---------- Streak & local caching ----------
function loadStreak() {
  const s = parseInt(localStorage.getItem(STREAK_KEY) || '0', 10);
  streakCountEl.innerText = s;
  return s;
}

function saveStreak(val) {
  localStorage.setItem(STREAK_KEY, String(val));
  streakCountEl.innerText = val;
}

/*
Victory handling:
- Only allow one win per UTC day to increment streak.
- lastWinDate stored in UTC YYYY-MM-DD string.
*/
function handleVictory() {
  const today = getUTCDateString();
  const lastWin = localStorage.getItem(LAST_WIN_KEY);
  if (lastWin === today) {
    // already counted today
    // show share immediately
    showShare();
    return;
  }

  // increment streak if previous day was yesterday
  const prevDate = new Date();
  prevDate.setUTCDate(prevDate.getUTCDate() - 1);
  const prevDateStr = getUTCDateString(prevDate);

  let streak = loadStreak();
  if (lastWin === prevDateStr) {
    streak = streak + 1;
  } else {
    streak = 1;
  }
  saveStreak(streak);
  localStorage.setItem(LAST_WIN_KEY, today);
  // store small win data (time)
  localStorage.setItem(STORAGE_PREFIX + 'lastWinMs', String(elapsedMs));
  showShare();
}

// ---------- Emoji share ----------
function colorToEmoji(col) {
  // map basic colors to colored square emojis, fallback to black
  if (!col) return '⬛';
  const map = {
    '#f44336': '🟥',
    '#ffd600': '🟨',
    '#00e676': '🟩',
    '#00e5ff': '🟦',
    '#d500f9': '🟪',
    '#ff6d00': '🟧',
    '#29b6f6': '🟦',
    '#00f3ff': '🟦',
    '#fff': '⬜'
  };
  // find nearest by string equality
  return map[col.toLowerCase()] || '🟫';
}

function makeEmojiMap() {
  // create an emoji grid representation of the trails (only show occupied cells)
  const rows = [];
  for (let r=0;r<ROWS;r++){
    let line = '';
    for (let c=0;c<COLS;c++){
      const col = trails[r][c];
      if (player && player.x === c && player.y === r && player.alive) {
        line += '🔷'; // player marker
      } else if (col) {
        line += colorToEmoji(col);
      } else {
        line += '⬛';
      }
    }
    rows.push(line);
  }
  return rows.join('\n');
}

async function shareResultToClipboard(won) {
  const timeStr = formatTime(elapsedMs);
  const gridEmoji = makeEmojiMap();
  const today = getUTCDateString();
  const streak = loadStreak();
  const text = `Gridle ${today} — ${COLS}×${ROWS} • Opponents ${challengeConfig.bots}\nResult: ${won ? 'Win' : 'Lose'} • Time: ${timeStr} • Streak: ${streak}\n\n${gridEmoji}`;
  try {
    await navigator.clipboard.writeText(text);
    alert('Share copied to clipboard — paste where you like!');
  } catch (e) {
    // fallback
    prompt('Copy your result (Ctrl+C):', text);
  }
}

function showShare() {
  // show share dialog overlay (simple)
  const shareBtn = document.createElement('button');
  shareBtn.innerText = 'Copy Result';
  shareBtn.className = 'primary';
  shareBtn.addEventListener('click', ()=>shareResultToClipboard(true));
  messageEl.innerHTML = '';
  messageEl.appendChild(document.createTextNode('You Win!'));
  messageEl.appendChild(document.createElement('br'));
  messageEl.appendChild(shareBtn);
  messageEl.classList.remove('hidden');
}

// ---------- Countdown view ----------
function showCountdownView() {
  // show countdown (time until next UTC midnight)
  document.getElementById('gameArea').classList.add('hidden');
  countdownView.classList.remove('hidden');
  updateCountdownClock();
  // also set share button for visual share (copies summary)
  shareCountdownBtn.onclick = async ()=>{
    const now = new Date();
    const timeLeftMs = getNextUTCMidnightMs() - now.getTime();
    const hours = Math.floor(timeLeftMs/3600000);
    const mins = Math.floor((timeLeftMs%3600000)/60000);
    const secs = Math.floor((timeLeftMs%60000)/1000);
    const text = `Gridle next challenge in ${hours}h ${mins}m ${secs}s — come play!`;
    try { await navigator.clipboard.writeText(text); alert('Countdown copied to clipboard'); }
    catch(e){ prompt('Copy this to share:', text); }
  };
}

function updateCountdownClock() {
  const now = new Date();
  const msLeft = getNextUTCMidnightMs() - now.getTime();
  if (msLeft <= 0) {
    // reload to new day automatically
    window.location.reload();
    return;
  }
  const hours = String(Math.floor(msLeft / 3600000)).padStart(2,'0');
  const mins = String(Math.floor((msLeft % 3600000) / 60000)).padStart(2,'0');
  const secs = String(Math.floor((msLeft % 60000) / 1000)).padStart(2,'0');
  countdownClock.innerText = `${hours}:${mins}:${secs}`;
  // update again in 1s
  setTimeout(updateCountdownClock, 900);
}

// ---------- UI wiring ----------
playBtn.addEventListener('click', ()=>{
  const today = getUTCDateString();
  startGameForDate(today);
});

document.getElementById('btnCenter').addEventListener('click', ()=>{
  // center button toggles pause / resume or shows countdown
  if (running) {
    running = false;
    messageEl.innerText = 'Paused';
    messageEl.classList.remove('hidden');
    playBtn.disabled = false;
  } else {
    // resume by starting a fresh loop if player alive
    if (player && player.alive) {
      running = true;
      messageEl.classList.add('hidden');
      lastTick = performance.now();
      startTime = performance.now() - elapsedMs;
      gameLoopHandle = requestAnimationFrame(gameLoop);
    } else {
      // show countdown if no active game
      showCountdownView();
    }
  }
});

// countdown view toggle from header double-tap
document.getElementById('header').addEventListener('dblclick', ()=>showCountdownView());

// initial load
(function init() {
  // show today's cached streak
  loadStreak();

  // show quick instructions in message
  messageEl.innerText = 'Press Play to start the daily Gridle\nUse arrows or swipe to control';
  messageEl.classList.remove('hidden');

  // if user previously started today, allow resume
  const today = getUTCDateString();
  const cached = localStorage.getItem(DAY_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed.date === today) {
        // offer quick resume by enabling play immediately
        // we won't auto-start to prevent surprises; user can press Play
      } else {
        // new day — clear local trail cache to avoid confusion
        // but still keep streaks
      }
    } catch(e){}
  }

  // attach a resize listener to adapt canvas
  window.addEventListener('resize', ()=>{
    if (challengeConfig) {
      CELL = adaptCanvasToDevice(COLS, ROWS);
      // redraw static elements
    }
  });

  // countdown occasionally update
  setInterval(()=>{
    // update timer display if running
    if (!running) {
      // show time until next UTC reset on footer timer
      const msLeft = getNextUTCMidnightMs() - Date.now();
      const h = Math.floor(msLeft/3600000);
      const m = Math.floor((msLeft%3600000)/60000);
      timerEl.innerText = `Next: ${h}h ${m}m`;
    }
  }, 5000);
})();
