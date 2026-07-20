// unitree_sdk2 bridge for the Unitree G1.
//
// Three halves:
//   * telemetry  — subscribe to the G1 low-level state (rt/lowstate, hg IDL) and
//                  emit throttled {"type":"state"} events (IMU rpy, joint temps);
//                  poll the loco service for FSM id / motion mode / balance mode
//                  and emit {"type":"loco"} events.
//   * control    — a LocoClient (the G1 high-level locomotion service). A control
//                  thread re-issues the latest velocity at a fixed rate so holding
//                  a direction keeps the robot walking; discrete gaits (ready, sit,
//                  damp, wave, …) are dispatched immediately.
//   * sequences  — the bin/g1_stand engage flow, translated from Python. "stand"
//                  runs: ensure the "ai" motion service is resident (switching
//                  while damped) → damp (FSM 1) → get-ready (FSM 4) → emulate a
//                  held R2+A on rt/wirelesscontroller until the advanced
//                  balance controller (FSM 801/802) engages. Only the advanced
//                  controller walks naturally and it can ONLY be entered the way
//                  the physical remote does it — SetFsmId(801) is silently
//                  refused. "balance" is the basic fallback: FSM 200 + a gait
//                  (static/walk/run) via SetBalanceMode. Sequences run on their
//                  own thread (they take tens of seconds) and stream progress
//                  as {"type":"seq"} events; estop aborts them.
#pragma once

#include <atomic>
#include <chrono>
#include <mutex>
#include <string>
#include <thread>

#include "protocol.hpp"

namespace g1 {

class UnitreeBridge {
public:
    UnitreeBridge(Protocol& protocol, std::string network_interface);
    ~UnitreeBridge();

    // Init DDS on `network_interface`, subscribe to low state, connect LocoClient.
    // Returns false (and emits an error) if the locomotion service is unreachable.
    bool start();
    void stop();

    // Continuous drive: remembered and re-sent by the control loop until changed.
    // vx: forward m/s, vy: left m/s, omega: yaw rad/s.
    void set_velocity(double vx, double vy, double omega);

    // Discrete command by name. One-shots (damp, ready, sit, squat, zerotorque,
    // wavehand, shakehand, highstand, lowstand) run inline; sequences (stand,
    // balance, advanced) spawn the sequence thread. `gait` applies to "balance"
    // only (static | walk | run). Returns false for an unknown name or when a
    // sequence is already in progress.
    bool command(const std::string& name, const std::string& gait = "static");

    // Immediate soft-stop: abort any sequence, zero the velocity target, Damp.
    void estop();

    bool connected() const { return connected_.load(); }

private:
    void on_low_state(const void* message);
    void control_loop();
    void status_loop();

    // g1_stand sequence machinery — all run on sequence_thread_.
    void run_sequence(std::string name, std::string gait);
    bool run_fsm_step(const std::string& step, int fsm_id);
    bool engage_advanced();
    bool ensure_ai_mode();
    bool set_gait(const std::string& gait);
    void press_combo(uint16_t keys, double seconds);
    int query_fsm_id();
    int query_balance_mode();
    std::string query_motion_mode();
    void emit_seq(const std::string& step, const std::string& state);
    bool aborted() const { return sequence_abort_.load() || !running_.load(); }

    Protocol& protocol_;
    std::string network_interface_;

    // SDK clients are heap-held behind void* so this header stays free of the
    // unitree_sdk2 includes (they pull in DDS headers project-wide otherwise).
    void* loco_client_ = nullptr;
    void* motion_switcher_ = nullptr;
    void* wireless_publisher_ = nullptr;
    void* low_state_subscriber_ = nullptr;
    void* bms_subscriber_ = nullptr;

    // The loco/motion-switcher RPC clients are shared by the control, status and
    // sequence threads; serialize every Call through this.
    std::mutex rpc_mutex_;

    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    std::thread control_thread_;
    std::thread status_thread_;

    std::thread sequence_thread_;
    std::atomic<bool> sequence_running_{false};
    std::atomic<bool> sequence_abort_{false};
    std::string sequence_name_;

    // Latest commanded velocity, guarded by velocity_mutex_.
    std::mutex velocity_mutex_;
    double vx_ = 0.0, vy_ = 0.0, omega_ = 0.0;
    std::chrono::steady_clock::time_point last_velocity_cmd_{};

    // Mode label tracked from the last discrete command / sequence we issued.
    std::mutex mode_mutex_;
    std::string mode_ = "unknown";

    // Throttle for {"type":"state"} emission off the DDS callback.
    std::chrono::steady_clock::time_point last_state_emit_{};

    // Battery state of charge (%) from rt/lf/bmsstate; -1 until the first message.
    std::atomic<int> battery_soc_{-1};
};

}  // namespace g1
