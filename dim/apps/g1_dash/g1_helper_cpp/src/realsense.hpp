// Intel RealSense reader.
//
// Runs a pipeline (color + depth) on its own thread. Each frame the color image
// is JPEG-encoded (turbojpeg) and base64'd into a {"type":"frame"} event for the
// panel's live view; the depth frame contributes a single center-pixel distance
// readout. Frame rate to the panel is throttled independently of the camera's
// capture rate, and streaming can be paused to save bandwidth when the view is
// hidden.
#pragma once

#include <atomic>
#include <string>
#include <thread>

#include "protocol.hpp"

namespace g1 {

class RealSense {
public:
    explicit RealSense(Protocol& protocol);
    ~RealSense();

    bool start();
    void stop();

    void set_streaming(bool on) { streaming_.store(on); }
    bool connected() const { return connected_.load(); }

private:
    void capture_loop();

    Protocol& protocol_;
    std::atomic<bool> connected_{false};
    std::atomic<bool> running_{false};
    std::atomic<bool> streaming_{true};
    std::thread capture_thread_;
};

}  // namespace g1
