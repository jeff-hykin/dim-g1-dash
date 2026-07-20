# dim-g1-dash

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app for driving and
monitoring a **Unitree G1** humanoid — running *onboard the robot's Jetson*.

Unlike [dim-go2-dash](https://github.com/jeff-hykin/dim-go2-dash) (which discovers
and provisions a quadruped from a laptop), G1 Dash lives on the G1 itself and
talks straight to its hardware:

- **Live camera** — the onboard RealSense color node, read via plain Linux V4L2
  (no librealsense, so other consumers keep the depth/IR nodes) and served as an
  MJPEG video stream the panel plays directly.
- **3D lidar** — the MID360 (Livox) point cloud, accumulated over ~4 s and
  rendered live with three.js (pre-flipped for the G1's upside-down mount).
- **Connect/disconnect** — camera and lidar are exclusive-access devices, so
  the dash claims **neither by default**. One click on the MID360/RS status
  chips (or the lidar card's Connect button, or the `/` palette) claims or
  releases them for other programs — e.g. Unitree's videohub holds the camera
  and a point-lio SLAM stack holds the lidar.
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

Actions that need a particular mode (Wave, Shake, High/Low Stand — and driving)
grey out when the robot isn't in one, and their tooltip says which modes do
work, e.g. *"Wave — needs mode: walk, primitive_walk, stand — robot is in
collapse"*. While the mode is still unknown nothing is greyed out: the robot's
own refusal is authoritative, and a wrongly-disabled button is worse than a
refused one.

The dock carries the everyday commands — **Stiffen, Walk, Collapse, Wave,
Shake, Squat, Sit (Chair)**. Everything else sits behind the **Advanced**
toggle: Zero Torque, Stand, the two Primitive Walk buttons, Wave + Turn, and
High/Low Stand. The `/` palette follows the same toggle, so one switch governs
both (and the palette can flip it, staying open when you do). Collapsed means
collapsed in both places, including for the mode the robot is currently in —
the top-bar badge is what reports that.

| Camera + controls | Lidar point cloud |
| --- | --- |
| ![Driving the G1](docs/drive.png) | ![MID360 point cloud](docs/lidar.png) |

## How it works

The G1's three interfaces — the **MID360** lidar, the **RealSense** camera, and
the robot itself (**unitree_sdk2** over DDS) — all need native code, so the
backend can't be pure Deno. `main.js` uses `nix run` to build and launch a
standalone **C++ helper** (`g1_helper_cpp`) that owns all three and speaks
newline-JSON over stdio. The dashboard relays that to/from the browser panel over
the app-bus; drive and gait commands flow back down the same pipe.

No dimos venv is required — `nix` builds the helper on first launch (compiling the
robot SDKs; cached thereafter). If a dimos LCM bridge happens to be running
alongside, the backend also forwards its streams to the panel.

```
browser panel  ⇄  main.js (Deno)  ⇄  g1_helper (C++, nix)  ⇄  MID360 · RealSense · G1
     app-bus            stdio (newline-JSON)                    Livox · rs2 · unitree_sdk2
```

## Install

```sh
dim install https://github.com/jeff-hykin/dim-g1-dash
```

The app appears in the dashboard rail within a few seconds. The **first** launch
compiles the robot SDKs under Nix and can take several minutes — watch the
dashboard logs for build progress; it's cached after that.

### Requirements

- Runs on the G1's onboard computer (aarch64 Jetson) — also builds on x86_64 Linux.
- `nix` with flakes enabled (the helper is built via `nix run`).
- The MID360, RealSense, and G1 DDS interface reachable on the network
  (see the env-var knobs in [`dim/apps/g1_dash/g1_helper_cpp/README.md`](dim/apps/g1_dash/g1_helper_cpp/README.md)).

## Layout

```
dim/apps/g1_dash/
  app.yaml            title
  frontend/
    index.html        the panel — camera, 3D lidar (three.js), telemetry, controls
    icon.svg          rail icon (humanoid)
  main.js             backend — nix-runs the C++ helper, relays over the app-bus
  g1_helper_cpp/      C++ helper — MID360 + RealSense + unitree_sdk2, JSON over stdio
    flake.nix         builds it (SDKs pinned as flake inputs), run via nix
    CMakeLists.txt
    src/              protocol, unitree_bridge, mid360, webcam, main
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

G1 Dash is designed to run onboard, but a laptop **plugged into the robot's
LAN** (an interface on `192.168.123.x`) works as a remote session: the helper
auto-binds DDS to that interface, so driving, telemetry, engage sequences and
even the MID360 all work. The top bar shows **Remote** instead of **Onboard**,
and the camera pane explains the one thing that can't follow: the RealSense is
attached to the robot. If the robot is *also* running G1 Dash, press `/` →
"View robot's onboard camera stream" to watch its MJPEG feed.

On a machine with no robot LAN at all, the panel shows setup instructions
instead of dead widgets (and a separate message if `nix` is missing so the
helper can't build).

## Safety

Driving is failsafe: the helper only keeps the robot moving while fresh `move`
commands arrive (~0.4 s window). Losing panel focus, closing the app, or any pipe
drop halts motion on its own — nothing latches.

Licensed under Apache-2.0.
