// Newline-JSON protocol over stdio, shared by every sensor/control thread.
//
// The helper is spawned by the Deno backend (main.js) with its stdio piped. We
// emit one JSON object per line on stdout (telemetry) and read one JSON object
// per line on stdin (commands). Several threads emit concurrently, so all writes
// go through Protocol::emit, which holds a mutex and flushes each line atomically.
#pragma once

#include <mutex>
#include <string>

#include <nlohmann/json.hpp>

namespace g1 {

using json = nlohmann::json;

class Protocol {
public:
    // Serialize `event` and write it as one flushed line on stdout. Thread-safe.
    void emit(const json& event);

    // Convenience wrappers for the common event shapes.
    void log(const std::string& message, const std::string& level = "info");
    void error(const std::string& message);

private:
    std::mutex write_mutex_;
};

}  // namespace g1
