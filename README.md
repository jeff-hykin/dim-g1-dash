# dim-g1-dash

A [DimOS dashboard](https://github.com/jeff-hykin/dim-app) app for driving and
monitoring a **Unitree G1** humanoid — running *onboard the robot's Jetson*.

Unlike [dim-go2-dash](https://github.com/jeff-hykin/dim-go2-dash) (which discovers
and provisions a quadruped from a laptop), G1 Dash lives on the G1 itself and
talks straight to its hardware:

- **Live camera** — the onboard Intel RealSense color stream.
- **3D lidar** — the MID360 (Livox) point cloud, rendered live with three.js.
- **Telemetry** — battery, IMU attitude (roll/pitch/yaw with an artificial
  horizon), hottest joint temperature, and nearest-obstacle / center-depth
  proximity.
- **Control** — drive with `W A S D` (+ `Q`/`E` to turn, `Shift` to boost) or the
  on-screen d-pad, plus one-tap gaits: Balance, Stand, Sit, Wave, Damp, Zero
  Torque, … `Space` is a hardware-style **E-STOP**.

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
    src/              protocol, unitree_bridge, mid360, realsense, main
```

## Safety

Driving is failsafe: the helper only keeps the robot moving while fresh `move`
commands arrive (~0.4 s window). Losing panel focus, closing the app, or any pipe
drop halts motion on its own — nothing latches.

Licensed under Apache-2.0.
