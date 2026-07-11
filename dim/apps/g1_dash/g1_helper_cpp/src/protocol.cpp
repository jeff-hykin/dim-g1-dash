#include "protocol.hpp"

#include <cstdio>
#include <iostream>

namespace g1 {

void Protocol::emit(const json& event) {
    const std::string line = event.dump();
    std::lock_guard<std::mutex> guard(write_mutex_);
    std::fwrite(line.data(), 1, line.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

void Protocol::log(const std::string& message, const std::string& level) {
    emit({{"type", "log"}, {"level", level}, {"msg", message}});
}

void Protocol::error(const std::string& message) {
    emit({{"type", "error"}, {"msg", message}});
}

}  // namespace g1
