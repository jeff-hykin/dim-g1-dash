#include "webcam.hpp"

#include <algorithm>
#include <cerrno>
#include <cstdlib>
#include <cstring>

#include <arpa/inet.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <turbojpeg.h>
#include <unistd.h>

namespace g1 {

namespace {

constexpr int kDefaultPort = 8190;
// 16:9 uses the RealSense color sensor's full field of view — 4:3 modes
// (e.g. 640x480) are a center-crop that visibly narrows the FOV. 848x480
// keeps the full width at the same 60 fps rate as 640x480.
constexpr uint32_t kDefaultWidth = 848;
constexpr uint32_t kDefaultHeight = 480;
constexpr uint32_t kBufferCount = 4;
constexpr int kJpegQuality = 80;
constexpr auto kRetryDelay = std::chrono::seconds(5);
constexpr int kMaxDeviceIndex = 15;
// select() timeout on the capture fd — a stuck device falls back to retry.
constexpr int kFrameWaitSec = 2;

int xioctl(int fd, unsigned long request, void* arg) {
    int result;
    do { result = ioctl(fd, request, arg); } while (result == -1 && errno == EINTR);
    return result;
}

std::string env_or(const char* key, const std::string& fallback) {
    const char* value = std::getenv(key);
    return value && *value ? std::string(value) : fallback;
}

// BT.601 YUYV 4:2:2 → packed RGB.
void yuyv_to_rgb(const uint8_t* yuyv, uint8_t* rgb, uint32_t width, uint32_t height) {
    const size_t pairs = static_cast<size_t>(width) * height / 2;
    for (size_t i = 0; i < pairs; ++i) {
        const int y0 = yuyv[i * 4 + 0] - 16;
        const int u = yuyv[i * 4 + 1] - 128;
        const int y1 = yuyv[i * 4 + 2] - 16;
        const int v = yuyv[i * 4 + 3] - 128;
        const int rd = 409 * v + 128;
        const int gd = -100 * u - 208 * v + 128;
        const int bd = 516 * u + 128;
        auto clamp = [](int value) -> uint8_t {
            return static_cast<uint8_t>(std::clamp(value, 0, 255));
        };
        const int c0 = 298 * y0, c1 = 298 * y1;
        rgb[i * 6 + 0] = clamp((c0 + rd) >> 8);
        rgb[i * 6 + 1] = clamp((c0 + gd) >> 8);
        rgb[i * 6 + 2] = clamp((c0 + bd) >> 8);
        rgb[i * 6 + 3] = clamp((c1 + rd) >> 8);
        rgb[i * 6 + 4] = clamp((c1 + gd) >> 8);
        rgb[i * 6 + 5] = clamp((c1 + bd) >> 8);
    }
}

bool send_all(int fd, const void* data, size_t size) {
    const char* cursor = static_cast<const char*>(data);
    while (size > 0) {
        const ssize_t sent = send(fd, cursor, size, MSG_NOSIGNAL);
        if (sent <= 0) return false;
        cursor += sent;
        size -= static_cast<size_t>(sent);
    }
    return true;
}

}  // namespace

Webcam::Webcam(Protocol& protocol) : protocol_(protocol) {
    port_ = std::atoi(env_or("G1_CAM_PORT", std::to_string(kDefaultPort)).c_str());
    requested_width_ = static_cast<uint32_t>(
        std::atoi(env_or("G1_CAM_WIDTH", std::to_string(kDefaultWidth)).c_str()));
    requested_height_ = static_cast<uint32_t>(
        std::atoi(env_or("G1_CAM_HEIGHT", std::to_string(kDefaultHeight)).c_str()));
}

Webcam::~Webcam() { stop(); }

bool Webcam::start() {
    server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd_ < 0) {
        protocol_.error("webcam: socket() failed");
        return false;
    }
    const int reuse = 1;
    setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(static_cast<uint16_t>(port_));
    if (bind(server_fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 ||
        listen(server_fd_, 8) < 0) {
        protocol_.error("webcam: cannot bind MJPEG port " + std::to_string(port_));
        close(server_fd_);
        server_fd_ = -1;
        return false;
    }

    running_.store(true);
    capture_thread_ = std::thread(&Webcam::capture_loop, this);
    server_thread_ = std::thread(&Webcam::server_loop, this);
    protocol_.log("webcam: MJPEG server on :" + std::to_string(port_));
    return true;
}

void Webcam::stop() {
    running_.store(false);
    frame_cv_.notify_all();
    if (server_fd_ >= 0) {
        shutdown(server_fd_, SHUT_RDWR);
        close(server_fd_);
        server_fd_ = -1;
    }
    if (server_thread_.joinable()) server_thread_.join();
    if (capture_thread_.joinable()) capture_thread_.join();
    close_device();
}

void Webcam::set_enabled(bool enabled) { desired_.store(enabled); }

// Find a V4L2 node that can actually stream YUYV or MJPG video. On the G1 that
// is the RealSense color node (its depth/IR/metadata siblings expose Z16/GREY
// or no capture formats at all). Auto-pick only considers devices whose card
// name matches G1_CAM_MATCH (default "RealSense") — without it, running the
// dash on a laptop would stream the laptop's own webcam as "the G1 camera".
// G1_CAM_DEVICE forces a specific node; G1_CAM_MATCH="" allows any camera.
std::string Webcam::pick_device() {
    const std::string forced = env_or("G1_CAM_DEVICE", "");
    if (!forced.empty()) return forced;
    const char* match_env = std::getenv("G1_CAM_MATCH");
    const std::string card_match = match_env ? match_env : "RealSense";
    for (int index = 0; index <= kMaxDeviceIndex; ++index) {
        const std::string path = "/dev/video" + std::to_string(index);
        const int fd = open(path.c_str(), O_RDWR | O_NONBLOCK);
        if (fd < 0) continue;
        v4l2_capability capability{};
        if (xioctl(fd, VIDIOC_QUERYCAP, &capability) == 0 &&
            (capability.device_caps & V4L2_CAP_VIDEO_CAPTURE) &&
            (capability.device_caps & V4L2_CAP_STREAMING) &&
            (card_match.empty() ||
             std::strstr(reinterpret_cast<const char*>(capability.card), card_match.c_str()))) {
            for (uint32_t format_index = 0;; ++format_index) {
                v4l2_fmtdesc format{};
                format.index = format_index;
                format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
                if (xioctl(fd, VIDIOC_ENUM_FMT, &format) != 0) break;
                if (format.pixelformat == V4L2_PIX_FMT_YUYV ||
                    format.pixelformat == V4L2_PIX_FMT_MJPEG) {
                    close(fd);
                    return path;
                }
            }
        }
        close(fd);
    }
    return "";
}

bool Webcam::open_device(const std::string& path) {
    device_fd_ = open(path.c_str(), O_RDWR);
    if (device_fd_ < 0) {
        if (!open_failure_logged_) {
            open_failure_logged_ = true;
            protocol_.error("webcam: cannot open " + path + " (" + std::strerror(errno) + ")");
        }
        return false;
    }

    v4l2_format format{};
    format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    format.fmt.pix.width = requested_width_;
    format.fmt.pix.height = requested_height_;
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
    format.fmt.pix.field = V4L2_FIELD_NONE;
    if (xioctl(device_fd_, VIDIOC_S_FMT, &format) != 0) {
        format.fmt.pix.pixelformat = V4L2_PIX_FMT_MJPEG;
        if (xioctl(device_fd_, VIDIOC_S_FMT, &format) != 0) {
            if (!open_failure_logged_) {
                open_failure_logged_ = true;
                protocol_.error("webcam: " + path + " is busy (" + std::strerror(errno) +
                                ") — another process owns the camera. On a stock G1 that is "
                                "Unitree's videohub service; retrying quietly until it's free.");
            }
            close_device();
            return false;
        }
    }
    pixel_format_ = format.fmt.pix.pixelformat;
    width_ = format.fmt.pix.width;
    height_ = format.fmt.pix.height;

    v4l2_requestbuffers request{};
    request.count = kBufferCount;
    request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    request.memory = V4L2_MEMORY_MMAP;
    if (xioctl(device_fd_, VIDIOC_REQBUFS, &request) != 0 || request.count == 0) {
        protocol_.error("webcam: REQBUFS failed on " + path);
        close_device();
        return false;
    }
    buffers_.resize(request.count);
    for (uint32_t i = 0; i < request.count; ++i) {
        v4l2_buffer buffer{};
        buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buffer.memory = V4L2_MEMORY_MMAP;
        buffer.index = i;
        if (xioctl(device_fd_, VIDIOC_QUERYBUF, &buffer) != 0) {
            close_device();
            return false;
        }
        buffers_[i].length = buffer.length;
        buffers_[i].start = mmap(nullptr, buffer.length, PROT_READ | PROT_WRITE,
                                 MAP_SHARED, device_fd_, buffer.m.offset);
        if (buffers_[i].start == MAP_FAILED) {
            buffers_[i].start = nullptr;
            close_device();
            return false;
        }
        if (xioctl(device_fd_, VIDIOC_QBUF, &buffer) != 0) {
            close_device();
            return false;
        }
    }

    v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (xioctl(device_fd_, VIDIOC_STREAMON, &type) != 0) {
        if (!open_failure_logged_) {
            open_failure_logged_ = true;
            protocol_.error("webcam: STREAMON failed on " + path + " (" + std::strerror(errno) +
                            ") — device busy?");
        }
        close_device();
        return false;
    }
    open_failure_logged_ = false;

    if (!jpeg_compressor_) jpeg_compressor_ = tjInitCompress();
    rgb_scratch_.resize(static_cast<size_t>(width_) * height_ * 3);
    const char fourcc[5] = {static_cast<char>(pixel_format_ & 0xff),
                            static_cast<char>((pixel_format_ >> 8) & 0xff),
                            static_cast<char>((pixel_format_ >> 16) & 0xff),
                            static_cast<char>((pixel_format_ >> 24) & 0xff), 0};
    protocol_.log("webcam: streaming " + path + " " + std::to_string(width_) + "x" +
                  std::to_string(height_) + " " + fourcc);
    return true;
}

void Webcam::close_device() {
    if (device_fd_ >= 0) {
        v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        xioctl(device_fd_, VIDIOC_STREAMOFF, &type);
    }
    for (Buffer& buffer : buffers_) {
        if (buffer.start) munmap(buffer.start, buffer.length);
    }
    buffers_.clear();
    if (device_fd_ >= 0) {
        close(device_fd_);
        device_fd_ = -1;
    }
}

void Webcam::publish_jpeg(const uint8_t* data, size_t size) {
    {
        std::lock_guard<std::mutex> guard(frame_mutex_);
        latest_jpeg_.assign(data, data + size);
        ++frame_seq_;
    }
    frame_cv_.notify_all();
}

bool Webcam::capture_frame() {
    fd_set fds;
    FD_ZERO(&fds);
    FD_SET(device_fd_, &fds);
    timeval timeout{kFrameWaitSec, 0};
    const int ready = select(device_fd_ + 1, &fds, nullptr, nullptr, &timeout);
    if (ready <= 0) return false;

    v4l2_buffer buffer{};
    buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    buffer.memory = V4L2_MEMORY_MMAP;
    if (xioctl(device_fd_, VIDIOC_DQBUF, &buffer) != 0) return false;

    if (buffer.bytesused > 0) {
        const uint8_t* raw = static_cast<const uint8_t*>(buffers_[buffer.index].start);
        if (pixel_format_ == V4L2_PIX_FMT_MJPEG) {
            publish_jpeg(raw, buffer.bytesused);
        } else {
            yuyv_to_rgb(raw, rgb_scratch_.data(), width_, height_);
            unsigned char* jpeg = nullptr;
            unsigned long jpeg_size = 0;
            if (tjCompress2(static_cast<tjhandle>(jpeg_compressor_), rgb_scratch_.data(),
                            static_cast<int>(width_), 0, static_cast<int>(height_),
                            TJPF_RGB, &jpeg, &jpeg_size, TJSAMP_420, kJpegQuality,
                            TJFLAG_FASTDCT) == 0) {
                publish_jpeg(jpeg, jpeg_size);
            }
            if (jpeg) tjFree(jpeg);
        }
    }

    return xioctl(device_fd_, VIDIOC_QBUF, &buffer) == 0;
}

void Webcam::capture_loop() {
    while (running_.load()) {
        if (!desired_.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        const std::string path = pick_device();
        if (path.empty() || !open_device(path)) {
            const auto retry_at = std::chrono::steady_clock::now() + kRetryDelay;
            while (running_.load() && desired_.load() &&
                   std::chrono::steady_clock::now() < retry_at) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            continue;
        }
        connected_.store(true);
        protocol_.emit({{"type", "status"}, {"camera", true}, {"camWanted", true}});
        int consecutive_failures = 0;
        while (running_.load() && desired_.load()) {
            if (capture_frame()) {
                consecutive_failures = 0;
            } else if (++consecutive_failures >= 3) {
                protocol_.error("webcam: capture stalled — reopening device");
                break;
            }
        }
        close_device();
        connected_.store(false);
        protocol_.emit({{"type", "status"}, {"camera", false}, {"camWanted", desired_.load()}});
        if (!desired_.load()) protocol_.log("webcam: camera released");
        if (running_.load() && desired_.load()) std::this_thread::sleep_for(kRetryDelay);
    }
    if (jpeg_compressor_) {
        tjDestroy(static_cast<tjhandle>(jpeg_compressor_));
        jpeg_compressor_ = nullptr;
    }
}

void Webcam::server_loop() {
    while (running_.load()) {
        const int client_fd = accept(server_fd_, nullptr, nullptr);
        if (client_fd < 0) {
            if (running_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(100));
            continue;
        }
        const int nodelay = 1;
        setsockopt(client_fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
        std::thread(&Webcam::client_loop, this, client_fd).detach();
    }
}

void Webcam::client_loop(int client_fd) {
    // Consume (and ignore) the request — every path gets the stream.
    char request[1024];
    recv(client_fd, request, sizeof(request), 0);

    const char* header =
        "HTTP/1.0 200 OK\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n"
        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n";
    if (!send_all(client_fd, header, std::strlen(header))) {
        close(client_fd);
        return;
    }

    uint64_t last_seq = 0;
    std::vector<uint8_t> frame;
    while (running_.load()) {
        {
            std::unique_lock<std::mutex> lock(frame_mutex_);
            frame_cv_.wait_for(lock, std::chrono::seconds(1),
                               [&] { return frame_seq_ != last_seq || !running_.load(); });
            if (frame_seq_ == last_seq) continue;  // timeout tick — re-check running_
            last_seq = frame_seq_;
            frame = latest_jpeg_;
        }
        const std::string part_header =
            "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
            std::to_string(frame.size()) + "\r\n\r\n";
        if (!send_all(client_fd, part_header.data(), part_header.size()) ||
            !send_all(client_fd, frame.data(), frame.size()) ||
            !send_all(client_fd, "\r\n", 2)) {
            break;
        }
    }
    close(client_fd);
}

}  // namespace g1
