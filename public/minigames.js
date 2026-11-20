// Mouse minigames are visual challenges; the server decides whether results apply.
const MAZE_PATH_RADIUS = 15;
const MAZE_TRAIL_DELAY_SECONDS = 1;
const MAZE_TRAIL_SPEED = 90;
const GATE_SPEED = 175;
const METEOR_SPEED_MULTIPLIER = 1.25;
const CHASING_GHOST_SPEED = 70;
const FINISH_MINIGAMES = new Set(["maze", "pacman", "routing"]);

class MouseMinigame {
  constructor(canvas, type, seconds, finish, onStart = () => {}, entrySeconds = null, difficulty = 0) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.type = type;
    this.seconds = seconds;
    this.entrySeconds = entrySeconds;
    this.difficulty = Math.max(0, Math.min(1, difficulty));
    this.finish = finish;
    this.onStart = onStart;
    this.started = performance.now();
    this.playStarted = null;
    this.pointer = null;
    this.ended = false;
    this.finishBased = FINISH_MINIGAMES.has(type);
    this.completedMazes = 0;
    this.completedRoutes = 0;
    this.mazeIndex = 0;
    this.createMaze({ x: 30, y: 120 });
    this.gaps = Array.from({ length: 4 }, () => 55 + Math.random() * 130);
    this.meteors = Array.from({ length: 18 }, (_, i) => ({
      x: 20 + Math.random() * 360,
      delay: i * 0.3,
      speed: (85 + Math.random() * 35) * METEOR_SPEED_MULTIPLIER,
    }));
    this.dots = Array.from({ length: 18 }, (_, i) => ({
      x: 28 + (i % 6) * 68,
      y: 30 + Math.floor(i / 6) * 80,
      taken: false,
    }));
    this.chasingGhost = { x: 200, y: 200 };
    this.createRoute();
    this.routeIndex = 0;
    this.onMove = this.onMove.bind(this);
    this.onDown = this.onDown.bind(this);
    canvas.addEventListener("pointerdown", this.onDown);
    window.addEventListener("pointermove", this.onMove);
  }

  createMaze(start) {
    const endX = start.x < 200 ? 370 : 30;
    const firstX = start.x + (endX - start.x) / 3;
    const secondX = start.x + (endX - start.x) * 2 / 3;
    const middleY = 45 + Math.random() * 150;
    const endY = 45 + Math.random() * 150;
    this.maze = [
      { ...start }, { x: firstX, y: start.y }, { x: firstX, y: middleY },
      { x: secondX, y: middleY }, { x: secondX, y: endY }, { x: endX, y: endY },
    ];
    this.mazeIndex = 0;
    this.mazeStarted = performance.now();
  }

  createRoute() {
    const cells = Array.from({ length: 18 }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    this.routeNodes = cells.slice(0, 6).map((cell) => ({
      x: 40 + (cell % 6) * 64 + (Math.random() * 20 - 10),
      y: 40 + Math.floor(cell / 6) * 80 + (Math.random() * 20 - 10),
    }));
  }

  eventPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * this.canvas.width / rect.width,
      y: (event.clientY - rect.top) * this.canvas.height / rect.height,
    };
  }

  onDown(event) {
    if (this.ended || this.playStarted !== null || event.button !== 0) return;
    if (this.remainingSeconds() <= 0) return this.end(false, this.timeoutReason());
    const position = this.eventPosition(event);
    if (position.x < 0 || position.x > this.canvas.width ||
        position.y < 0 || position.y > this.canvas.height) return;
    if (this.type === "maze") this.createMaze(position);
    if (this.type === "orbit") this.orbitOrigin = position;
    if (this.type === "scanner") this.scannerOrigin = position;
    this.pointer = position;
    this.beginPlaying();
  }

  onMove(event) {
    if (this.ended || this.playStarted === null) return;
    const next = this.eventPosition(event);
    if (this.type !== "maze") {
      next.x = Math.max(0, Math.min(this.canvas.width, next.x));
      next.y = Math.max(0, Math.min(this.canvas.height, next.y));
    }
    if (this.type === "maze") {
      const trail = this.mazeTrail(performance.now());
      if (this.onMazeTrail(this.pointer, trail)) {
        return this.end(false, "The red trail caught your cursor.");
      }
      const distance = Math.hypot(next.x - this.pointer.x, next.y - this.pointer.y);
      const steps = Math.max(1, Math.ceil(distance / 4));
      for (let i = 1; i <= steps; i++) {
        const point = {
          x: this.pointer.x + (next.x - this.pointer.x) * i / steps,
          y: this.pointer.y + (next.y - this.pointer.y) * i / steps,
        };
        if (!this.onMazePath(point)) return this.end(false, "Your cursor left the maze path.");
        if (this.onMazeTrail(point, trail)) return this.end(false, "Your cursor touched the red trail.");
        let target = this.maze[this.mazeIndex + 1];
        // The inside edge of a 30-pixel path can pass sqrt(2) * 15 from a corner.
        while (target && Math.hypot(point.x - target.x, point.y - target.y) <=
            (this.mazeIndex === this.maze.length - 2 ? 10 : Math.SQRT2 * 15)) {
          this.mazeIndex++;
          target = this.maze[this.mazeIndex + 1];
        }
      }
      this.pointer = next;
      if (this.mazeIndex === this.maze.length - 1) {
        if (++this.completedMazes === 2) return this.end(true);
        this.createMaze(next);
      }
    } else {
      this.pointer = next;
      if (this.type === "routing") {
        const target = this.routeNodes[this.routeIndex];
        if (target && Math.hypot(next.x - target.x, next.y - target.y) < 20) {
          this.routeIndex++;
          if (this.routeIndex >= this.routeNodes.length) {
            if (++this.completedRoutes === 2) return this.end(true);
            this.routeIndex = 0;
            this.createRoute();
          }
        }
      }
    }
  }

  beginPlaying() {
    if (this.playStarted !== null) return;
    this.playStarted = performance.now();
    this.ghostUpdatedAt = this.playStarted;
    this.onStart();
  }

  remainingSeconds(now = performance.now()) {
    if (this.entrySeconds !== null) {
      const started = this.playStarted === null ? this.started : this.playStarted;
      const limit = this.playStarted === null ? this.entrySeconds : this.seconds;
      return Math.max(0, limit - (now - started) / 1000);
    }
    return Math.max(0, this.seconds - (now - this.started) / 1000);
  }

  onMazePath(point) {
    return this.onMazeTrail(point, this.maze);
  }

  onMazeTrail(point, path) {
    return path.slice(1).some((end, i) => {
      const start = path[i];
      const dx = end.x - start.x, dy = end.y - start.y;
      const length = dx * dx + dy * dy;
      const t = length === 0 ? 0
        : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length));
      return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy) <= MAZE_PATH_RADIUS;
    });
  }

  mazeTrail(now) {
    const delay = MAZE_TRAIL_DELAY_SECONDS * (1 - this.difficulty * 0.6);
    let remaining = Math.max(0, (now - this.mazeStarted) / 1000 - delay) *
      MAZE_TRAIL_SPEED * (1 + this.difficulty);
    if (remaining === 0) return [];
    const trail = [this.maze[0]];
    for (let i = 1; i < this.maze.length; i++) {
      const start = this.maze[i - 1], end = this.maze[i];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      if (length > remaining) {
        trail.push({
          x: start.x + (end.x - start.x) * remaining / length,
          y: start.y + (end.y - start.y) * remaining / length,
        });
        break;
      }
      trail.push(end);
      remaining -= length;
      if (remaining === 0) break;
    }
    return trail;
  }

  timeoutReason() {
    return this.playStarted === null
      ? "Time ran out before you clicked to start."
      : "Time ran out before the challenge was completed.";
  }

  end(success, reason = "") {
    if (this.ended) return;
    this.ended = true;
    this.canvas.removeEventListener("pointerdown", this.onDown);
    window.removeEventListener("pointermove", this.onMove);
    this.finish(success, reason);
  }

  draw() {
    if (this.ended) return;
    const now = performance.now();
    if (this.playStarted === null && this.remainingSeconds(now) <= 0) return this.end(false, this.timeoutReason());
    if (this.playStarted !== null && !this.finishBased &&
        now - this.playStarted >= this.seconds * 1000) return;
    const elapsed = this.playStarted === null ? 0 : (now - this.playStarted) / 1000;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, 400, 240);
    if (this.playStarted === null) {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 16px Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("CLICK ANYWHERE TO START", this.canvas.width / 2, this.canvas.height / 2);
      return;
    }
    if (this.type === "maze") {
      const trail = this.mazeTrail(now);
      if (this.pointer && this.onMazeTrail(this.pointer, trail)) {
        return this.end(false, "The red trail caught your cursor.");
      }
      ctx.lineWidth = MAZE_PATH_RADIUS * 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "#456478";
      ctx.beginPath();
      this.maze.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.stroke();
      const finishEnd = this.maze[this.maze.length - 1];
      const start = this.maze[0];
      ctx.fillStyle = "#6ff2a8";
      ctx.beginPath(); ctx.arc(start.x, start.y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath(); ctx.arc(finishEnd.x, finishEnd.y, 10, 0, Math.PI * 2); ctx.fill();
      if (trail.length > 1) {
        ctx.strokeStyle = "#ed4545";
        ctx.beginPath();
        trail.forEach((point, i) => i ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
        ctx.stroke();
      }
    } else if (this.type === "flappy") {
      const gateSpeed = GATE_SPEED * (1 + this.difficulty * 0.55);
      const spacing = Math.max(95, 135 - this.difficulty * 25);
      const firstGate = Math.max(0, Math.floor((elapsed * gateSpeed - 444) / spacing));
      const lastGate = Math.floor(elapsed * gateSpeed / spacing) + 1;
      for (let i = firstGate; i <= lastGate; i++) {
        const gateSpeed = GATE_SPEED * (1 + this.difficulty * 0.55);
        const spacing = Math.max(95, 135 - this.difficulty * 25);
        const x = 420 + i * spacing - elapsed * gateSpeed;
        const gap = this.gaps[i % this.gaps.length];
        ctx.fillStyle = "#5ab0ff";
        ctx.fillRect(x, 0, 24, gap - 42);
        ctx.fillRect(x, gap + 42, 24, 240 - gap - 42);
        if (this.pointer && x < 82 && x + 24 > 58 && Math.abs(this.pointer.y - gap) > 30) {
          return this.end(false, "The yellow marker hit a blue gate.");
        }
      }
    } else if (this.type === "meteors") {
      for (const meteor of this.meteors) {
        if (elapsed < meteor.delay) continue;
        const speed = meteor.speed * (1 + this.difficulty * 0.65);
        const y = ((elapsed - meteor.delay) % 6) * speed - 12;
        if (y < -12 || y > 252) continue;
        ctx.fillStyle = "#ff8866";
        ctx.beginPath(); ctx.arc(meteor.x, y, 12, 0, Math.PI * 2); ctx.fill();
        if (this.pointer && Math.hypot(this.pointer.x - meteor.x, this.pointer.y - y) < 22) {
          return this.end(false, "A meteor hit your yellow marker.");
        }
      }
    } else if (this.type === "pacman") {
      const ghost = this.chasingGhost;
      const dx = this.pointer.x - ghost.x, dy = this.pointer.y - ghost.y;
      const distance = Math.hypot(dx, dy);
      const step = Math.min(distance, Math.max(0, now - this.ghostUpdatedAt) / 1000 *
        CHASING_GHOST_SPEED * (1 + this.difficulty * 0.7));
      if (distance > 0) {
        ghost.x += dx / distance * step;
        ghost.y += dy / distance * step;
      }
      this.ghostUpdatedAt = now;
      for (const dot of this.dots) {
        if (!dot.taken && this.pointer && Math.hypot(this.pointer.x - dot.x, this.pointer.y - dot.y) < 13) dot.taken = true;
        ctx.fillStyle = dot.taken ? "#263548" : "#ffe98a";
        ctx.beginPath(); ctx.arc(dot.x, dot.y, 4, 0, Math.PI * 2); ctx.fill();
      }
      for (let i = 0; i < 3; i++) {
        const ghostSpeed = 1 + this.difficulty * 0.7;
        const x = i === 0 ? ghost.x : 200 + Math.sin(elapsed * ghostSpeed * (0.9 + i * 0.18) + i * 2.1) * (155 - i * 20);
        const y = i === 0 ? ghost.y : 120 + Math.cos(elapsed * ghostSpeed * (1.1 + i * 0.22) + i * 1.7) * (80 - i * 12);
        ctx.fillStyle = ["#ff5c7a", "#8a7dff", "#5ab0ff"][i];
        ctx.beginPath(); ctx.arc(x, y, 12, Math.PI, 0); ctx.lineTo(x + 12, y + 12); ctx.lineTo(x, y + 7); ctx.lineTo(x - 12, y + 12); ctx.closePath(); ctx.fill();
        if (this.pointer && Math.hypot(this.pointer.x - x, this.pointer.y - y) < 20) return this.end(false, "A ghost caught your cursor.");
      }
      if (this.dots.every((dot) => dot.taken)) return this.end(true);
    } else if (this.type === "routing") {
      this.routeNodes.forEach((node, index) => {
        ctx.strokeStyle = index === this.routeIndex ? "#ffd34d" : index < this.routeIndex ? "#6ff2a8" : "#5b7394";
        ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(node.x, node.y, 17, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = "#fff"; ctx.font = "bold 13px Consolas"; ctx.textAlign = "center"; ctx.fillText(index + 1, node.x, node.y + 5);
      });
    } else if (this.type === "orbit") {
      const angle = elapsed * 1.8 * (1 + this.difficulty * 0.55);
      const origin = this.orbitOrigin || { x: 200, y: 120 };
      const x = Math.max(35, Math.min(365, origin.x + Math.sin(angle) * 82));
      const y = Math.max(35, Math.min(205, origin.y + (Math.cos(angle) - 1) * 48));
      const radius = 42 - this.difficulty * 10;
      ctx.strokeStyle = "#5ab0ff"; ctx.lineWidth = 20; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
      if (this.pointer && Math.hypot(this.pointer.x - x, this.pointer.y - y) > radius + 10) return this.end(false, "You lost the moving orbit lock.");
    } else if (this.type === "scanner") {
      const origin = this.scannerOrigin || { x: 200 };
      const span = this.canvas.width;
      const offset = (origin.x + elapsed * (70 + this.difficulty * 55)) % (span * 2);
      const x = offset <= span ? offset : span * 2 - offset;
      const width = 34 - this.difficulty * 10;
      ctx.fillStyle = "rgba(60,220,140,.18)"; ctx.fillRect(x - width, 18, width * 2, 204);
      ctx.strokeStyle = "#6ff2a8"; ctx.lineWidth = 3; ctx.strokeRect(x - width, 18, width * 2, 204);
      if (this.pointer && Math.abs(this.pointer.x - x) > width) return this.end(false, "You moved outside the scanner zone.");
    }
    if (this.pointer) {
      ctx.fillStyle = "#ffd34d";
      ctx.beginPath();
      ctx.arc(this.type === "flappy" ? 70 : this.pointer.x, this.pointer.y, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

if (typeof module !== "undefined") module.exports = { MouseMinigame };
