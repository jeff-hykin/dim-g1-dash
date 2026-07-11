{
  description = "g1_helper — onboard C++ bridge for the Unitree G1: MID360 (Livox) + RealSense + unitree_sdk2, for dim-g1-dash";

  # The three robot SDKs aren't in nixpkgs, so we pull them as *source* flake
  # inputs (flake = false) and build each one ourselves below. Because they're
  # inputs, their exact commits are pinned in flake.lock — no manual sha256 to
  # keep in sync, and `nix run` reproduces the same build everywhere.
  inputs = {
    nixpkgs.url     = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    unitree-sdk2 = { url = "github:unitreerobotics/unitree_sdk2"; flake = false; };
    livox-sdk2   = { url = "github:Livox-SDK/Livox-SDK2";         flake = false; };
  };

  outputs = { self, nixpkgs, flake-utils, unitree-sdk2, livox-sdk2 }:
    # The G1 carries a Jetson (aarch64); a dev laptop is usually x86_64. Both are
    # Linux — there is no macOS path here (the SDKs are Linux-only).
    flake-utils.lib.eachSystem [ "aarch64-linux" "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib  = pkgs.lib;

        # ── Livox-SDK2 — MID360 lidar driver ────────────────────────────────
        # Plain CMake project. `make install` drops the headers (livox_lidar_api.h,
        # livox_lidar_def.h) and liblivox_lidar_sdk_{static,shared} into $out.
        livoxSdk = pkgs.stdenv.mkDerivation {
          pname   = "livox-sdk2";
          version = "unstable";
          src     = livox-sdk2;
          nativeBuildInputs = [ pkgs.cmake ];
          # The bundled samples aren't needed and drag in extra time; the tree
          # still installs the lib + headers without them.
          cmakeFlags = [ "-DCMAKE_BUILD_TYPE=Release" ];
          # Some tags gate samples behind a subdir with no toggle; if it ever
          # fails on samples, add `-DBUILD_SAMPLE=OFF` here.
        };

        # ── unitree_sdk2 — G1 DDS control + state (LocoClient, LowState) ─────
        # Ships headers, a static libunitree_sdk2, and prebuilt CycloneDDS libs
        # under thirdparty/. Its CMake `install` lays all of that out under $out
        # and exports an `unitree_sdk2` CMake package config we consume below.
        unitreeSdk = pkgs.stdenv.mkDerivation {
          pname   = "unitree_sdk2";
          version = "2.0";
          src     = unitree-sdk2;
          # Prebuilt .so files (CycloneDDS) carry no nix RPATH; autoPatchelf
          # rewrites their loader so the DDS transport resolves at runtime.
          nativeBuildInputs = [ pkgs.cmake pkgs.autoPatchelfHook ];
          buildInputs       = [ pkgs.eigen ];
          cmakeFlags = [ "-DCMAKE_BUILD_TYPE=Release" ];
          dontStrip = true;
        };

        g1_helper = pkgs.stdenv.mkDerivation {
          pname   = "g1_helper";
          version = "0.1.0";
          src     = ./.;

          nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config ];
          buildInputs = [
            pkgs.nlohmann_json      # JSON line protocol
            pkgs.librealsense       # RealSense depth/color camera
            pkgs.libjpeg_turbo      # turbojpeg — encode color frames for the panel
            unitreeSdk
            livoxSdk
          ];

          # Point the helper's CMake at the two hand-built SDKs.
          cmakeFlags = [
            "-DCMAKE_BUILD_TYPE=Release"
            "-DLIVOX_SDK_ROOT=${livoxSdk}"
            "-DCMAKE_PREFIX_PATH=${unitreeSdk}"
          ];

          meta.mainProgram = "g1_helper";
        };

      in {
        packages.default = g1_helper;
        packages.g1_helper = g1_helper;
        # Exposed individually so the two hand-built SDKs can be built / debugged
        # on their own without compiling the whole helper.
        packages.livox-sdk2 = livoxSdk;
        packages.unitree-sdk2 = unitreeSdk;

        apps.default = {
          type = "app";
          program = "${g1_helper}/bin/g1_helper";
        };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ g1_helper ];
          packages   = [ pkgs.clang-tools ];
          LIVOX_SDK_ROOT     = "${livoxSdk}";
          CMAKE_PREFIX_PATH  = "${unitreeSdk}";
        };
      }
    );
}
