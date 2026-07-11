// unitree_sdk2 bridge for the Unitree G1.
//
// Two halves:
//   * telemetry  — subscribe to the G1 low-level state (rt/lowstate, hg IDL) and
//                  emit throttled {"type":"state"} events (IMU rpy, joint temps,
//                  battery). The DDS transport delivers on its own callback thread.
//   * control    — a LocoClient (the G1 high-level locomotion service). A control
//                  thread re-issues the latest velocity at a fixed rate so holding
//                  a direction keeps the robot walking; discrete gaits (stand, sit,
//                  damp, wave, …) are dispatched immediately.
//
// Note on SDK versions: field/method names below follow the current unitree_sdk2
// (hg humanoid IDL + g1 LocoClient). If you pin an older tag, a couple of state
// accessors (battery voltage/current) may need renaming — they're isolated in
// unitree_bridge.cpp and flagged there.
#pragma once

#include <atomic>
#include <chrono>
#include <memory>
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

    // Discrete gait / posture commands by name (damp, start, standup, sit,
    // zerotorque, balancestand, highstand, lowstand, wavehand, shakehand,
    // lie2standup, squat2standup). Returns false for an unknown name.
    bool command(const std::string& name);

    // Immediate soft-stop: zero the velocity target and Damp the robot.
    void estop();

    bool connected() const { return connected_.load(); }

private:
    void on_low_state(const void* message);
    void control_loop();

    Protocol& protocol_;
    std::string network_interface_;

    // LocoClient is heap-held behind a void* so this header stays free of the
    // unitree_sdk2 includes (they pull in DDS headers project-wide otherwise).
    void* loco_client_ = nullptr;
    void* low_state_subscriber_ = nullptr;

    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    std::thread control_thread_;

    // Latest commanded velocity, guarded by velocity_mutex_.
    std::mutex velocity_mutex_;
    double vx_ = 0.0, vy_ = 0.0, omega_ = 0.0;
    std::chrono::steady_clock::time_point last_velocity_cmd_{};

    // Mode label tracked from the last discrete command we issued (the low-level
    // state doesn't expose a clean high-level mode enum for the G1).
    std::mutex mode_mutex_;
    std::string mode_ = "unknown";

    // Throttle for {"type":"state"} emission off the DDS callback.
    std::chrono::steady_clock::time_point last_state_emit_{};
};

}  // namespace g1
