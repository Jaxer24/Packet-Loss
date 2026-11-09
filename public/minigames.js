// Mouse minigames are visual challenges; the server decides whether results apply.
const MAZE_PATH_RADIUS = 15;
const MAZE_TRAIL_DELAY_SECONDS = 1;
const MAZE_TRAIL_SPEED = 90;
const GATE_SPEED = 175;
const METEOR_SPEED_MULTIPLIER = 1.25;

class MouseMinigame {
  constructor(canvas, type, seconds, finish, onStart = () => {}, entrySeconds = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.type = type;
    this.seconds = seconds;
    this.entrySeconds = entrySeconds;
    this.finish = finish;
    this.onStart = onStart;
    this.started = performance.now();
    this.playStarted = null;
    this.pointer = null;
    this.ended = false;
    this.mazeIndex = 0;
    this.createMaze({ x: 30, y: 120 });
    this.gaps = Array.from({ length: 4 }, () => 55 + Math.random() * 130);
    this.meteors = Array.from({ length: 18 }, (_, i) => ({
      x: 20 + Math.random() * 360,
      delay: i * 0.3,
      speed: (85 + Math.random() * 35) * METEOR_SPEED_MULTIPLIER,
    }));
    this.onMove = this.onMove.bind(this);
    this.onDown = this.onDown.bind(this);
    this.onLeave = this.onLeave.bind(this);
    canvas.addEventListener("pointerdown", this.onDown);
    canvas.addEventListener("pointerenter", this.onMove);
    canvas.addEventListener("pointermove", this.onMove);
    canvas.addEventListener("pointerleave", this.onLeave);
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
    this.pointer = position;
    this.beginPlaying();
  }

  onMove(event) {
    if (this.ended || this.playStarted === null) return;
    const next = this.eventPosition(event);
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
      if (this.mazeIndex === this.maze.length - 1) this.createMaze(next);
    } else {
      this.pointer = next;
    }
  }

  beginPlaying() {
    if (this.playStarted !== null) return;
    this.playStarted = performance.now();
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
    let remaining = Math.max(0, (now - this.mazeStarted) / 1000 - MAZE_TRAIL_DELAY_SECONDS) * MAZE_TRAIL_SPEED;
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

  onLeave() {
    if (this.pointer) this.end(false, "Your cursor left the game area.");
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
    this.canvas.removeEventListener("pointerenter", this.onMove);
    this.canvas.removeEventListener("pointermove", this.onMove);
    this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.finish(success, reason);
  }

  draw() {
    if (this.ended) return;
    const now = performance.now();
    if (this.playStarted === null && this.remainingSeconds(now) <= 0) return this.end(false, this.timeoutReason());
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
      const firstGate = Math.max(0, Math.floor((elapsed * GATE_SPEED - 444) / 135));
      const lastGate = Math.floor(elapsed * GATE_SPEED / 135) + 1;
      for (let i = firstGate; i <= lastGate; i++) {
        const x = 420 + i * 135 - elapsed * GATE_SPEED;
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
        const y = ((elapsed - meteor.delay) % 6) * meteor.speed - 12;
        if (y < -12 || y > 252) continue;
        ctx.fillStyle = "#ff8866";
        ctx.beginPath(); ctx.arc(meteor.x, y, 12, 0, Math.PI * 2); ctx.fill();
        if (this.pointer && Math.hypot(this.pointer.x - meteor.x, this.pointer.y - y) < 22) {
          return this.end(false, "A meteor hit your yellow marker.");
        }
      }
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
