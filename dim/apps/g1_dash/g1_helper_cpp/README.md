# g1_helper — onboard C++ bridge

The native half of **dim-g1-dash**. It runs *on the G1's Jetson* and talks to the
robot's three hardware interfaces, then multiplexes everything over a simple
newline-JSON protocol on stdio. The Deno backend (`../main.js`) launches it with
`nix run` and relays that protocol to/from the browser panel over the app-bus.

```
stdin  (commands)              stdout (telemetry, one JSON object per line)
  move / cmd / estop / config    ready · status · state · loco · seq · lidar · log · error
        │                              ▲
        ▼                              │
  ┌───────────────────────────────────────────┐
  │  g1_helper (C++)                           │
  │   UnitreeBridge  unitree_sdk2 (DDS)  ──► G1 locomotion + low state
  │   Mid360         Livox-SDK2          ──► MID360 point cloud
  │   Webcam         plain V4L2 + turbojpeg ──► MJPEG video on its own HTTP port
  └───────────────────────────────────────────┘
```

The camera is read through the **plain Linux V4L2 API** (no librealsense): the
helper auto-picks the first `/dev/video*` node that can stream YUYV or MJPG —
on the G1 that's the RealSense's color node — and serves it as
`multipart/x-mixed-replace` MJPEG on its own HTTP port. The panel points an
`<img>` straight at it: continuous video, no frames over the app-bus. Using the
webcam API leaves the RealSense's depth/IR nodes free for other consumers, and
if the color node is busy or unplugged the helper just retries every few
seconds until it gets it.

## Build / run

Everything is built by Nix — no system packages, no manual SDK installs:

```sh
nix run   # first run compiles the SDKs (minutes); cached after
```

The two SDKs that aren't in nixpkgs — `unitree_sdk2`, `Livox-SDK2` — are pinned
as flake inputs (see `flake.lock`), so the build is reproducible without any
hand-managed hashes. `nlohmann_json` and `libjpeg_turbo` come from nixpkgs.

## Runtime configuration (env vars)

| Var | Default | Meaning |
| --- | --- | --- |
| `G1_NET_IFACE` | auto | Interface for unitree DDS (auto: the one on the robot LAN, else `eth0`) |
| `G1_LIDAR_IP` | `192.168.123.120` | MID360's IP (G1 stock address) |
| `G1_LIDAR_HOST_IP` | auto | Local IP on the lidar subnet (auto: the one sharing the lidar's /24) |
| `G1_CAM_DEVICE` | auto | V4L2 node to stream (else first matching YUYV/MJPG-capable one) |
| `G1_CAM_MATCH` | `RealSense` | Auto-pick only cameras whose name contains this (`""` = any camera) |
| `G1_CAM_PORT` | `8190` | Port for the MJPEG HTTP stream |
| `G1_CAM_WIDTH` × `G1_CAM_HEIGHT` | `848`×`480` | Capture size — keep 16:9 for the full FOV (4:3 center-crops) |

The startup status event reports `onboard` (an interface on the robot LAN
exists) and `remote` (on the robot LAN but not a Jetson — e.g. a laptop plugged
into the robot). Off-LAN, the panel shows setup guidance instead of dead
widgets; remote, everything except the local camera works.

**Exclusive devices — nothing is claimed by default.** Both the MID360 and the
camera are exclusive-access, so the helper starts with both released and only
claims one when the panel asks (`config` with `lidar`/`camera`: true — one click
on the panel's chips). Releasing hands the device back to other programs.

- *MID360:* the Livox-SDK2 binds fixed UDP host ports (56000 detection +
  56101/56201/56301/56401 data), so only **one process per host** can own the
  lidar. If a SLAM stack (e.g. point-lio) is running, a connect attempt reports
  the conflict once and retries every 10 s, picking the lidar up when the other
  client exits. The reverse also holds: while this helper owns the MID360,
  other Livox clients on this host can't start.
- *Camera:* a V4L2 capture node can only stream to one process. On a stock G1,
  Unitree's own `videohub` service claims the RealSense color node at boot — a
  connect attempt reports that once and retries quietly until the node frees up.

The MID360 network config JSON is generated from those at startup — nothing to
ship or hand-edit.

## Protocol

**Commands (stdin):**

| Line | Effect |
| --- | --- |
| `{"type":"move","vx":0.3,"vy":0,"omega":0.2}` | Set continuous velocity (m/s, rad/s) |
| `{"type":"cmd","name":"stand"}` | Engage sequence: ai mode → damp → ready → advanced |
| `{"type":"cmd","name":"balance","gait":"walk"}` | Engage sequence ending in basic FSM 200 + gait |
| `{"type":"cmd","name":"damp"}` | One-shot posture (see below) |
| `{"type":"estop"}` | Abort any sequence, zero velocity, `Damp()` immediately |
| `{"type":"config","camera":false,"lidar":true}` | Claim (`true`) / release (`false`) an exclusive device |

Sequence names: `stand` (full engage to the advanced controller), `balance`
(full engage to basic FSM 200; `gait` is `static` | `walk` | `run`), `advanced`
(just the R2+A emulation, from get-ready).

One-shot names: `damp`, `ready` (alias `standup`), `squat`, `sit`, `zerotorque`,
`balancestand`, `highstand`, `lowstand`, `wavehand`, `waveturn`, `shakehand`.
One-shots are refused while a sequence is running — E-STOP aborts it. The SDK
reports refusals as nonzero return codes; the helper surfaces them as `error`
events (e.g. `command 'wavehand' refused by the robot (code=7303)`).

**Telemetry (stdout):** `ready`, `status` (subsystem up/down, `onboard` /
`remote` machine detection, `camWanted` / `lidarWanted` claim state, `camPort`
for the MJPEG stream), `state` (battery `soc` from `rt/lf/bmsstate`, IMU
rpy/gyro/accel, hottest joint, FSM machine), `loco` (1 Hz: loco FSM id, resident
motion service, mode label), `seq` (engage-sequence step progress), `lidar`
(flat `[x,y,z,…]` cloud accumulated over the last ~4 s + nearest range; the
points are already flipped for the G1's upside-down lidar mount), `log`,
`error`. Video is **not** on stdout — it streams from the MJPEG port.

## The stand sequence (ported from dimos `bin/g1_stand`)

Controller equivalents:

```
L2+B  -> damp                (FSM 1, no movement)
L2+Up -> get ready           (FSM 4, legs straighten)
R2+A  -> advanced balance    (FSM 801/802, the natural walking controller)
```

The advanced controller can ONLY be entered the way the physical remote does it:
a held R2+A published on `rt/wirelesscontroller`. The loco DDS API silently
refuses `SetFsmId(801)` and can only reach the basic controller (FSM 200,
stompier gaits) — that path is the `balance` sequence. Mode switching (to the
"ai" motion service) is only performed while damped, and each FSM step re-sends
`SetFsmId` until the reported id matches, because the FSM ignores requests while
a transition is still in flight.

**SAFETY:** during `stand`/`balance` the robot straightens its legs and then
takes torque control to balance. Use with the G1 on a gantry, or on flat ground
with space around it.

## Safety

The control loop only re-issues a velocity while fresh `move` commands keep
arriving (~0.4 s staleness window). If the panel stalls, the pipe closes, or this
process dies, the robot stops on its own — there's no latched motion. Process
exit deliberately does **not** damp: collapsing a balanced robot because the
dashboard restarted would be worse than leaving the onboard controller in charge.

Command danger tiers (surfaced as confirmation dialogs in the panel):
**dangerous** — `damp` / `zerotorque` (the robot goes limp and falls if
standing) and `stand` / `balance` (self-balancing: the robot takes torque
control); **not dangerous** — gait switching (`SetBalanceMode`) and `ready`
(the stiffen/leg-straighten step before balancing), postures, hand gestures.
