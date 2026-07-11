cmake_minimum_required(VERSION 3.16)
project(g1_helper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Threads REQUIRED)
find_package(nlohmann_json REQUIRED)

# RealSense — nixpkgs installs a realsense2 CMake config.
find_package(realsense2 REQUIRED)

# turbojpeg — encode RealSense color frames to JPEG for the panel.
find_library(TURBOJPEG_LIB turbojpeg REQUIRED)
find_path(TURBOJPEG_INCLUDE_DIR turbojpeg.h REQUIRED)

# unitree_sdk2 — exports its own CMake package (found via CMAKE_PREFIX_PATH).
find_package(unitree_sdk2 REQUIRED)

# Livox-SDK2 — no exported CMake config; locate the static lib + headers under
# the SDK root passed in from the flake (-DLIVOX_SDK_ROOT=...).
find_library(LIVOX_LIB
  NAMES livox_lidar_sdk_static livox_lidar_sdk_shared
  HINTS "${LIVOX_SDK_ROOT}/lib" "${LIVOX_SDK_ROOT}/lib64" REQUIRED)
find_path(LIVOX_INCLUDE_DIR livox_lidar_api.h
  HINTS "${LIVOX_SDK_ROOT}/include" REQUIRED)

add_executable(g1_helper
  src/main.cpp
  src/protocol.cpp
  src/unitree_bridge.cpp
  src/mid360.cpp
  src/realsense.cpp
)

target_include_directories(g1_helper PRIVATE
  ${LIVOX_INCLUDE_DIR}
  ${TURBOJPEG_INCLUDE_DIR}
)

target_link_libraries(g1_helper PRIVATE
  Threads::Threads
  nlohmann_json::nlohmann_json
  realsense2::realsense2
  unitree_sdk2
  ${LIVOX_LIB}
  ${TURBOJPEG_LIB}
)

install(TARGETS g1_helper RUNTIME DESTINATION bin)
