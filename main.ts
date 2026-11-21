// sokoban-solver: a push-optimal Sokoban solver that answers a whole set in one run.
//
// Approach. Every level this generator draws is a hallway with one to four rooms
// off it, each room holding 3 or 4 boxes and as many goals, and a box pushed
// out of a room's door can never come back — so a level's push-optimal count
// is the sum of its rooms' optima, and the rooms solve independently. This
// program cuts the level into rooms, then solves each room on its own with an
// A* over pushes and concatenates the move strings, the player walking on from
// where the last room left it.
//
// A search state is the boxes' squares plus the player's reachable region
// (named by its lowest square): the player's exact square inside the region
// never matters, only which region it is in. The search expands states in
// order of pushes made so far plus a heuristic, the cheapest way to match the
// boxes to the goals by grid distance, which never overestimates (one push
// moves one box one square). It prunes positions no push can save: a box on
// a square from which no pull backwards reaches a goal, a box caught in a
// frozen 2 x 2 block of walls and boxes, and a box frozen against walls and
// boxes that can never move again. The first solved state the search pops is
// push-optimal, so a room solved this way costs its optimum, and the level
// costs the sum of its rooms' optima.
//
// Pure and deterministic: no clock, no randomness, no network, no environment
// read except the input and output directories the harness names. The search
// is bounded by states kept, never by time, so two runs write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up. */
const MAX_STATES = 250_000;

/** The four steps: dx, dy, the walk letter, the push letter. */
const DIRS = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** A level in XSB text: # wall, space floor, . goal, $ box, * box on a goal, @ player. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '#') continue;
      const i = y * w + x;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box alone can be pushed onto some goal: pull back
 * from the goals, a box at x having come from y when both y and the square
 * past it (where the player stood to push) are open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (y < 0 || y >= size) continue;
      const z = y - d;
      if (z < 0 || z >= size) continue;
      if (!wall[y] && !wall[z] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The level's rooms: cut the player's row where a box could never reach a
 * goal (the hallway), and each connected part left that holds a box is a
 * room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const c = squares[i];
      for (const { dx, dy } of DIRS) {
        const q = c + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` with `stamp`; returns the lowest square reached.
 */
function flood(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const size = wall.length;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    const up = p - w;
    const down = p + w;
    const left = p - 1;
    const right = p + 1;
    if (up >= 0 && !wall[up] && !occupied[up] && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    if (down < size && !wall[down] && !occupied[down] && seen[down] !== stamp) {
      seen[down] = stamp;
      stack[n++] = down;
    }
    if (left >= 0 && !wall[left] && !occupied[left] && seen[left] !== stamp) {
      seen[left] = stamp;
      stack[n++] = left;
    }
    if (right < size && !wall[right] && !occupied[right] && seen[right] !== stamp) {
      seen[right] = stamp;
      stack[n++] = right;
    }
  }
  return low;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(
  level: Level,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = level;
  const size = wall.length;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const { dx, dy, walk } of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

type SolveResult = { pushes: number; moves: string } | null;

/**
 * The push-optimal solution of `level`: an A* over pushes. A state is the
 * boxes' squares and the player's reachable region; the estimate is the
 * cheapest matching of boxes to goals by grid distance. Dead squares, frozen
 * 2 x 2 blocks and frozen boxes prune positions no push can save. Returns
 * null when the search gives up (or the level has no solution).
 */
function solvePushOptimal(level: Level, maxStates: number = MAX_STATES): SolveResult {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;
  if (level.boxes.every((b) => goalSet[b])) return { pushes: 0, moves: '' };

  // Grid distance from each goal over open floor, ignoring the boxes.
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      for (const { dx, dy } of DIRS) {
        const n = c + dy * w + dx;
        if (n < 0 || n >= size || wall[n] || d[n] !== -1) continue;
        d[n] = d[c] + 1;
        q.push(n);
      }
    }
    return d;
  });

  // The cheapest way to match these boxes to distinct goals. A push moves
  // one box one square, so no box needs fewer pushes than its matched
  // distance, and the sum never overestimates the pushes still needed.
  const heuristic = (boxes: number[]): number => {
    const n = boxes.length;
    if (n === 0) return 0;
    if (n > 6) {
      let s = 0;
      for (const b of boxes) {
        let m = Infinity;
        for (let j = 0; j < goals.length; j++) {
          const d = dist[j][b];
          if (d >= 0 && d < m) m = d;
        }
        if (m === Infinity) return Infinity;
        s += m;
      }
      return s;
    }
    let best = Infinity;
    const used = new Array<boolean>(n).fill(false);
    const assign = (i: number, cost: number): void => {
      if (cost >= best) return;
      if (i === n) {
        best = cost;
        return;
      }
      for (let j = 0; j < n; j++) {
        if (used[j]) continue;
        const d = dist[j][boxes[i]];
        if (d < 0) continue;
        used[j] = true;
        assign(i + 1, cost + d);
        used[j] = false;
      }
    };
    assign(0, 0);
    return best;
  };

  // Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls
  // and boxes with a box off its goal: no box in such a block can ever move,
  // since every push out of it needs the player to stand inside it.
  const frozenBlock = (occupied: Uint8Array, t: number): boolean => {
    for (const a of [t, t - 1, t - w, t - w - 1]) {
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if (a < 0 || d >= size) continue;
      if (!(wall[a] || occupied[a])) continue;
      if (!(wall[b] || occupied[b])) continue;
      if (!(wall[c] || occupied[c])) continue;
      if (!(wall[d] || occupied[d])) continue;
      if (occupied[a] && !goalSet[a]) return true;
      if (occupied[b] && !goalSet[b]) return true;
      if (occupied[c] && !goalSet[c]) return true;
      if (occupied[d] && !goalSet[d]) return true;
    }
    return false;
  };

  // Whether some box off its goal can never move again: a box is frozen when
  // every push out of it is blocked by a wall or a frozen box, in the target
  // square or the square the player would stand on. Computed as a fixed
  // point, starting with every box frozen and freeing the ones that can move.
  // `at` maps a square to its box index (or -1); reused across calls.
  const at = new Int32Array(size).fill(-1);
  const anyFrozenOffGoal = (boxes: number[], occupied: Uint8Array): boolean => {
    const n = boxes.length;
    const frozen = new Array<boolean>(n).fill(true);
    at.fill(-1);
    for (let i = 0; i < n; i++) at[boxes[i]] = i;
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) continue;
        const b = boxes[i];
        let canMove = false;
        for (const { dx, dy } of DIRS) {
          const d = dy * w + dx;
          const t = b + d;
          const s = b - d;
          if (t < 0 || t >= size || s < 0 || s >= size) continue;
          if (wall[t] || wall[s]) continue;
          if (occupied[t] && frozen[at[t]]) continue;
          if (occupied[s] && frozen[at[s]]) continue;
          canMove = true;
          break;
        }
        if (canMove) {
          frozen[i] = false;
          changed = true;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (frozen[i] && !goalSet[boxes[i]]) return true;
    }
    return false;
  };

  const keyOf = (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;

  // The states in the order found: their boxes, the player's square after the
  // push that made them, their parent, and the push that made them.
  const sBoxes: number[][] = [level.boxes.slice()];
  const sPlayer: number[] = [level.player];
  const sParent: number[] = [-1];
  const sPushFrom: number[] = [-1];
  const sPushTo: number[] = [-1];
  const sG: number[] = [0];
  const sKey: string[] = [];
  const best = new Map<string, number>();
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  for (const b of level.boxes) occupied[b] = 1;
  const low0 = flood(w, wall, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const key0 = keyOf(level.boxes, low0);
  sKey.push(key0);
  best.set(key0, 0);
  const h0 = heuristic(level.boxes);
  if (h0 === Infinity) return null;

  // A binary heap on [pushes + estimate, estimate, insertion order, state].
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const tmp = heap[i];
      heap[i] = heap[p];
      heap[p] = tmp;
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last !== undefined) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
        if (!heapLess(heap[c], heap[i])) break;
        const tmp = heap[i];
        heap[i] = heap[c];
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  };
  heapPush([h0, h0, seq++, 0]);

  let found = -1;
  while (heap.length > 0) {
    const entry = heapPop();
    const s = entry[3];
    if (best.get(sKey[s]) !== sG[s]) continue;
    const boxes = sBoxes[s];
    if (boxes.every((b) => goalSet[b])) {
      found = s;
      break;
    }
    const g = sG[s];
    for (const b of boxes) occupied[b] = 1;
    const region = ++stamp;
    flood(w, wall, occupied, sPlayer[s], seen, region, stack);
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi];
      for (const { dx, dy } of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        const from = b - d;
        if (t < 0 || t >= size || from < 0 || from >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[from] !== region) continue;
        const next = boxes.slice();
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        occupied[b] = 0;
        occupied[t] = 1;
        const dead = frozenBlock(occupied, t) || anyFrozenOffGoal(next, occupied);
        let key = '';
        let h = Infinity;
        if (!dead) {
          key = keyOf(next, flood(w, wall, occupied, b, mark, ++stamp, stack));
          const prev = best.get(key);
          if (prev === undefined || prev > g + 1) h = heuristic(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (dead || h === Infinity) continue;
        const prev = best.get(key);
        if (prev !== undefined && prev <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        best.set(key, g + 1);
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sPushFrom.push(b);
        sPushTo.push(t);
        sG.push(g + 1);
        sKey.push(key);
        heapPush([g + 1 + h, h, seq++, idx]);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  for (const s of path) {
    const from = sPushFrom[s];
    const to = sPushTo[s];
    const d = to - from;
    const dir = DIRS.find(({ dx, dy }) => dy * w + dx === d);
    if (dir === undefined) throw new Error('solvePushOptimal: no direction for a push');
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = sBoxes[s];
  }
  return { pushes: path.length, moves };
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level): SolveResult {
  const rooms = roomsOf(level);
  if (rooms === null) return solvePushOptimal(level);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push). */
function solve(text: string): string {
  const level = parseLevel(text);
  const result = solveByRooms(level);
  return result === null ? '' : result.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
