const { randomInt } = require("node:crypto");
const { Game } = require("./game");

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

class Lobbies {
  constructor(send) {
    this.send = send;
    this.rooms = new Map();
    this.members = new Map();
  }

  code() {
    let code;
    do {
      code = Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  connect(name) {
    const room = this.rooms.get(this.members.get(name));
    if (room && (room.game.players.has(name) || room.game.phase === "lobby")) {
      room.emptySince = null;
      room.game.connect(name);
      if (room.game.phase !== "lobby") this.send(name, room.game.snapshot(room.game.players.get(name)));
    } else {
      this.members.delete(name);
      this.send(name, { t: "lobby_select" });
    }
  }

  join(name, room) {
    if (this.members.has(name)) {
      this.send(name, { t: "lobby_error", text: "Leave your current lobby first." });
      return;
    }
    this.members.set(name, room.code);
    room.emptySince = null;
    room.game.connect(name);
    if (room.game.phase !== "lobby") this.send(name, room.game.snapshot(room.game.players.get(name)));
  }

  handle(name, msg) {
    if (!msg || typeof msg.t !== "string") return;
    const room = this.rooms.get(this.members.get(name));
    if (msg.t === "host_lobby") {
      if (room) return this.send(name, { t: "lobby_error", text: "Leave your current lobby first." });
      const code = this.code();
      const created = { code, private: true, game: null };
      created.game = new Game((recipient, message) => {
        if (this.members.get(recipient) !== code) return;
        this.send(recipient, message.t === "lobby"
          ? { ...message, code, private: created.private }
          : message);
      });
      this.rooms.set(code, created);
      this.join(name, created);
    } else if (msg.t === "join_random") {
      if (room) return this.send(name, { t: "lobby_error", text: "Leave your current lobby first." });
      const available = [...this.rooms.values()].filter((item) =>
        !item.private && item.game.phase === "lobby" && item.game.hostName());
      if (!available.length) return this.send(name, { t: "lobby_error", text: "No open waiting lobbies are available. Host a lobby or enter a code." });
      this.join(name, available[randomInt(available.length)]);
    } else if (msg.t === "join_code") {
      if (room) return this.send(name, { t: "lobby_error", text: "Leave your current lobby first." });
      const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
      const target = this.rooms.get(code);
      if (!target) return this.send(name, { t: "lobby_error", text: "Lobby code not found." });
      this.join(name, target);
    } else if (msg.t === "leave_lobby") {
      if (room) this.leave(name, room);
      this.send(name, { t: "lobby_select" });
    } else if (msg.t === "lobby_privacy") {
      if (!room || room.game.hostName() !== name || room.game.phase !== "lobby" ||
          typeof msg.private !== "boolean") {
        return this.send(name, { t: "lobby_error", text: "Only the host can change privacy while waiting." });
      }
      room.private = msg.private;
      room.game.broadcastLobby();
    } else if (room) {
      room.game.handle(name, msg);
    }
  }

  leave(name, room) {
    room.game.disconnect(name);
    room.game.players.delete(name);
    this.members.delete(name);
    room.game.broadcastLobby();
    if (!room.game.hostName()) this.destroy(room);
  }

  disconnect(name) {
    const room = this.rooms.get(this.members.get(name));
    if (!room) return;
    room.game.disconnect(name);
    if (!room.game.hostName()) room.emptySince = Date.now();
  }

  destroy(room) {
    this.rooms.delete(room.code);
    for (const [name, code] of this.members) {
      if (code === room.code) this.members.delete(name);
    }
  }

  tick() {
    for (const room of this.rooms.values()) {
      if (room.emptySince && Date.now() - room.emptySince >= 60000) {
        this.destroy(room);
        continue;
      }
      try {
        room.game.tick();
      } catch (error) {
        console.error("Lobby tick error:", room.code, error);
      }
    }
  }
}

module.exports = { Lobbies };
