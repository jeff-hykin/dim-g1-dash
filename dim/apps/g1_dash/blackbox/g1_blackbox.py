#!/usr/bin/env python3
# G1 black box: a 15 MB rolling jsonl of FSM, IMU, joint angles and motor temps.
#
# Read-only — it only subscribes to rt/lowstate and asks the loco service for its
# FSM id; it never commands the robot. Runs on the Jetson from ~/dimos/.venv
# (which has unitree_sdk2py), independent of the dash, so it keeps recording
# when the dash or its helper is down.
#
#   blackbox.jsonl + blackbox.1.jsonl   two halves of 7.5 MB, ~1 h at 10 Hz
#   falls/<utc>.jsonl                   the last 1 MB (~4 min), frozen 5 s after
#                                       the FSM changes or the torso tips past 45°
#
# One line per sample (10 Hz):
#   {"t": iso utc, "tick": ms, "fsm": loco FSM id, "mm": mode_machine,
#    "rpy": [rad], "gyro": [rad/s], "acc": [m/s²], "q": [29 rad], "temp": [29 °C]}
import argparse
import json
import math
import os
import threading
import time
from datetime import datetime, timezone

from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelSubscriber
from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient
from unitree_sdk2py.idl.unitree_hg.msg.dds_ import LowState_

JOINT_COUNT = 29
HALF_BYTES = 15 * 1024 * 1024 // 2
FALL_BYTES = 1024 * 1024
SAMPLE_PERIOD = 0.1
FSM_PERIOD = 0.5
TIP_RAD = math.radians(45)
FREEZE_DELAY = 5.0
FALLS_KEPT = 10


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class BlackBox:
    def __init__(self, directory):
        self.directory = directory
        self.falls_dir = os.path.join(directory, "falls")
        os.makedirs(self.falls_dir, exist_ok=True)
        self.path = os.path.join(directory, "blackbox.jsonl")
        self.old_path = os.path.join(directory, "blackbox.1.jsonl")
        self.file = open(self.path, "a", buffering=1)
        self.lock = threading.Lock()
        self.latest = None
        self.fsm = None
        self.freeze_at = None
        self.tipped = None  # None until the first sample, so starting up lying down isn't a fall

    def on_low_state(self, message):
        self.latest = message

    def poll_fsm(self):
        loco = LocoClient()
        loco.SetTimeout(1.0)
        loco.Init()
        while True:
            try:
                code, fsm = loco.GetFsmId()
                fsm = fsm if code == 0 else None
            except Exception:
                fsm = None
            if fsm is not None and self.fsm is not None and fsm != self.fsm:
                self.write_event({"event": "fsm", "from": self.fsm, "to": fsm})
                self.arm_freeze()
            if fsm is not None:
                self.fsm = fsm
            time.sleep(FSM_PERIOD)

    def arm_freeze(self):
        if self.freeze_at is None:
            self.freeze_at = time.monotonic() + FREEZE_DELAY

    def write_line(self, record):
        with self.lock:
            self.file.write(json.dumps(record, separators=(",", ":")) + "\n")
            if self.file.tell() >= HALF_BYTES:
                self.file.close()
                os.replace(self.path, self.old_path)
                self.file = open(self.path, "a", buffering=1)

    def write_event(self, fields):
        self.write_line({"t": utc_now(), **fields})

    def freeze(self):
        with self.lock:
            self.file.flush()
            name = os.path.join(self.falls_dir, utc_now().replace(":", "-") + ".jsonl")
            tail = b""
            for part in (self.old_path, self.path):
                if os.path.exists(part):
                    with open(part, "rb") as source:
                        tail = (tail + source.read())[-FALL_BYTES:]
            # drop the partial first line the byte cut left behind
            tail = tail[tail.find(b"\n") + 1:] if len(tail) == FALL_BYTES else tail
            with open(name, "wb") as out:
                out.write(tail)
        for stale in sorted(os.listdir(self.falls_dir))[:-FALLS_KEPT]:
            os.remove(os.path.join(self.falls_dir, stale))

    def sample(self):
        state = self.latest
        if state is None:
            return
        imu = state.imu_state
        roll, pitch, yaw = imu.rpy
        motors = state.motor_state[:JOINT_COUNT]
        self.write_line({
            "t": utc_now(),
            "tick": state.tick,
            "fsm": self.fsm,
            "mm": state.mode_machine,
            "rpy": [round(roll, 3), round(pitch, 3), round(yaw, 3)],
            "gyro": [round(v, 2) for v in imu.gyroscope],
            "acc": [round(v, 2) for v in imu.accelerometer],
            "q": [round(m.q, 3) for m in motors],
            "temp": [max(m.temperature) for m in motors],
        })
        tipped = abs(roll) > TIP_RAD or abs(pitch) > TIP_RAD
        if tipped and self.tipped is False:
            self.write_event({"event": "tipped", "roll": round(roll, 3), "pitch": round(pitch, 3)})
            self.arm_freeze()
        self.tipped = tipped
        if self.freeze_at is not None and time.monotonic() >= self.freeze_at:
            self.freeze_at = None
            self.freeze()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iface", default="eth0")
    parser.add_argument("--dir", default=os.path.expanduser("~/.dimos/logs/blackbox"))
    args = parser.parse_args()

    ChannelFactoryInitialize(0, args.iface)
    box = BlackBox(args.dir)
    subscriber = ChannelSubscriber("rt/lowstate", LowState_)
    subscriber.Init(box.on_low_state, 10)
    threading.Thread(target=box.poll_fsm, daemon=True).start()
    box.write_event({"event": "start"})

    next_tick = time.monotonic()
    while True:
        box.sample()
        next_tick += SAMPLE_PERIOD
        time.sleep(max(0.0, next_tick - time.monotonic()))


if __name__ == "__main__":
    main()
