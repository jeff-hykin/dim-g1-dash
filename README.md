# G1 Ctrl (dim-g1-dash)

A [dimOS Desktop](https://github.com/dimensionalOS/dimos-desktop) app for driving and
monitoring a **Unitree G1** humanoid — running *onboard the robot's Jetson*.

Unlike [dim-go2-dash](https://github.com/jeff-hykin/dim-go2-dash) (which discovers
and provisions a quadruped from a laptop), G1 Ctrl lives on the G1 itself and
talks straight to its hardware:

- **Live camera** — the onboard RealSense color node, read via plain Linux V4L2
  (no librealsense, so other consumers keep the depth/IR nodes) and served as an
  MJPEG video stream the panel plays directly.
  The stream is backpressure-aware in both directions. The sender caps its
  socket buffer to about one frame and skips a frame whenever the socket still
  has an unsent backlog, so what arrives is near-live instead of a queue draining
  in order — that queue, not userspace, was the whole of the original lag. It
  also adapts JPEG quality to its own drop rate. Each part carries an
  `X-Timestamp`, and the panel parses the stream itself rather than handing it to
  an `<img>`: it decodes only the newest frame, shows **camera fps** and **camera
  lag** in the Health card, and asks the robot for 10 fps when lag stays above
  500 ms (releasing the cap once it drops back under 200 ms). Lag is measured
  against the smallest clock offset ever observed, so it reads as queueing delay
  rather than absolute glass-to-glass.
- **3D lidar** — the MID360 (Livox) point cloud, accumulated over ~4 s and
  rendered live with three.js (pre-flipped for the G1's upside-down mount).
- **Connect/disconnect** — camera and lidar are exclusive-access devices, so
  the dash claims **neither by default**. One click on the MID360/RS status
  chips (or the lidar card's Connect button, or the `/` palette) claims or
  releases them for other programs — e.g. Unitree's videohub holds the camera
  and a point-lio SLAM stack holds the lidar.
- **Force takeover camera** — on a stock G1 the RealSense is held from boot by
  Unitree's `videohub_pc4`, so Connect just sits at "Connecting to camera
  stream…" forever. The amber **Force takeover camera** button frees it. Killing
  videohub alone is not enough — `master_service` respawns it within a second —
  so the backend stops that supervisor first, then the process, then re-asks for
  the camera. On the Jetson `master_service` supervises only the two videohubs
  and the OTA pipe, so nothing about the robot's motion is touched. Put the
  robot's own video back with `sudo systemctl start master_service`.

  It needs three narrowly-scoped rules in `/etc/sudoers.d/dim-g1-dash-camera`:

  ```
  unitree ALL=(root) NOPASSWD: /usr/bin/systemctl stop master_service
  unitree ALL=(root) NOPASSWD: /usr/bin/systemctl start master_service
  unitree ALL=(root) NOPASSWD: /usr/bin/pkill -x videohub_pc4
  ```

  Without them the button reports what to add instead of failing silently.
- **Telemetry** — battery percentage, loco controller FSM + resident motion
  service, IMU attitude (roll/pitch/yaw with an artificial horizon), hottest
  joint temperature, and nearest-obstacle proximity.
- **Control** — one-tap **Walk** runs the full engage sequence (the dimos
  `bin/g1_stand` flow, ported to C++): switch to the "ai" motion service, damp,
  get-ready, then emulate a held R2+A on the wireless-controller topic to enter
  the advanced balance controller — the one that walks naturally. Then drive
  with `W`/`S` (forward/back), `A`/`D` (turn), `Q`/`E` (strafe), `Shift` to
  boost — or the on-screen pad, which is laid out like those same keys.
  `Space` is a hardware-style **E-STOP** (aborts sequences too), and `/` opens
  a searchable action palette — every button is keyboard-reachable.

## Modes

The panel names what the robot **is doing** rather than exposing the SDK's FSM
ids, and each mode button says which mode it puts the robot into. The current
mode is read back from the loco service — both its FSM id (which controller is
running) and its balance mode (whether that controller steps or holds still) —
so it's the robot's own answer, not what we last asked for.

| Mode | What it means |
| --- | --- |
| `walk` | advanced controller — natural walking, accepts drive commands |
| `primitive_walk` | primitive controller — stompier walking, accepts drive commands (advanced; slow and fast are separate buttons) |
| `stand` | a walking controller that's holding still instead of stepping — still balancing, still under torque control |
| `stiffen` | joints locked and legs straight, not balancing yet — the step before standing |
| `squat` | crouched on its own legs, balance control off (the remote's `L1`+`Down`) |
| `sit` | seated, balance control off — expects a chair or support under it; Unitree's shutdown posture (`L1`+`Left`) |
| `collapse` | damped: joints limp, the robot rests on whatever holds it |
| `limp` | zero torque, motors fully off |

Gestures (Wave, Shake, Wave + Turn) go through the robot's **arm-action
service**, not `LocoClient`'s `WaveHand`/`ShakeHand`. Those two call `SetTaskId`,
which this firmware accepts and then ignores — measured against `rt/lowstate`,
task ids 0-3 return 0 and move the joints by 0.0002 rad, i.e. nothing. The action
ids used here (`26 wave_above_head`, `27 shake_hand`, `1 turn_back_wave`) come
from the robot's own `GetActionList`. An action holds its last keyframe when it
finishes, so **Release Arms** (`99 release_arm`, in the `/` palette) puts the arms
back.

Actions that need a particular mode (Wave, Shake, High/Low Stand — and driving)
grey out when the robot isn't in one, and their tooltip says which modes do
work, e.g. *"Wave — needs mode: walk, primitive_walk, stand — robot is in
collapse"*. While the mode is still unknown nothing is greyed out: the robot's
own refusal is authoritative, and a wrongly-disabled button is worse than a
refused one.

The dock carries the everyday commands and nothing else — **Stiffen, Walk,
Collapse, Wave, Shake, Squat, Sit (Chair)**. The advanced ones (Zero Torque,
Stand, both Primitive Walks, Wave + Turn, High/Low Stand) have no buttons at
all: press `/` and they're in the palette, tagged `advanced`.

## How it works

The G1's three interfaces — the **MID360** lidar, the **RealSense** camera, and the robot itself (**unitree_sdk2** over
DDS) — all need native code, so a standalone **C++ helper** (`g1_helper_cpp`) owns all three and speaks newline-JSON
over stdio. The backend (Deno, `backend/`) runs it and turns everything into HTTP endpoints; the panel (TypeScript +
Vite + React, `frontend/`) calls only those endpoints and follows `api/events/ws` for live state. Desktop's agent calls
the same endpoints (listed in `dimos.yaml` `agent:` and served as `agent.json`).

```
panel / agent  ⇄  backend (Deno: HTTP + events ws)  ⇄  g1_helper (C++)  ⇄  MID360 · RealSense · G1
                                                     stdio newline-JSON     Livox · V4L2 · unitree_sdk2
```

The helper is Linux-only. `nix build .#dimosApp` gives the Jetson (aarch64) the **shipped prebuilt**
(`g1_helper_cpp/bin/`, built against its old glibc by `build_prebuilt.sh`) and builds it from source on x86_64 Linux.
On a Mac only the panel runs (it says so, and offers the simulator).

## Endpoints

Everything the panel can do is an endpoint (`backend/routes.ts`). Anything that moves or reconfigures the robot takes
`dryRun: true`, which validates and answers with what would be sent, without sending it.

| Endpoint | What it does |
| --- | --- |
| `GET api/state` | the robot now: link, devices, mode, loco FSM, battery (+ runtime estimate), attitude, hottest motor, joints, lidar summary (`role: context`) |
| `GET api/commands` | every command, worded for the current mode, with its danger tier and why it's blocked |
| `POST api/command {command, confirm?, dryRun?}` | run a mode/posture/gesture (`walk`, `collapse`, `wave`, …); dangerous ones need `confirm: true` |
| `POST api/move {vx, vy, omega, durationMs?, dryRun?}` | drive; the robot stops ~0.4 s after the last move unless `durationMs` (≤ 5 s) holds it |
| `POST api/estop {dryRun?}` | abort, zero velocity, damp |
| `PUT api/lidar {connected, dryRun?}`, `PUT api/camera {connected, dryRun?}` | claim or release the exclusive devices |
| `POST api/camera/takeover {dryRun?}` | stop Unitree's videohub so the camera can be claimed |
| `PUT api/camera/stream {maxFps?, quality?}` | stream frame-rate cap / JPEG quality |
| `GET api/camera/stream`, `GET api/camera/snapshot` | the MJPEG stream / one JPEG (`role: view`) |
| `GET api/lidar/cloud` | the accumulated point cloud |
| `GET api/settings`, `PUT api/settings` | drive speeds, and the robot IP for viewing its camera from a remote session |
| `GET api/log` | recent helper log lines and errors |
| `PUT api/simulator {enabled}` | run against a built-in simulated G1 (refused while a real helper is connected) |

## Install

```sh
dimos-desktop install https://github.com/jeff-hykin/dim-g1-dash
```

Requirements: the G1's onboard computer (aarch64 Jetson), or an x86_64 Linux machine on the robot LAN, with the MID360,
RealSense and G1 DDS interface reachable (env-var knobs in [`g1_helper_cpp/README.md`](g1_helper_cpp/README.md)).

## Development

```sh
cd frontend && npm install && npm run build && cd ..
deno task dev                  # backend on :8787 serving frontend/dist (G1_SIMULATE=1 for the simulator)
deno task test                 # backend/routes_test.ts — never touches a robot
deno task check                # types + dimos.yaml lists every route (check-endpoints --write regenerates it)
nix build .#dimosApp
```

## Layout

```
backend/         Deno: routes.ts (every endpoint), robot.ts (helper link + simulator), g1.ts (modes and commands)
frontend/        the panel — camera, 3D pose + lidar (three.js), telemetry, controls (React)
g1_helper_cpp/   C++ helper — MID360 + RealSense + unitree_sdk2, JSON over stdio; bin/ = shipped Jetson prebuilt
blackbox/        a separate read-only recorder service for the Jetson (rolling jsonl of FSM/IMU/joints/temps)
```

## Keyboard

Everything in the panel is keyboard-reachable:

| Keys | Action |
| --- | --- |
| `W` / `S` | drive forward / back (hold) |
| `A` / `D` | turn left / right (hold) |
| `Q` / `E` | strafe left / right (hold) |
| `Shift` | speed boost (hold, combines with the above) |
| `Space` | **E-STOP** — always instant, even mid-dialog |
| `/` | action palette: type to filter every command, `↑`/`↓` + `Enter` to run, `Esc` closes |
| `Tab` + `Enter` | in a danger dialog: focus starts on Cancel, `Tab` reaches the confirm button |
| `Esc` | close the palette or a danger dialog |

The palette covers everything the mouse can do — mode changes, postures,
gestures, advanced commands, camera/lidar connect & release, lidar view expand,
E-STOP — so dangerous commands keep their confirmation dialog on the keyboard
path too (a stray double-`Enter` lands on Cancel, never on confirm). Actions
blocked by the current mode are dimmed there too, with the reason inline.

Releasing a drive key stops the robot, so the pad has no stop button — that's
what `Space` (E-STOP) is for.

## Using it off-robot

G1 Ctrl is designed to run onboard, but a laptop **plugged into the robot's
LAN** (an interface on `192.168.123.x`) works as a remote session: the helper
auto-binds DDS to that interface, so driving, telemetry, engage sequences and
even the MID360 all work. The top bar shows **Remote** instead of **Onboard**,
and the camera pane explains the one thing that can't follow: the RealSense is
attached to the robot. If the robot is *also* running G1 Ctrl, press `/` →
"View robot's onboard camera stream" to watch its MJPEG feed.

On a machine with no robot LAN at all, the panel shows setup instructions
instead of dead widgets.

## Safety

Driving is failsafe: the helper only keeps the robot moving while fresh `move`
commands arrive (~0.4 s window; `api/move` with `durationMs` re-sends for at most 5 s). Losing panel focus, closing the app, or any pipe
drop halts motion on its own — nothing latches.

Licensed under Apache-2.0.
