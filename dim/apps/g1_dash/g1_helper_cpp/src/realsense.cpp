#include "realsense.hpp"

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include <librealsense2/rs.hpp>
#include <turbojpeg.h>

namespace g1 {

namespace {

constexpr int kWidth = 640;
constexpr int kHeight = 480;
constexpr int kFps = 30;
constexpr int kJpegQuality = 70;
// Send at most this often even if the camera runs faster — a dashboard doesn't
// need 30 fps and the base64 frames dominate the app-bus otherwise.
constexpr auto kEmitPeriod = std::chrono::milliseconds(66);  // ~15 fps

const char kBase64Alphabet[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

std::string base64_encode(const unsigned char* data, size_t length) {
    std::string out;
    out.reserve(((length + 2) / 3) * 4);
    size_t i = 0;
    for (; i + 2 < length; i += 3) {
        const uint32_t triple = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
        out.push_back(kBase64Alphabet[(triple >> 18) & 0x3F]);
        out.push_back(kBase64Alphabet[(triple >> 12) & 0x3F]);
        out.push_back(kBase64Alphabet[(triple >> 6) & 0x3F]);
        out.push_back(kBase64Alphabet[triple & 0x3F]);
    }
    if (i < length) {
        uint32_t triple = data[i] << 16;
        if (i + 1 < length) triple |= data[i + 1] << 8;
        out.push_back(kBase64Alphabet[(triple >> 18) & 0x3F]);
        out.push_back(kBase64Alphabet[(triple >> 12) & 0x3F]);
        out.push_back(i + 1 < length ? kBase64Alphabet[(triple >> 6) & 0x3F] : '=');
        out.push_back('=');
    }
    return out;
}

}  // namespace

RealSense::RealSense(Protocol& protocol) : protocol_(protocol) {}

RealSense::~RealSense() { stop(); }

bool RealSense::start() {
    running_.store(true);
    capture_thread_ = std::thread(&RealSense::capture_loop, this);
    return true;
}

void RealSense::stop() {
    running_.store(false);
    if (capture_thread_.joinable()) capture_thread_.join();
    connected_.store(false);
}

void RealSense::capture_loop() {
    rs2::pipeline pipeline;
    rs2::config config;
    config.enable_stream(RS2_STREAM_COLOR, kWidth, kHeight, RS2_FORMAT_RGB8, kFps);
    config.enable_stream(RS2_STREAM_DEPTH, kWidth, kHeight, RS2_FORMAT_Z16, kFps);

    try {
        pipeline.start(config);
    } catch (const rs2::error& err) {
        protocol_.error(std::string("realsense: start failed — ") + err.what());
        return;
    }
    connected_.store(true);
    protocol_.log("realsense camera up");

    tjhandle jpeg = tjInitCompress();
    auto last_emit = std::chrono::steady_clock::now();

    while (running_.load()) {
        rs2::frameset frames;
        try {
            frames = pipeline.wait_for_frames(1000);
        } catch (const rs2::error&) {
            continue;  // timeout / transient — try again
        }
        if (!streaming_.load()) continue;

        const auto now = std::chrono::steady_clock::now();
        if (now - last_emit < kEmitPeriod) continue;
        last_emit = now;

        rs2::video_frame color = frames.get_color_frame();
        rs2::depth_frame depth = frames.get_depth_frame();
        if (!color) continue;

        unsigned char* jpeg_buffer = nullptr;
        unsigned long jpeg_size = 0;
        const int rc = tjCompress2(
            jpeg, static_cast<const unsigned char*>(color.get_data()),
            kWidth, 0 /*pitch: tightly packed*/, kHeight, TJPF_RGB,
            &jpeg_buffer, &jpeg_size, TJSAMP_420, kJpegQuality, TJFLAG_FASTDCT);
        if (rc != 0) continue;

        const std::string encoded = base64_encode(jpeg_buffer, jpeg_size);
        tjFree(jpeg_buffer);

        const float center_depth = depth ? depth.get_distance(kWidth / 2, kHeight / 2) : -1.0f;

        protocol_.emit({
            {"type", "frame"},
            {"w", kWidth},
            {"h", kHeight},
            {"centerDepth", center_depth},
            {"jpeg", encoded},
        });
    }

    tjDestroy(jpeg);
    pipeline.stop();
}

}  // namespace g1
