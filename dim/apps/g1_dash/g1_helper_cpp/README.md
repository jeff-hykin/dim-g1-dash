# g1_helper — onboard C++ bridge

The native half of **dim-g1-dash**. It runs *on the G1's Jetson* and talks to the
robot's three hardware interfaces, then multiplexes everything over a simple
newline-JSON protocol on stdio. The Deno backend (`../main.js`) launches it with
`nix run` and relays that protocol to/from the browser panel over the app-bus.

```
stdin  (commands)              stdout (telemetry, one JSON object per line)
  move / cmd / estop / config    ready · status · state · lidar · frame · log · error
        │                              ▲
        ▼                              │
  ┌───────────────────────────────────────────┐
  │  g1_helper (C++)                           │
  │   UnitreeBridge  unitree_sdk2 (DDS)  ──► G1 locomotion + low state
  │   Mid360         Livox-SDK2          ──► MID360 point cloud
  │   RealSense      librealsense2       ──► color + depth camera
  └───────────────────────────────────────────┘
```

## Build / run

Everything is built by Nix — no system packages, no manual SDK installs:

```sh
nix run   # first run compiles the SDKs (minutes); cached after
```

The three SDKs that aren't in nixpkgs — `unitree_sdk2`, `Livox-SDK2` — are pinned
as flake inputs (see `flake.lock`), so the build is reproducible without any
hand-managed hashes. `librealsense`, `nlohmann_json`, and `libjpeg_turbo` come
from nixpkgs.

## Runtime configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `G1_NET_IFACE` | `eth0` | Interface the unitree DDS transport binds to |
| `G1_LIDAR_HOST_IP` | `192.168.1.5` | Jetson IP on the MID360 subnet |
| `G1_LIDAR_IP` | `192.168.1.100` | MID360's IP |

The MID360 network config JSON is generated from those at startup — nothing to
ship or hand-edit.

## Protocol

**Commands (stdin):**

| Line | Effect |
| --- | --- |
| `{"type":"move","vx":0.3,"vy":0,"omega":0.2}` | Set continuous velocity (m/s, rad/s) |
| `{"type":"cmd","name":"balancestand"}` | Discrete gait/posture (see below) |
| `{"type":"estop"}` | Zero velocity + `Damp()` immediately |
| `{"type":"config","camera":false,"lidar":true}` | Pause/resume a stream |

Gait names: `damp`, `start`, `standup`, `squat2standup`, `lie2standup`, `sit`,
`zerotorque`, `balancestand`, `highstand`, `lowstand`, `wavehand`, `shakehand`.

**Telemetry (stdout):** `ready`, `status`, `state` (IMU rpy/gyro/accel, battery,
hottest joint), `lidar` (downsampled flat `[x,y,z,…]` cloud + nearest range),
`frame` (base64 JPEG + center depth), `log`, `error`.

## Safety

The control loop only re-issues a velocity while fresh `move` commands keep
arriving (~0.4 s staleness window). If the panel stalls, the pipe closes, or this
process dies, the robot stops on its own — there's no latched motion.

## SDK version note

The unitree_sdk2 accessors for **battery voltage/current** (`power_v()` /
`power_a()` in `unitree_bridge.cpp`) are the fields most likely to be renamed
across SDK tags. If a pinned tag fails to compile there, adjust those two lines;
everything else uses stable API (LocoClient, IMU state, motor temperatures).
