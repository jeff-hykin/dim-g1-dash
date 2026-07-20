// V4L2 webcam → MJPEG-over-HTTP streamer.
//
// Reads the RealSense's color node (or any UVC camera) through the plain Linux
// V4L2 API — no librealsense — so the device behaves like a standard webcam and
// other consumers can keep using the depth/IR nodes. Frames are JPEG-encoded
// (turbojpeg) and served as multipart/x-mixed-replace on a small built-in HTTP
// server; the browser panel points an <img> straight at it, which is real video
// streaming instead of frames over the app-bus websocket.
//
// The capture side is resilient: if the device is missing or busy (EBUSY from
// another process mid-stream) it retries every few seconds until it gets the
// camera, and drops back to retrying if the device errors mid-run.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "protocol.hpp"

namespace g1 {

class Webcam {
public:
    explicit Webcam(Protocol& protocol);
    ~Webcam();

    // Bind the HTTP server and start the capture-retry thread. Returns false
    // only if the server port can't be bound (capture failures just retry).
    bool start();
    void stop();

    // Claim (true) or release (false) the camera. Releasing closes the V4L2
    // device so other programs can grab it; HTTP connections stay open and the
    // stream resumes when re-enabled.
    void set_enabled(bool enabled);

    bool connected() const { return connected_.load(); }
    bool enabled() const { return desired_.load(); }
    int port() const { return port_; }

private:
    std::string pick_device();
    bool open_device(const std::string& path);
    void close_device();
    void capture_loop();
    bool capture_frame();
    void server_loop();
    void client_loop(int client_fd);
    void publish_jpeg(const uint8_t* data, size_t size);

    Protocol& protocol_;
    int port_ = 0;
    uint32_t requested_width_ = 0, requested_height_ = 0;

    std::atomic<bool> running_{false};
    // Exclusive-access device: stay hands-off until the panel asks to connect.
    std::atomic<bool> desired_{false};
    std::atomic<bool> connected_{false};
    std::thread capture_thread_;
    std::thread server_thread_;

    // V4L2 device state (capture thread only).
    bool open_failure_logged_ = false;  // one busy/open error per outage, not per retry
    int device_fd_ = -1;
    uint32_t pixel_format_ = 0;
    uint32_t width_ = 0, height_ = 0;
    struct Buffer { void* start = nullptr; size_t length = 0; };
    std::vector<Buffer> buffers_;
    void* jpeg_compressor_ = nullptr;  // tjhandle
    std::vector<uint8_t> rgb_scratch_;

    // Latest encoded frame, shared with the per-client sender threads.
    std::mutex frame_mutex_;
    std::condition_variable frame_cv_;
    std::vector<uint8_t> latest_jpeg_;
    uint64_t frame_seq_ = 0;

    int server_fd_ = -1;
};

}  // namespace g1
