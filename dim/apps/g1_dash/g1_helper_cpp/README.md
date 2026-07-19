# g1_helper — onboard C++ bridge

The native half of **dim-g1-dash**. It runs *on the G1's Jetson* and talks to the
robot's three hardware interfaces, then multiplexes everything over a simple
newline-JSON protocol on stdio. The Deno backend (`../main.js`) launches it with
`nix run` and relays that protocol to/from the browser panel over the app-bus.

```
stdin  (commands)              stdout (telemetry, one JSON object per line)
  move / cmd / estop / config    ready · status · state · loco · seq · lidar · frame · log · error
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

The two SDKs that aren't in nixpkgs — `unitree_sdk2`, `Livox-SDK2` — are pinned
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
| `{"type":"cmd","name":"stand"}` | Engage sequence: ai mode → damp → ready → advanced |
| `{"type":"cmd","name":"balance","gait":"walk"}` | Engage sequence ending in basic FSM 200 + gait |
| `{"type":"cmd","name":"damp"}` | One-shot posture (see below) |
| `{"type":"estop"}` | Abort any sequence, zero velocity, `Damp()` immediately |
| `{"type":"config","camera":false,"lidar":true}` | Pause/resume a stream |

Sequence names: `stand` (full engage to the advanced controller), `balance`
(full engage to basic FSM 200; `gait` is `static` | `walk` | `run`), `advanced`
(just the R2+A emulation, from get-ready).

One-shot names: `damp`, `ready` (alias `standup`), `squat`, `sit`, `zerotorque`,
`balancestand`, `highstand`, `lowstand`, `wavehand`, `shakehand`. One-shots are
refused while a sequence is running — E-STOP aborts it.

**Telemetry (stdout):** `ready`, `status`, `state` (IMU rpy/gyro/accel, hottest
joint, FSM machine), `loco` (1 Hz: loco FSM id, resident motion service, mode
label), `seq` (engage-sequence step progress), `lidar` (downsampled flat
`[x,y,z,…]` cloud + nearest range), `frame` (base64 JPEG + center depth), `log`,
`error`.

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
