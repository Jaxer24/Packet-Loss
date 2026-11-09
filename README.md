# Packet Loss – reference implementation

A working (clunky-on-purpose) version of the Packet Loss GDD: 1 Blue "hacker" vs Red infiltrators, server-authoritative, over WebSockets.

## Run (PowerShell)

```powershell
cd packet-loss
copy .env.example .env      # then edit SESSION_SECRET (any long random string)
npm.cmd install
npm.cmd start
```

Open http://localhost:3100. After login, host a lobby, join an open waiting lobby randomly, or enter a lobby code. New lobbies are private by default; the host can make one open to random joining or switch it back to code-only while waiting. Share the displayed code to invite players. Multiple lobbies and matches run independently. Register two accounts (use a second browser/incognito window), join the same lobby, pick Red and Blue, and have the host click Start. A solo start is allowed for testing.

Random joining only selects open lobbies waiting to start. The lobby code remains visible during the match so it can be shared. Entering the code of a match in progress joins as a spectator: use WASD to move through walls and Tab to open the map. Spectators can see the full match, including all players through walls, but cannot interact with it or be seen by active players. After the match, spectators can choose a team for the next round. The host role transfers if the host leaves. Disconnected players can reconnect to their match; an entirely empty lobby is removed after one minute.

If a match starts with Blue players and no human Reds, one Red Bot joins for that match. It heads for servers, tries to route around guards, and hacks doors, cameras and active lasers as it encounters them. Device hacks use normal charges and are subject to EMPs. Server extraction uses the normal timer without a mouse challenge and can be interrupted as usual. After taking damage from a guard's bullet, the bot briefly returns fire and flees; it respawns on the normal automatic timer. Its navigation is deliberately basic, so it may take a direct route if it cannot find one avoiding guards.

The MP3 in `public` plays on a loop after login and restarts when a match starts. Open **Settings** at the top right to pause or resume music and adjust its volume. If the browser blocks autoplay, open Settings and click **Play music**. Replace the supplied MP3 at the same filename with a valid, appropriately licensed audio file if playback fails.

Run the gameplay and radar checks with `npm.cmd test`.

## Controls

**Red:** WASD move, mouse aim, click fire, Q knife, E cycle weapons in character view; walk over a ready locker to collect its item. To extract a server, get close and click it on the radar or in hack mode. Each accepted extraction attempt spends one shared Red hack charge immediately, even if it is later interrupted or fails; retrying costs another charge. Rejected attempts cost nothing. Play one continuous mouse challenge while moving with WASD; progress accrues after entering it and extraction completes immediately at 100%. Failure, cancellation, or death stops extraction but preserves progress; return to the server to try again. F toggles hack mode: click a server/door/laser/camera to hack without firing, or click elsewhere to shoot. The game view has a red tint while it is active. **Tab radar** opens a detailed map with all objects, guards and you (click servers or devices; Esc/Tab closes), Z steals a nametag from a corpse, hold X to dispose of a corpse, Space teleport pad. Red sees approximate guard GPS rings through walls, but guard bodies are only visible in line of sight.

**Maps:** shooter views (Red, possessed guard) show the simplified map: solid walls plus clickable objects. Radar views show the detailed artwork. Press **Tab** to switch between the shooter and radar views. The radar opens zoomed in on your player and follows movement until you pan; close and reopen it to resume following. Scroll zooms around your player while following, or around the mouse after panning. Blue without a possessed guard uses the last guard's position, or the facility center if none. On the radar, **left-drag** to pan or click without dragging to interact with objects. Blue sees red pulsing circles around hacked devices and undisguised Red players currently detected by a guard or camera.

Guard GPS markers on radar and in character view show a translucent directional arc around the approximate location circle. It indicates facing and field of view, not exact position, visibility range, or wall obstruction. Disguised Reds appear as ordinary guard markers to Blue, including their facing indicator.

**HUD:** Match time appears at the top center, server progress at the bottom right, and team status at the upper left. Both teams show health and equipment above their hacking or security panel; Blue shows guard health and equipment while possessing a guard. Blue's blackout indicator shows the remaining active time, then the remaining cooldown, then READY. The cooldown starts when blackout is activated. The blue armor bar sits above the health bar. Green indicates ready or complete, yellow highlights active modes and cooldowns, and red highlights low health. Game updates appear at the lower left; the bottom-center panel shows context-sensitive controls.

When Red dies, a grey-tinted map shows numbered spawn points and the auto-respawn countdown under match time. Scroll to zoom, drag to pan, and click a spawn to start an early-reboot minigame at that point. On failure, choose a point to retry; when the countdown ends, automatic respawn chooses a random spawn as usual.
**Blue:** click UI/map markers to close open doors, possess a guard, or counterhack an extracting server or Red-hacked camera or laser; Z sends nearby available guards to investigate the mouse location and marks it for Blue in radar or guard view; X deploys an EMP at the mouse location in radar or guard view; F blackout; Tab toggles view, Esc exits possession. During a blackout, Blue's radar and guard view have a green night-vision tint without changing visibility. Both team tints darken the game view slightly without affecting the HUD. Possessed guards can move with WASD in either view; shooting remains disabled while the radar is open.

Doors start closed. Red can spend one charge to open a closed door; it stays open until Blue spends one charge to close it. Blue's closure also lasts until Red reopens it. Clicking a door already in the desired state costs nothing. Corpses do not block doors or change their state.

Cameras and lasers start active. Red can spend one charge to disable either until Blue spends one charge to restore it. Repeating an action on a device already in the desired state costs nothing.

While a Red player is extracting a server, their exact position, name and health are revealed to all Blue players on radar and in possessed guard view, even through walls and while disguised. Once Red starts the extraction challenge, nearby AI guards within 800 pixels pursue their continuously updated position through rooms, even after losing sight. Guards already pursuing another visible Red stay focused on that player. Guards need normal sight and line of sight to shoot, including at a disguised extractor. When extraction stops, the live pursuit ends and guards can search the last location; other normal visibility and tracking rules still apply.

Possessed guards see the same approximate GPS markers for guards and disguised Reds, including through walls. A visible disguised Red looks like an ordinary guard to Blue, without a player name. When a possessed guard directly sees an undisguised Red, Blue sees the Red's name and that Red sees the guard player's name; the guard player's name stays hidden while the Red is disguised. Visible players and guards show health bars. AI guards move at half Red speed while patrolling or investigating and 75% while chasing; possessed guards move at full Red speed.

AI guards discover undisposed guard corpses they see or walk over, alerting Blue and invalidating any disguise taken from that corpse. A discovered corpse's nametag can no longer be stolen. Disposing of a guard corpse removes it from the game and prevents later discovery; Red corpses remain visible.

The EMP does not cost a security charge and is visible to both teams. It temporarily closes doors and activates cameras and lasers within its field; even a partial overlap affects a door or laser. When the field ends, devices return to their underlying state. Blue can still counterhack a camera or laser during the EMP to restore it permanently; a temporarily closed door must wait until the field ends before Blue can close it permanently. Red cannot start device hacks or server extraction if the hacker or target is inside the field. Ongoing extraction stops if the server or hacker enters the field, retaining its progress. The alert and EMP cooldowns, radius, and duration are adjustable in `game/config.js`.

**Weapons and lockers:** Guns use finite ammo pools with no reloading: pistol 300 and SMG 200. Red starts with a pistol and can find an SMG; each guard starts with both. In character view, press Q for the knife or E to cycle pistol, SMG, and grenades, skipping unavailable or empty weapons; grenades start at zero and lockers supply up to three. A knife swing shows a translucent red cone for 0.25 seconds at the attack location, matching its range and direction; damage is applied at the moment of the swing. Red and possessed guards collect ready lockers by walking over them. Lockers can provide weapons, grenades, armor, teleport pads (Space), or refill owned guns to their starting capacities. Guards retain their supplies between possessions until death; a respawned guard starts fresh. During a minigame Escape gives up the challenge instead of exiting a guard.

Grenades destroy wall sections within their blast radius for the rest of the match. The openings affect movement, sight, bullets, and guard and bot navigation; doors remain separate and can still block an opening. The radar paints cleared wall areas as floor, while character views show the remaining walls. Damage from the blast itself is still blocked by walls that existed at the moment of detonation. Walls reset for the next match, and other lobbies are unaffected.

A placed teleport pad appears as a small blue dot on radar and in character view for everyone, even through fog. The dot disappears when the pad is used or its owner respawns.
Possessed guards can walk through closed doors, but walls still block them. Closed doors continue to block Red players, bullets, and line of sight.
In a possessed guard's shooter view, a Red player you see remains visible at their current position for 10 seconds after leaving sight. Each new sighting refreshes the timer. Tracking ends if Red dies or you release the guard; the extra visibility does not apply to the radar.
Active cameras also reveal undisguised Reds on Blue's radar and possessed-guard shooter view while they are detected. Their displayed vision cones stop at walls and closed doors. Nearby AI guards investigate the nearest camera-detected Red and follow updates while the camera sees them; once the sighting ends, they investigate the last reported position before returning to patrol. Possessed guards and guards already chasing a player are not redirected.

**Mouse minigames:** Each extraction, server counterhack or early reboot randomly selects one continuous challenge: gates, maze, or meteors. Click anywhere inside the game within the entry window to start, then keep playing until the action finishes. The maze begins at the click position: follow the path from the green circle to the yellow circle, staying ahead of the red trail. The trail starts after a one-second head start and catches a stationary cursor; a new path and head start begin at each finish. Extraction completes at 100%; server counterhack and extraction durations are configured in `game/config.js`. Reboots remain bounded by the automatic respawn timer. Follow the on-screen instructions and keep the pointer inside the game area after starting; leaving the board or window fails the challenge, and a notification explains why. The minigame background is 60% transparent so the map remains visible while the game and text stay opaque. Blue gets one server counterhack attempt per extraction. Closing an open door or counterhacking a hacked camera or laser is immediate and costs one security charge. Red can retry reboots until the automatic respawn timer expires. The visual challenge runs in the browser; the server checks the attempt and timing but does not independently verify every mouse movement.

Server counterhack attempts require an available Blue security charge, and spend it only on success. A success interrupts extraction, removes 60% of the server's accumulated progress (leaving 40%), and locks the server for 5 seconds. For example, 75% progress becomes 30%. Each server also has a 20-second counterhack cooldown starting when an attempt begins. These timings and the extraction range can be adjusted in `game/config.js`.

## Architecture

- `server.js` – Express + express-session + bcrypt auth (`/api/register|login|me|logout`); WebSocket `/ws` accepts connections only if the session has a username (checked on upgrade). Runs the game tick at 30 Hz.
- `game/game.js` – all rules, guard AI, and per-role snapshot filtering (Red never receives Blue-only info, Blue only gets radar markers). The client only sends inputs (`input`, `act`); the server decides everything.
- `game/map.js` – loads `game/facility.json` (servers, lockers, cameras, spawns, doors, lasers, patrol routes: one per line, easy to edit) and `game/walls.json` (the ~2200 generated collision rectangles), applies `map-edits.json`, and adds collision lookups plus a grid BFS path finder for guards. `game/config.js` – every tunable number. `game/geom.js` – collision helpers.
- `public/facility.png` – the GDD map artwork, drawn as the background. `tools/build_map.py` – generates `game/facility.json` from it (see below).
- `public/` – vanilla canvas client (`client.js`), `index.html`, `style.css`.

### Reading and changing the code

- Start with `game/config.js` for gameplay values. In `game/game.js`, the section headings
  follow the match lifecycle: lobby, setup, incoming messages, actions, combat, the main
  tick, guard AI, victory, and the snapshots sent to clients.
- `server.js` handles authentication and WebSocket connections. It creates a `Game`,
  passes incoming messages to `Game.handle`, and calls `Game.tick` at the configured rate.
  Each tick advances the simulation, checks for a winner, and sends role-specific snapshots.
- `public/client.js` collects input and draws the latest snapshot. Its sections cover
  authentication, input, minigames, drawing, and the HUD. The server, not the browser,
  decides the game state.
- Some short names remain in the messages shared by server and client. For example, `t`
  identifies a message type, `mx`/`my` are movement directions, `ax`/`ay` are world-space
  aim coordinates, and charge status uses `a` (available), `m` (maximum), and `n`
  (seconds until the next recharge). Change both sides together if you rename message fields.
- Positions use world pixels: `x` increases to the right and `y` increases downward.
  Rectangles use `x`, `y`, `w`, and `h` for top-left position, width, and height.

## The map

The level is the real map from the GDD (`High-Tech Data Center Facility Map.png`), drawn at 2x (world is 2690 x 2338).
`tools/build_map.py` turns the artwork into game data. You only need to run it if you change the artwork or its marker lists:

```powershell
pip install pillow numpy scipy
python tools\build_map.py
```

- **Walls:** the black wall ribbons and furniture in the artwork become ~2200 collision rectangles (flood fill of the lit floor; closed-off rooms are solid).
- **Servers, lockers, cameras, spawns:** read off the GDD blueprint (red triangles, green squares, blue cones, pink rings) and snapped to walkable floor. 3 servers, 9 lockers, 8 cameras, 8 entrances.
- **Doors and lasers:** the artwork has none, so I placed 6 doors at room entrances and 2 lasers in corridors (`DOOR_GUESSES` / `LASER_GUESSES` in the script).
- **Patrol routes:** 3 circle the server rooms, 5 cover the rest of the building.

## Adjusting walls by hand

1. In a match press **F2** to show the collision walls (red) and the world coordinates under your mouse.
2. Put rectangles in `game/map-edits.json` (world coordinates, `x`/`y` = top-left, `w`/`h` = size):
   ```json
   {
     "addWalls":    [ { "x": 1000, "y": 800, "w": 200, "h": 20 } ],
     "removeWalls": [ { "x": 500, "y": 600, "w": 80, "h": 80 } ]
   }
   ```
   `addWalls` makes an area solid (also blocks bullets and sight). `removeWalls` carves an area out of existing walls.
3. Restart the server (`Ctrl+C`, `npm.cmd start`) and refresh. Guard pathfinding picks the edits up automatically.

Edits survive re-running `tools/build_map.py` because that only rewrites `facility.json`. The outer border is just walls too, so add/remove rectangles there the same way. Doors, lasers, servers, lockers, cameras and spawns are in `facility.json` (or the lists in `tools/build_map.py`).

## Deviations from the GDD

- One global room; teams picked in the lobby.
- Dash from the earlier demo is not included.
- Corpse disposal is hold-C for 5s instead of mashing.
- Some closed rooms in the artwork have no visible doorway, so they are solid decoration.
- Control keys and several timings (such as the server counterhack lockout) are configurable; camera and laser hacks do not expire on a timer.
