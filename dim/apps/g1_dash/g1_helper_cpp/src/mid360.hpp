// Livox MID360 lidar reader.
//
// The Livox-SDK2 delivers small point packets on its own network thread at a high
// rate. We stride-sample them into a capped buffer and, a few times a second, emit
// a {"type":"lidar"} event with a downsampled cloud (for the panel's 3D view) plus
// the nearest planar obstacle distance (for a quick proximity readout).
//
// Network config: the SDK needs a JSON describing the host/lidar IPs and ports.
// We generate it at start() from env vars so no file has to be shipped:
//   G1_LIDAR_HOST_IP  the Jetson's IP on the lidar subnet   (default 192.168.1.5)
//   G1_LIDAR_IP       the MID360's IP                        (default 192.168.1.100)
#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "protocol.hpp"

namespace g1 {

class Mid360 {
public:
    explicit Mid360(Protocol& protocol);
    ~Mid360();

    bool start();
    void stop();

    void set_streaming(bool on) { streaming_.store(on); }
    bool connected() const { return connected_.load(); }

    // Called by the SDK trampoline with a decoded packet's points (already in
    // meters). Internal, but public so the C callback can reach it via `this`.
    void ingest(const float* xyz, uint32_t point_count);

private:
    void emit_loop();
    std::string write_config_file();

    Protocol& protocol_;
    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    std::atomic<bool> streaming_{true};
    std::thread emit_thread_;

    std::mutex points_mutex_;
    std::vector<std::array<float, 3>> points_;  // capped, cleared each emit
    float nearest_ = -1.0f;                     // planar min range, meters
    uint64_t total_ingested_ = 0;               // points seen since last emit
};

}  // namespace g1
