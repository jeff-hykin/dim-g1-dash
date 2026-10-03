// Livox MID360 lidar reader.
//
// The Livox-SDK2 delivers small point packets on its own network thread at a high
// rate. We stride-sample them into per-cycle slices, keep a few seconds of slices
// (a single 200 ms slice of a MID360 sweep is too sparse to read), and emit a
// {"type":"lidar"} event a few times a second with the accumulated cloud plus the
// nearest planar obstacle distance.
//
// The MID360 is mounted upside down on the G1, so ingest() undoes the 180° roll
// (y and z negated) — the emitted cloud is right side up, x forward, z up.
//
// Network config: the SDK needs a JSON describing the host/lidar IPs and ports.
// We generate it at start() from env vars so no file has to be shipped:
//   G1_LIDAR_IP       the MID360's IP            (default 192.168.123.120, the G1 stock address)
//   G1_LIDAR_HOST_IP  the Jetson's IP on the lidar subnet (default: auto-detected
//                     from the local interface sharing the lidar's /24)
//
// EXCLUSIVITY: the Livox-SDK2 binds fixed UDP host ports (56000 detection +
// 56101/56201/56301/56401 data), so only ONE process per host can own the
// MID360 — if a SLAM stack (e.g. point-lio) is running, init fails. While
// enabled we retry in the background and pick the lidar up whenever the other
// client releases it; set_enabled(false) releases it for other programs.
#pragma once

#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "protocol.hpp"

namespace g1 {

// Stock MID360 address on a Unitree G1 (the robot LAN is 192.168.123.0/24).
inline constexpr char kDefaultLidarIp[] = "192.168.123.120";

// The local address sharing `lidar_ip`'s /24, or "" if this machine has no
// interface on that subnet. Doubles as the are-we-on-the-robot-LAN probe.
std::string detect_host_ip(const std::string& lidar_ip);

// Name of the interface holding that address ("" if none) — the right one to
// bind DDS to: eth0 on the Jetson itself, but anything on a laptop plugged
// into the robot LAN.
std::string detect_robot_interface(const std::string& lidar_ip);

class Mid360 {
public:
    explicit Mid360(Protocol& protocol);
    ~Mid360();

    bool start();
    void stop();

    // Claim (true) or release (false) the lidar. Releasing uninitializes the
    // Livox SDK so other programs (e.g. point-lio) can take the MID360.
    void set_enabled(bool on) { desired_.store(on); }
    bool connected() const { return connected_.load(); }
    bool enabled() const { return desired_.load(); }

    // Called by the SDK trampoline with a decoded packet's points (already in
    // meters). Internal, but public so the C callback can reach it via `this`.
    void ingest(const float* xyz, uint32_t point_count);

private:
    void emit_loop();
    void manage_loop();
    std::string write_config_file();

    Protocol& protocol_;
    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    // Exclusive-access device: stay hands-off until the panel asks to connect.
    std::atomic<bool> desired_{false};
    std::thread emit_thread_;
    std::thread manage_thread_;

    std::mutex points_mutex_;
    std::vector<std::array<float, 3>> points_;  // current slice, swapped out each emit
    float nearest_ = -1.0f;                     // planar min range, meters
    uint64_t total_ingested_ = 0;               // points seen since last emit

    // Rolling accumulation window (emit thread only).
    struct Slice {
        std::chrono::steady_clock::time_point stamp;
        std::vector<std::array<float, 3>> points;
    };
    std::deque<Slice> history_;
    bool cloud_on_screen_ = false;  // emit one empty cloud after the last slice ages out
};

}  // namespace g1
